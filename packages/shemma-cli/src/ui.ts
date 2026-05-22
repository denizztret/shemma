/**
 * UI / output formatter — единая точка форматирования CLI output (DRW-056/057/058).
 *
 * Goals:
 *   - friendly human-readable output по дефолту (✖/✔/→/·/⚠)
 *   - JSON output preserved за `--json` flag (для agent / CI integration)
 *   - ANSI colors gated на `isTTY`
 *   - zero deps: raw `\x1b[...]m` escapes, no chalk/kleur/picocolors
 *
 * Public API:
 *   - parseOutputMode(argv) → { mode, rest }   // pre-process argv в index.ts
 *   - initOutput(...)                          // configure singleton context
 *   - getOutput()                              // grab context everywhere
 *   - success / error / info / warn / banner   // friendly emitters
 *
 * В `--json` mode helpers выводят JSON.stringify({...}) на stdout, чтобы
 * existing agent / CI flow продолжали parse'ить структурированные responses.
 * Когда commands передают `data` payload — оно становится root объектом JSON;
 * иначе — печатается `{ ok, error, message, hint }` shape.
 */

export type OutputMode = "human" | "json";

export interface OutputContext {
  mode: OutputMode;
  /** true если stdout — TTY (для color/ANSI gating) */
  isTTY: boolean;
  /** true если stderr — TTY */
  isStderrTTY: boolean;
}

// ---------- ANSI ----------

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
} as const;

function wrap(code: string, s: string): string {
  return `${code}${s}${ANSI.reset}`;
}

// ---------- Singleton context ----------

let ctx: OutputContext = {
  mode: "human",
  isTTY: !!process.stdout.isTTY,
  isStderrTTY: !!process.stderr.isTTY,
};

export function initOutput(opts: Partial<OutputContext>): void {
  ctx = { ...ctx, ...opts };
}

export function getOutput(): OutputContext {
  return ctx;
}

// ---------- Argv pre-processing ----------

/**
 * Извлекает `--json` (global flag) из argv. Mirror pattern existing `--profile` strip
 * (см. `parseProfile` / `stripProfileFlag` в index.ts) — выполняется ОДИН раз
 * на старте, чтобы per-command парсеры не знали о флаге.
 */
export function parseOutputMode(argv: string[]): { mode: OutputMode; rest: string[] } {
  const rest: string[] = [];
  let mode: OutputMode = "human";
  for (const a of argv) {
    if (a === "--json") {
      mode = "json";
      continue;
    }
    rest.push(a);
  }
  return { mode, rest };
}

// ---------- Color helpers (ANSI only if TTY + human mode) ----------

function useColor(stderr = false): boolean {
  if (ctx.mode === "json") return false;
  return stderr ? ctx.isStderrTTY : ctx.isTTY;
}

export function dim(s: string, stderr = false): string {
  return useColor(stderr) ? wrap(ANSI.dim, s) : s;
}

export function bold(s: string, stderr = false): string {
  return useColor(stderr) ? wrap(ANSI.bold, s) : s;
}

export function color(code: keyof typeof ANSI, s: string, stderr = false): string {
  return useColor(stderr) ? wrap(ANSI[code], s) : s;
}

// ---------- Symbols ----------
// Unicode symbols всегда; ANSI цвет применяется только при TTY+human.

const SYM = {
  error: "✖", // ✖
  success: "✔", // ✔
  info: "·", // ·
  warn: "⚠", // ⚠
  action: "→", // →
} as const;

function sym(kind: keyof typeof SYM, stderr = false): string {
  const raw = SYM[kind];
  if (!useColor(stderr)) return raw;
  switch (kind) {
    case "error":
      return wrap(ANSI.red, raw);
    case "success":
      return wrap(ANSI.green, raw);
    case "warn":
      return wrap(ANSI.yellow, raw);
    case "action":
      return wrap(ANSI.cyan, raw);
    case "info":
      return wrap(ANSI.dim, raw);
  }
}

// ---------- JSON shape helpers ----------

function jsonOutSuccess(data: Record<string, unknown> | undefined, message?: string): void {
  if (data !== undefined) {
    process.stdout.write(JSON.stringify(data) + "\n");
  } else {
    process.stdout.write(JSON.stringify({ ok: true, ...(message ? { message } : {}) }) + "\n");
  }
}

function jsonOutError(
  error: string,
  data?: Record<string, unknown>,
  hint?: string,
): void {
  const payload: Record<string, unknown> = { ok: false, error };
  if (hint !== undefined) payload.hint = hint;
  if (data !== undefined) {
    for (const [k, v] of Object.entries(data)) {
      if (!(k in payload)) payload[k] = v;
    }
  }
  process.stderr.write(JSON.stringify(payload) + "\n");
}

// ---------- Friendly emitters ----------

/**
 * Print success message + optional `data` payload. В JSON mode `data` (если задан)
 * становится root объектом — для backward-compat existing callers, которые
 * парсят `JSON.parse(stdout)` напрямую.
 */
export function success(
  message: string,
  data?: Record<string, unknown>,
): void {
  if (ctx.mode === "json") {
    jsonOutSuccess(data, message);
    return;
  }
  process.stdout.write(`${sym("success")} ${message}\n`);
}

/**
 * Print info-line (lower-prominence than success). В JSON mode silenced —
 * info messages не нужны agent'ам, они декоративны.
 */
export function info(message: string): void {
  if (ctx.mode === "json") return;
  process.stdout.write(`${sym("info")} ${dim(message)}\n`);
}

/**
 * Print warning. В JSON mode → stderr JSON `{ ok: true, warning: ... }` (non-fatal).
 */
