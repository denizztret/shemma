import { describe, expect, it } from "bun:test";
import { makeApp } from "../../src/index";
import type { TLRecord } from "../../src/store-types";

const SPACE = "default";
const ROOM = "style-apply-test";

function emptySnapshot() {
  return {
    schema: { schemaVersion: 1, storeVersion: 4, recordVersions: {} },
    store: {
      "document:document": { id: "document:document", typeName: "document" } as TLRecord,
      "page:page": { id: "page:page", typeName: "page" } as TLRecord,
    } as Record<string, TLRecord>,
  };
}

function makeGeo(
  id: string,
  opts: {
    dash?: string;
    font?: string;
    size?: string;
    parentId?: string;
    meta?: Record<string, unknown>;
  } = {},
): TLRecord {
  return {
    id,
    typeName: "shape",
    type: "geo",
    x: 0,
    y: 0,
    parentId: opts.parentId ?? "page:page",
    props: {
      geo: "rectangle",
      color: "black",
      dash: opts.dash ?? "draw",
      size: opts.size ?? "m",
      font: opts.font ?? "draw",
      w: 120,
      h: 60,
    },
    meta: opts.meta ?? {},
  } as TLRecord;
}

function makeFrame(id: string, opts: { parentId?: string; meta?: Record<string, unknown> } = {}): TLRecord {
  return {
    id,
    typeName: "shape",
    type: "frame",
    x: 0,
    y: 0,
    parentId: opts.parentId ?? "page:page",
    props: { w: 800, h: 600, name: id, color: "black" },
    meta: opts.meta ?? {},
  } as TLRecord;
}

async function postStyleApply(
  app: ReturnType<typeof makeApp>["app"],
  body: unknown,
  room = ROOM,
) {
  return app.fetch(
    new Request(`http://x/api/agent/style-apply?space=${SPACE}&room=${room}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/agent/style-apply", () => {
  it("updates props.dash on geo shape", async () => {
    const { app, legacyBundle } = makeApp({ inMemory: true });
    const r = await legacyBundle.rooms.get(ROOM);
    const snap = emptySnapshot();
    snap.store["shape:g1"] = makeGeo("shape:g1", { dash: "draw" });
    r.store = snap;

    const res = await postStyleApply(app, {
      selectedIds: ["shape:g1"],
      styles: { dash: "solid" },
    });
    expect(res.status).toBe(200);

    const room = await legacyBundle.rooms.get(ROOM);
    expect((room.store.store["shape:g1"] as any).props.dash).toBe("solid");
  });

  it("dashed shape preserves dash, applies font", async () => {
    const { app, legacyBundle } = makeApp({ inMemory: true });
    const r = await legacyBundle.rooms.get(ROOM);
    const snap = emptySnapshot();
    snap.store["shape:g2"] = makeGeo("shape:g2", { dash: "dashed", font: "draw" });
    r.store = snap;

    await postStyleApply(app, {
      selectedIds: ["shape:g2"],
      styles: { dash: "solid", font: "sans" },
    });

    const room = await legacyBundle.rooms.get(ROOM);
    const shape = room.store.store["shape:g2"] as any;
    expect(shape.props.dash).toBe("dashed");
    expect(shape.props.font).toBe("sans");
  });

  it("sweeps descendants of frame and writes sticky meta", async () => {
    const { app, legacyBundle } = makeApp({ inMemory: true });
    const r = await legacyBundle.rooms.get(ROOM);
    const snap = emptySnapshot();
    snap.store["shape:f1"] = makeFrame("shape:f1");
    snap.store["shape:g3"] = makeGeo("shape:g3", { parentId: "shape:f1", font: "draw" });
    r.store = snap;

    await postStyleApply(app, {
      selectedIds: ["shape:f1"],
      styles: { font: "mono" },
    });

    const room = await legacyBundle.rooms.get(ROOM);
    const frame = room.store.store["shape:f1"] as any;
    const child = room.store.store["shape:g3"] as any;
    expect(frame.meta.didrawStyleDefaults).toEqual({ font: "mono" });
    expect(child.props.font).toBe("mono");
  });

  it("respectUserOwned skips user-owned shape", async () => {
    const { app, legacyBundle } = makeApp({ inMemory: true });
    const r = await legacyBundle.rooms.get(ROOM);
    const snap = emptySnapshot();
    snap.store["shape:u1"] = makeGeo("shape:u1", {
      dash: "draw",
      meta: { styleOwnedBy: "user" },
    });
    r.store = snap;

    await postStyleApply(app, {
      selectedIds: ["shape:u1"],
      styles: { dash: "solid" },
      respectUserOwned: true,
    });

    const room = await legacyBundle.rooms.get(ROOM);
    expect((room.store.store["shape:u1"] as any).props.dash).toBe("draw");
  });

  it("400 on invalid styles", async () => {
    const { app } = makeApp({ inMemory: true });
    const res = await postStyleApply(app, {
      selectedIds: ["shape:x"],
      styles: { dash: "dashed" },
    });
    expect(res.status).toBe(400);
  });
});
