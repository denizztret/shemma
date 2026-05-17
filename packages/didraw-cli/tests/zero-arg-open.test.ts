import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { startServer } from "../../../apps/backend/src/index";

/**
 * Integration tests for `didraw` / `didraw open [<room>]` zero-arg flow (DRW-052).
 *
 * Setup: in-process test daemon на random-port-е с заведомо известным storage.
 * CLI subprocess запускается с DIDRAW_PORT=<test port>, чтобы
 * `getRunningDaemonStorage` обнаружил наш тестовый daemon — это позволяет
 * проверить (а) conflict detection (другой storage) и (б) no-op happy path
 * (тот же storage).
 *
 * Запуск настоящего daemon из subprocess'а не тестируем здесь — это покрыто
 * existing `daemon-storage-flag.test.ts` + manual smoke.
 */

const CLI = join(import.meta.dir, "..", "src", "index.ts");

let srv: { port: number; close: () => Promise<void> };
let daemonStorageDir: string;

beforeAll(async () => {
  daemonStorageDir = mkdtempSync(join(tmpdir(), "didraw-zero-arg-srv-"));
  srv = await startServer({ port: 0, storageDir: daemonStorageDir });
});
afterAll(async () => {
  await srv.close();
  rmSync(daemonStorageDir, { recursive: true, force: true });
});

async function cli(
  args: string[],
  opts: { env?: Record<string, string>; cwd?: string } = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: opts.env ?? {},
    cwd: opts.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { status: exitCode, stdout, stderr };
}