export function warn(message: string): void {
  if (ctx.mode === "json") {
    process.stderr.write(JSON.stringify({ ok: true, warning: message }) + "\n");
    return;
  }
  process.stderr.write(`${sym("warn", true)} ${message}\n`);
}

export interface ErrorOpts {
  /** Hint line: → <hint>. Can be array → multiple `→` lines. */
  hint?: string | string[];
  /** Extra context (e.g. paths, profile) printed as indented `<key>: <value>` lines. */
  data?: Record<string, unknown>;
  /** Structured error code for JSON mode (e.g. "daemon-conflict"). Defaults to message. */
  code?: string;
}

/**
 * Print error to stderr. В JSON mode выводит `{ ok: false, error, hint?, ...data }`.
 * Не делает exit — caller отвечает за process.exit(code).
 */
export function error(message: string, opts: ErrorOpts = {}): void {
  if (ctx.mode === "json") {
    jsonOutError(
      opts.code ?? message,
      opts.data,
      Array.isArray(opts.hint) ? opts.hint.join("; ") : opts.hint,
    );
    return;
  }
  process.stderr.write(`${sym("error", true)} ${message}\n`);
  if (opts.data !== undefined) {
    for (const [k, v] of Object.entries(opts.data)) {
      process.stderr.write(`  ${dim(`${k}:`, true)} ${String(v)}\n`);
    }
  }
  const hints = Array.isArray(opts.hint) ? opts.hint : opts.hint ? [opts.hint] : [];
  for (const h of hints) {
    process.stderr.write(`  ${sym("action", true)} ${h}\n`);
  }
}

// ---------- Banner ----------

export type BannerLine =
  /** Headline like `shemma v0.11.0 [dev] listening on http://localhost:8788`. */
  | { kind: "headline"; text: string }
  /** Key/value `<key>: <value>` line. Key dim, value plain. */
  | { kind: "kv"; key: string; value: string }
  /** Action line with `→ <text>`. */
  | { kind: "action"; text: string }
  /** Update line with `↑ <text>` (yellow if color). */
  | { kind: "update"; text: string }
  /** Info `· <text>` (dim). */
  | { kind: "info"; text: string };

/**
 * Multi-line banner. Suppressed в JSON mode полностью.
 * Goes to stdout (not stderr) — matches madstudio pattern + makes
 * the URL printable line greppable when piped.
 */
export function banner(lines: BannerLine[]): void {
  if (ctx.mode === "json") return;
  const out: string[] = [];
  for (const ln of lines) {
    switch (ln.kind) {
      case "headline":
        out.push(bold(ln.text));
        break;
      case "kv":
        out.push(`${dim(ln.key.padEnd(8))} ${ln.value}`);
        break;
      case "action":
        out.push(`${sym("action")} ${ln.text}`);
        break;
      case "update":
        out.push(color("yellow", `↑ ${ln.text}`));
        break;
      case "info":
        out.push(`${sym("info")} ${dim(ln.text)}`);
        break;
    }
  }
  process.stdout.write(out.join("\n") + "\n");
}

// ---------- Raw JSON passthrough ----------

// DRW-125: hints for well-known backend error codes. Keeps friendly mode
// actionable when middleware short-circuits with `{ error: "..." }` envelopes
// (apps/backend/src/middleware/space.ts) — agents and humans get a one-line
// pointer to the fix instead of a bare error string.
function hintsForErrorCode(code: string): string[] {
  switch (code) {
    case "invalid_space_id":
    case "space_not_found":
      return [
        "run `shemma s list` to see registered spaces",
        "pass `--space <id>` or cd into a registered space path",
      ];
    case "space_required":
      return [
        "no `default` space is registered — pass `--space <id>` or cd into a registered space path",
      ];
    default:
      return [];
  }
}

// DRW-125: backend uses two error envelope shapes —
//   1. `{ ok: false, error: "..." }` from domain validation
//   2. `{ error: "..." }` from middleware short-circuits (no `ok` at all)
// Treat both as errors. Guard against false-positives on a legitimate
// `ok: true` response that happens to nest the word "error" in a sub-field.
function isErrorEnvelope(res: unknown): { error: string } | null {
  if (res === null || typeof res !== "object") return null;
  const r = res as { ok?: unknown; error?: unknown };
  const errStr = typeof r.error === "string" ? r.error : undefined;
  if (r.ok === false) return { error: errStr ?? "operation failed" };
  if (r.ok !== true && errStr !== undefined) return { error: errStr };
  return null;
}

/**
 * Print raw JSON response from backend. В human mode — формат `success`/`error`
 * по error envelope (см. `isErrorEnvelope`). В JSON mode — `JSON.stringify(res)`
 * as-is (byte-identical с pre-Group-A behaviour).
 *
 * Used by commands that proxy a backend response (rooms ops, domain, ai etc).
 */
export function printResponse(res: unknown, opts: { humanSuccess?: string } = {}): void {
  if (ctx.mode === "json") {
    process.stdout.write(JSON.stringify(res) + "\n");
    return;
  }
  const errEnvelope = isErrorEnvelope(res);
  if (errEnvelope) {
    const hints = hintsForErrorCode(errEnvelope.error);
    error(errEnvelope.error, {
      code: errEnvelope.error,
      ...(hints.length ? { hint: hints } : {}),
    });
    return;
  }
  if (opts.humanSuccess) {
    success(opts.humanSuccess);
  } else {
    success("ok");
  }
}

// DRW-125: callers (domain commands) need the same envelope check to set
// process exit code symmetrically across JSON and human modes.
export function responseHasError(res: unknown): boolean {
  return isErrorEnvelope(res) !== null;
}
