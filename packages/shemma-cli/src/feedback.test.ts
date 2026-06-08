import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdFeedback, resolveFeedbackFile } from "./feedback";
import { initOutput } from "./ui";

const REQ = JSON.stringify({
  ts: "2026-06-08T10:00:00.000Z",
  kind: "request",
  route: "/api/domain",
  method: "POST",
  clientOpId: "op-1",
  ok: true,
  errorCode: null,
});
const ANN = JSON.stringify({
  ts: "2026-06-08T10:00:05.000Z",
  kind: "annotation",
  clientOpId: "op-1",
  phase: "blocker",
  text: "define упал — думал, нужен только name",
});

describe("shemma feedback --diff (DRW-227.03)", () => {
  let dir: string;
  let logs: string[];
  let realLog: typeof console.log;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shemma-fbcli-"));
    writeFileSync(join(dir, "di-draw__themecheck.jsonl"), `${REQ}\n${ANN}\n`);
    logs = [];
    realLog = console.log;
    console.log = (...a: unknown[]) => {
      logs.push(a.join(" "));
    };
    initOutput({ mode: "human" });
  });
  afterEach(() => {
    console.log = realLog;
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolveFeedbackFile finds the unique file for a room without --space", () => {
    const r = resolveFeedbackFile(dir, "themecheck");
    expect("path" in r && r.path.endsWith("di-draw__themecheck.jsonl")).toBe(
      true,
    );
  });

  it("prints the claimed-vs-actual pair + misdiagnosis marker", async () => {
    await cmdFeedback(["--diff", "themecheck"], undefined, {
      feedbackDir: dir,
    });
    const out = logs.join("\n");
    expect(out).toContain("define упал");
    expect(out).toContain("/api/domain");
    expect(out.toLowerCase()).toContain("misdiagnosis");
  });

  it("json mode emits structured entries", async () => {
    initOutput({ mode: "json" });
    await cmdFeedback(["--diff", "themecheck"], undefined, {
      feedbackDir: dir,
    });
    const parsed = JSON.parse(logs.join("\n")) as {
      ok: boolean;
      room: string;
      entries: unknown[];
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.room).toBe("themecheck");
    expect(parsed.entries).toHaveLength(1);
  });

  it("friendly message when no feedback log exists for the room", async () => {
    await cmdFeedback(["--diff", "ghost-room"], undefined, {
      feedbackDir: dir,
    });
    expect(logs.join("\n").toLowerCase()).toContain("no feedback log");
  });
});
