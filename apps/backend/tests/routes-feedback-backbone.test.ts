import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeedbackWriter } from "../src/feedback/writer";
import { makeApp } from "../src/index";

const DEFINE_BODY = JSON.stringify({
  actions: [{ kind: "define", name: "fb-node", role: "service", label: "hi" }],
});

function readRecords(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}

describe("feedback backbone middleware (DRW-227.01)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "shemma-fb-int-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("logs a `request` record for /api/domain when a writer is provided", async () => {
    const writer = new FeedbackWriter({ baseDir: join(dir, "on") });
    const { app, legacyBundle } = makeApp({ inMemory: true, feedback: writer });

    const res = await app.fetch(
      new Request("http://x/api/domain?room=fb-room", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: DEFINE_BODY,
      }),
    );
    expect(res.status).toBe(200);

    const p = writer.filePath(legacyBundle.space.id, "fb-room");
    expect(existsSync(p)).toBe(true);
    const rec = readRecords(p).find((r) => r.route === "/api/domain");
    expect(rec).toMatchObject({
      kind: "request",
      route: "/api/domain",
      method: "POST",
      room: "fb-room",
      httpStatus: 200,
      ok: true,
      errorCode: null,
    });
    expect(
      (rec?.payload as { actions: Array<{ kind: string }> }).actions[0].kind,
    ).toBe("define");
    expect(typeof rec?.ts).toBe("string");
    expect(typeof rec?.durationMs).toBe("number");
  });

  it("does NOT log excluded routes (e.g. GET /api/state)", async () => {
    const writer = new FeedbackWriter({ baseDir: join(dir, "excluded") });
    const { app, legacyBundle } = makeApp({ inMemory: true, feedback: writer });

    await app.fetch(
      new Request("http://x/api/domain?room=ex-room", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: DEFINE_BODY,
      }),
    );
    await app.fetch(new Request("http://x/api/state?room=ex-room"));

    const recs = readRecords(writer.filePath(legacyBundle.space.id, "ex-room"));
    // Only the domain mutation is logged — the /api/state read is excluded.
    expect(recs).toHaveLength(1);
    expect(recs[0]?.route).toBe("/api/domain");
  });

  it("writes nothing when no feedback writer is provided (off by default)", async () => {
    const offDir = join(dir, "off");
    const { app } = makeApp({ inMemory: true }); // no feedback

    const res = await app.fetch(
      new Request("http://x/api/domain?room=off-room", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: DEFINE_BODY,
      }),
    );
    expect(res.status).toBe(200);
    // The middleware was never installed → the feedback dir is never created.
    expect(existsSync(offDir)).toBe(false);
  });
});
