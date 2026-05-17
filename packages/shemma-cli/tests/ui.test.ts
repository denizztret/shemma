import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  banner,
  bold,
  color,
  dim,
  error,
  getOutput,
  info,
  initOutput,
  parseOutputMode,
  printResponse,
  success,
  warn,
} from "../src/ui";

// Capture stdout/stderr writes for assertions.
// We monkey-patch process.stdout.write / process.stderr.write per-test.
type Capture = { stdout: string[]; stderr: string[] };

function patchStreams(): { restore: () => void; cap: Capture } {
  const cap: Capture = { stdout: [], stderr: [] };
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  // biome-ignore lint/suspicious/noExplicitAny: monkey-patch
  (process.stdout.write as any) = (chunk: string): boolean => {
    cap.stdout.push(String(chunk));
    return true;
  };
  // biome-ignore lint/suspicious/noExplicitAny: monkey-patch
  (process.stderr.write as any) = (chunk: string): boolean => {
    cap.stderr.push(String(chunk));
    return true;
  };
  return {
    cap,
    restore: () => {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process.stdout.write as any) = origOut;
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process.stderr.write as any) = origErr;
    },
  };
}

describe("parseOutputMode", () => {
  test("default = human, --json strips flag and returns json", () => {
    const r = parseOutputMode(["foo", "--json", "bar"]);
    expect(r.mode).toBe("json");
    expect(r.rest).toEqual(["foo", "bar"]);
  });

  test("no --json → human, rest unchanged", () => {
    const r = parseOutputMode(["foo", "--bar"]);
    expect(r.mode).toBe("human");
    expect(r.rest).toEqual(["foo", "--bar"]);
  });

  test("--json anywhere works", () => {
    expect(parseOutputMode(["--json"]).mode).toBe("json");
    expect(parseOutputMode(["a", "b", "--json"]).mode).toBe("json");
  });
});

describe("ui formatters — JSON mode", () => {
  let p: ReturnType<typeof patchStreams>;
  beforeEach(() => {
    p = patchStreams();
    initOutput({ mode: "json", isTTY: false, isStderrTTY: false });
  });
  afterEach(() => p.restore());

  test("success() emits JSON to stdout", () => {
    success("done", { ok: true, id: 42 });
    const line = p.cap.stdout.join("");
    expect(line.trim()).toBe(JSON.stringify({ ok: true, id: 42 }));
  });

  test("success() without data emits {ok:true,message}", () => {
    success("done");
    expect(JSON.parse(p.cap.stdout.join(""))).toEqual({
      ok: true,
      message: "done",
    });
  });

  test("error() emits {ok:false,error,hint?} to stderr", () => {
    error("boom", { hint: "try this", code: "kaboom" });
    const line = p.cap.stderr.join("");
    expect(JSON.parse(line)).toEqual({
      ok: false,
      error: "kaboom",
      hint: "try this",
    });
  });

  test("error() with data merges fields", () => {
    error("conflict", {
      code: "daemon-conflict",
      data: { running: "/a", target: "/b" },
    });
    expect(JSON.parse(p.cap.stderr.join(""))).toEqual({
      ok: false,
      error: "daemon-conflict",
      running: "/a",
      target: "/b",
    });
  });

  test("info() is silenced in JSON mode", () => {
    info("hi");
    expect(p.cap.stdout.join("")).toBe("");
    expect(p.cap.stderr.join("")).toBe("");
  });

  test("banner() is silenced in JSON mode", () => {
    banner([{ kind: "headline", text: "shemma v1" }]);
    expect(p.cap.stdout.join("")).toBe("");
  });

  test("printResponse() emits raw JSON to stdout (byte-compat with pre-Group-A)", () => {
    printResponse({ ok: true, foo: "bar" });
    expect(JSON.parse(p.cap.stdout.join(""))).toEqual({ ok: true, foo: "bar" });
  });

  test("no ANSI escapes in JSON mode even if isTTY=true", () => {
    initOutput({ mode: "json", isTTY: true, isStderrTTY: true });
    success("hi");
    expect(p.cap.stdout.join("")).not.toContain("\x1b[");
  });
});