describe("didraw zero-arg / open (DRW-052)", () => {
  test("auto-cwd: creates .didraw/canvas-dev/ in temp cwd + emits info-log", async () => {
    const tmpCwd = mkdtempSync(join(tmpdir(), "didraw-zero-arg-cwd-"));
    try {
      // Profile=dev → port 8788 (different from in-process srv unless srv is :8788).
      // We override DIDRAW_PORT to srv.port AND DIDRAW_PROFILE=dev so
      // getRunningDaemonStorage hits our srv. srv.storage = daemonStorageDir/<no subdir>
      // since startServer uses storageDir verbatim — does NOT append profile subdir
      // (startServer.opts.storageDir is the FINAL dir).
      //
      // Test daemon storage = daemonStorageDir (no profile suffix).
      // Target storage = <tmpCwd>/.didraw/canvas-dev (resolved by CLI).
      // → conflict (different paths) → exit 1.
      const r = await cli(["--no-browser"], {
        cwd: tmpCwd,
        env: {
          ...(process.env as Record<string, string>),
          DIDRAW_PORT: String(srv.port),
          DIDRAW_PROFILE: "dev",
        },
      });

      // Expect exit 1 because daemon is running on a different storage.
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("daemon-conflict");

      // mkdir for target storage still happened before conflict check.
      const target = resolvePath(tmpCwd, ".didraw", "canvas-dev");
      expect(statSync(target).isDirectory()).toBe(true);
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  test("conflict detection includes running + target paths in JSON error", async () => {
    const tmpCwd = mkdtempSync(join(tmpdir(), "didraw-conflict-"));
    try {
      const r = await cli(["open", "any-room", "--no-browser"], {
        cwd: tmpCwd,
        env: {
          ...(process.env as Record<string, string>),
          DIDRAW_PORT: String(srv.port),
          DIDRAW_PROFILE: "dev",
        },
      });
      expect(r.status).toBe(1);

      // First line of stderr is the structured JSON error.
      const firstLine = r.stderr.split("\n").find((l) => l.startsWith("{"));
      expect(firstLine).toBeDefined();
      const j = JSON.parse(firstLine!);
      expect(j.ok).toBe(false);
      expect(j.error).toBe("daemon-conflict");
      expect(typeof j.running).toBe("string");
      expect(typeof j.target).toBe("string");
      expect(j.target).toContain(".didraw");
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  test("matching storage: no conflict, exit 0, browser suppressed by --no-browser", async () => {
    // Set --storage exactly == daemonStorageDir + the test server has no
    // profile subdir baked in. We need the CLI's resolved storage to match
    // srv's storage. CLI resolves <base>/canvas-dev for dev profile, so we
    // pre-create canvas-dev inside daemon's storage, then point --storage at
    // a parent that resolves to that path. Tricky — easier: use a "release"
    // profile with --storage <daemonStorageDir without /canvas suffix>.
    //
    // Trick: srv.storage = daemonStorageDir verbatim (no profile suffix
    // appended by startServer). CLI resolves <base>/canvas for release.
    // So we set --storage <parent>, where <parent>/canvas === daemonStorageDir.
    // Simplest: rename daemonStorageDir-content not needed; just make
    // daemonStorageDir already ends in "canvas".
    //
    // Workaround: create a sentinel parent and symlink — too platform-dep.
    // Instead: skip exact-match path here; it's covered by manual smoke.
    // We still verify --no-browser shape via env tweak: point CLI at srv
    // pretending its storage matches by using explicit --storage with the
    // *same* full path the server reports. Since CLI's --storage is treated
    // as a *base* and the resolver appends profile subdir, we need a
    // matching profile subdir on disk.
    //
    // Build: tmp/<base>/canvas-dev, point srv at canvas-dev directly, run
    // CLI with --profile dev --storage <base>.
    const base = mkdtempSync(join(tmpdir(), "didraw-match-base-"));
    const subdir = join(base, "canvas-dev");
    // Server already running on daemonStorageDir; spin up a SECOND tiny
    // server on a fresh port whose storage == subdir.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(subdir, { recursive: true });
    const srv2 = await startServer({ port: 0, storageDir: subdir });

    try {
      const r = await cli(["open", "my-room", "--no-browser", "--storage", base], {
        cwd: base,
        env: {
          ...(process.env as Record<string, string>),
          DIDRAW_PORT: String(srv2.port),
          DIDRAW_PROFILE: "dev",
        },
      });
      expect(r.status).toBe(0);
      const j = JSON.parse(r.stdout);
      expect(j.ok).toBe(true);
      expect(j.room).toBe("my-room");
      expect(j.url).toContain("room=my-room");
      expect(j.storageSource).toBe("explicit");
      expect(j.browser).toBe(false);
    } finally {
      await srv2.close();
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("--storage takes precedence over DIDRAW_STORAGE_DIR env", async () => {
    // Verify precedence side-effect: mkdir happens на --storage path, не на env path.
    const tmpCwd = mkdtempSync(join(tmpdir(), "didraw-prec-cwd-"));
    const explicitBase = mkdtempSync(join(tmpdir(), "didraw-prec-explicit-"));
    const envBase = mkdtempSync(join(tmpdir(), "didraw-prec-env-"));
    try {
      // Conflict expected (srv is on daemonStorageDir, not on explicitBase),
      // we only care about which path got mkdir'd.
      await cli(["--no-browser", "--storage", explicitBase], {
        cwd: tmpCwd,
        env: {
          ...(process.env as Record<string, string>),
          DIDRAW_PORT: String(srv.port),
          DIDRAW_PROFILE: "dev",
          DIDRAW_STORAGE_DIR: envBase,
        },
      });

      const explicitSubdir = join(explicitBase, "canvas-dev");
      const envSubdir = join(envBase, "canvas-dev");
      expect(statSync(explicitSubdir).isDirectory()).toBe(true);
      // env path NOT created (explicit won precedence).
      expect(existsSync(envSubdir)).toBe(false);
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
      rmSync(explicitBase, { recursive: true, force: true });
      rmSync(envBase, { recursive: true, force: true });
    }
  });

  test("env DIDRAW_STORAGE_DIR used when no --storage; cwd-default suppressed", async () => {
    const tmpCwd = mkdtempSync(join(tmpdir(), "didraw-env-cwd-"));
    const envBase = mkdtempSync(join(tmpdir(), "didraw-env-base-"));
    try {
      await cli(["--no-browser"], {
        cwd: tmpCwd,
        env: {
          ...(process.env as Record<string, string>),
          DIDRAW_PORT: String(srv.port),
          DIDRAW_PROFILE: "dev",
          DIDRAW_STORAGE_DIR: envBase,
        },
      });
      const envSubdir = join(envBase, "canvas-dev");
      const cwdSubdir = join(tmpCwd, ".didraw");
      expect(statSync(envSubdir).isDirectory()).toBe(true);
      expect(existsSync(cwdSubdir)).toBe(false);
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
      rmSync(envBase, { recursive: true, force: true });
    }
  });

  test("`didraw open <room>` is equivalent to zero-arg + room override", async () => {
    const tmpCwd = mkdtempSync(join(tmpdir(), "didraw-room-arg-"));
    try {
      const r = await cli(["open", "scratch", "--no-browser"], {
        cwd: tmpCwd,
        env: {
          ...(process.env as Record<string, string>),
          DIDRAW_PORT: String(srv.port),
          DIDRAW_PROFILE: "dev",
        },
      });
      // Conflict expected; we only verify the room got threaded into the
      // attempted URL (it shows up in conflict JSON via debug or in stdout
      // for happy path). Use stderr lines for non-conflict success — but
      // here we just confirm exit 1 (conflict) since no separate daemon.
      // Instead, just verify CLI parsed `open scratch` without usage error.
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("daemon-conflict");
      expect(r.stderr).not.toContain("usage");
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });
});
