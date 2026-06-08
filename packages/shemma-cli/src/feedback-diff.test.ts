import { describe, expect, it } from "bun:test";
import { computeDiff, formatDiff, parseFeedbackLines } from "./feedback-diff";

const REQ = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    ts: "2026-06-08T10:00:00.000Z",
    kind: "request",
    route: "/api/domain",
    method: "POST",
    clientOpId: "op-1",
    ok: false,
    errorCode: "unknown-role",
    ...over,
  });

const ANN = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    ts: "2026-06-08T10:00:05.000Z",
    kind: "annotation",
    clientOpId: "op-1",
    phase: "blocker",
    text: "define упал — думал, нужен только name",
    ...over,
  });

describe("parseFeedbackLines", () => {
  it("parses JSONL and skips blank + malformed lines", () => {
    const text = [REQ(), "", "not-json{", ANN()].join("\n");
    const recs = parseFeedbackLines(text);
    expect(recs).toHaveLength(2);
    expect(recs[0]?.kind).toBe("request");
    expect(recs[1]?.kind).toBe("annotation");
  });
});

describe("computeDiff", () => {
  it("joins an annotation to its request by clientOpId", () => {
    const recs = parseFeedbackLines([REQ(), ANN()].join("\n"));
    const diff = computeDiff(recs);
    expect(diff).toHaveLength(1);
    expect(diff[0]?.joinedBy).toBe("clientOpId");
    expect(diff[0]?.request?.errorCode).toBe("unknown-role");
  });

  it("falls back to the nearest preceding request by timeline when no clientOpId match", () => {
    const recs = parseFeedbackLines(
      [
        REQ({ clientOpId: null, ts: "2026-06-08T10:00:00.000Z" }),
        ANN({ clientOpId: null, ts: "2026-06-08T10:00:05.000Z" }),
      ].join("\n"),
    );
    const diff = computeDiff(recs);
    expect(diff[0]?.joinedBy).toBe("timeline");
    expect(diff[0]?.request).not.toBeNull();
  });

  it("reports joinedBy:none when there is no candidate request", () => {
    const recs = parseFeedbackLines(ANN({ clientOpId: null }));
    const diff = computeDiff(recs);
    expect(diff[0]?.joinedBy).toBe("none");
    expect(diff[0]?.request).toBeNull();
  });

  it("flags suspected misdiagnosis: a blocker note whose request actually succeeded", () => {
    const recs = parseFeedbackLines(
      [REQ({ ok: true, errorCode: null }), ANN({ phase: "blocker" })].join(
        "\n",
      ),
    );
    expect(computeDiff(recs)[0]?.suspectedMisdiagnosis).toBe(true);
  });

  it("does not flag a blocker whose request genuinely failed", () => {
    const recs = parseFeedbackLines([REQ({ ok: false }), ANN()].join("\n"));
    expect(computeDiff(recs)[0]?.suspectedMisdiagnosis).toBe(false);
  });

  it("ignores annotations' non-blocker phases for the misdiagnosis flag", () => {
    const recs = parseFeedbackLines(
      [REQ({ ok: true }), ANN({ phase: "intent" })].join("\n"),
    );
    expect(computeDiff(recs)[0]?.suspectedMisdiagnosis).toBe(false);
  });
});

describe("formatDiff", () => {
  it("renders the claim, the actual outcome, and a misdiagnosis marker", () => {
    const recs = parseFeedbackLines(
      [REQ({ ok: true, errorCode: null }), ANN()].join("\n"),
    );
    const out = formatDiff(computeDiff(recs));
    expect(out).toContain("define упал");
    expect(out).toContain("/api/domain");
    expect(out.toLowerCase()).toContain("misdiagnosis");
  });

  it("renders a friendly line when there are no annotations", () => {
    expect(formatDiff([])).toContain("no annotations");
  });
});