describe("ui formatters — human mode, non-TTY", () => {
  let p: ReturnType<typeof patchStreams>;
  beforeEach(() => {
    p = patchStreams();
    initOutput({ mode: "human", isTTY: false, isStderrTTY: false });
  });
  afterEach(() => p.restore());

  test("success() emits ✔ + message, no color", () => {
    success("daemon started");
    const out = p.cap.stdout.join("");
    expect(out).toContain("✔");
    expect(out).toContain("daemon started");
    expect(out).not.toContain("\x1b["); // no ANSI
  });

  test("error() emits ✖ + message to stderr, no color", () => {
    error("oops", { hint: "fix it" });
    const err = p.cap.stderr.join("");
    expect(err).toContain("✖");
    expect(err).toContain("oops");
    expect(err).toContain("→");
    expect(err).toContain("fix it");
    expect(err).not.toContain("\x1b[");
  });

  test("error() with multiple hints emits multiple → lines", () => {
    error("bad", { hint: ["a", "b", "c"] });
    const err = p.cap.stderr.join("");
    const arrowCount = (err.match(/→/g) ?? []).length;
    expect(arrowCount).toBe(3);
  });

  test("info() emits · + message", () => {
    info("using cwd storage");
    expect(p.cap.stdout.join("")).toContain("·");
    expect(p.cap.stdout.join("")).toContain("using cwd storage");
  });

  test("warn() emits ⚠ to stderr", () => {
    warn("deprecation");
    expect(p.cap.stderr.join("")).toContain("⚠");
    expect(p.cap.stderr.join("")).toContain("deprecation");
  });

  test("banner() prints multi-line block", () => {
    banner([
      { kind: "headline", text: "shemma v1 [dev]" },
      { kind: "kv", key: "storage:", value: "/path" },
      { kind: "action", text: "opening URL" },
    ]);
    const out = p.cap.stdout.join("");
    expect(out).toContain("shemma v1 [dev]");
    expect(out).toContain("storage:");
    expect(out).toContain("/path");
    expect(out).toContain("→");
    expect(out).not.toContain("\x1b[");
  });

  test("color helpers return plain text when non-TTY", () => {
    expect(dim("x")).toBe("x");
    expect(bold("x")).toBe("x");
    expect(color("red", "x")).toBe("x");
  });
});

describe("ui formatters — human mode, TTY (colors on)", () => {
  let p: ReturnType<typeof patchStreams>;
  beforeEach(() => {
    p = patchStreams();
    initOutput({ mode: "human", isTTY: true, isStderrTTY: true });
  });
  afterEach(() => p.restore());

  test("ANSI escapes appear in success symbol", () => {
    success("ok");
    expect(p.cap.stdout.join("")).toContain("\x1b[32m"); // green
    expect(p.cap.stdout.join("")).toContain("\x1b[0m"); // reset
  });

  test("error symbol gets red", () => {
    error("boom");
    expect(p.cap.stderr.join("")).toContain("\x1b[31m"); // red
  });

  test("color helpers add ANSI when TTY", () => {
    expect(bold("x")).toContain("\x1b[1m");
    expect(dim("x")).toContain("\x1b[2m");
    expect(color("yellow", "x")).toContain("\x1b[33m");
  });
});

describe("getOutput()", () => {
  test("returns current context after initOutput()", () => {
    initOutput({ mode: "json", isTTY: false, isStderrTTY: false });
    expect(getOutput().mode).toBe("json");
    initOutput({ mode: "human", isTTY: true, isStderrTTY: false });
    expect(getOutput()).toMatchObject({ mode: "human", isTTY: true });
  });
});
