import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeedbackWriter } from "../src/feedback/writer";
import { makeApp } from "../src/index";

const DEFINE_BODY = JSON.stringify({
  actions: [{ kind: "define", name: "n", role: "service", label: "hi" }],
});

function post(
  app: ReturnType<typeof makeApp>["app"],
  path: string,
  body: unknown,
) {
  return app.fetch(
    new Request(`http://x${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function readRecords(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}

describe("POST /api/agent/feedback annotations (DRW-227.02)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "shemma-fb-ann-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends an annotation alongside backbone records in the same file", async () => {
    const writer = new FeedbackWriter({ baseDir: join(dir, "on") });
    const { app, legacyBundle } = makeApp({ inMemory: true, feedback: writer });

    // backbone request + an annotation referencing it
    await post(app, "/api/domain?room=ann-room", JSON.parse(DEFINE_BODY));
    const res = await post(app, "/api/agent/feedback?room=ann-room", {
      text: "delete didn't work, I think it ignores v2",
      phase: "blocker",
      clientOpId: "op-9",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, recorded: true });

    const recs = readRecords(
      writer.filePath(legacyBundle.space.id, "ann-room"),
    );
    const kinds = recs.map((r) => r.kind);
    expect(kinds).toContain("request");
    expect(kinds).toContain("annotation");
    const ann = recs.find((r) => r.kind === "annotation");
    expect(ann).toMatchObject({
      kind: "annotation",
      room: "ann-room",
      phase: "blocker",
      clientOpId: "op-9",
      text: "delete didn't work, I think it ignores v2",
    });
  });

  it("no-ops with recorded:false when feedback is off (no writer)", async () => {
    const offDir = join(dir, "off");
    const { app } = makeApp({ inMemory: true }); // no feedback

    const res = await post(app, "/api/agent/feedback?room=off-room", {
      text: "anything",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, recorded: false });
    expect(existsSync(offDir)).toBe(false);
  });

  it("rejects an empty/missing text with 400", async () => {
    const writer = new FeedbackWriter({ baseDir: join(dir, "bad") });
    const { app } = makeApp({ inMemory: true, feedback: writer });

    const res = await post(app, "/api/agent/feedback?room=r", { text: "   " });
    expect(res.status).toBe(400);
  });
});
