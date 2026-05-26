import { describe, expect, test } from "bun:test";
import { runLayout } from "../../src/domain/layout";
import type { TLStoreSnapshot } from "../../src/store-types";

function makeStore(arrowLabel: string): TLStoreSnapshot {
  const richText = arrowLabel
    ? { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: arrowLabel }] }] }
    : { type: "doc", content: [{ type: "paragraph" }] };
  return {
    store: {
      "shape:frame": { id: "shape:frame", typeName: "shape", type: "frame", x: 0, y: 0, parentId: "page:page", index: "a1", isLocked: false, opacity: 1, rotation: 0, props: { w: 800, h: 400, name: "F" }, meta: {} },
      "shape:A":     { id: "shape:A", typeName: "shape", type: "geo", x: 0, y: 0, parentId: "shape:frame", index: "a1", isLocked: false, opacity: 1, rotation: 0, props: { geo: "rectangle", w: 120, h: 60 }, meta: {} },
      "shape:B":     { id: "shape:B", typeName: "shape", type: "geo", x: 0, y: 0, parentId: "shape:frame", index: "a2", isLocked: false, opacity: 1, rotation: 0, props: { geo: "rectangle", w: 120, h: 60 }, meta: {} },
      "shape:arrow": { id: "shape:arrow", typeName: "shape", type: "arrow", x: 0, y: 0, parentId: "shape:frame", index: "a3", isLocked: false, opacity: 1, rotation: 0, props: { kind: "elbow", color: "black", fill: "none", dash: "draw", size: "m", labelColor: "black", font: "draw", start: { x: 0, y: 0 }, end: { x: 0, y: 0 }, bend: 0, elbowMidPoint: 0.5, labelPosition: 0.5, scale: 1, richText, arrowheadStart: "none", arrowheadEnd: "arrow" }, meta: {} },
      "binding:s":   { id: "binding:s", typeName: "binding", type: "arrow", fromId: "shape:arrow", toId: "shape:A", props: { terminal: "start", normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: "none" } },
      "binding:e":   { id: "binding:e", typeName: "binding", type: "arrow", fromId: "shape:arrow", toId: "shape:B", props: { terminal: "end", normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: "none" } },
    },
    schema: { schemaVersion: 1, sequenceNumber: 0, storeVersion: 1, recordVersions: {} },
  } as unknown as TLStoreSnapshot;
}

function abs(rec: { x?: number; y?: number; parentId?: string }, store: Record<string, any>): { x: number; y: number } {
  let x = rec.x ?? 0, y = rec.y ?? 0, pid = rec.parentId;
  while (pid && pid !== "page:page") {
    const parent = store[pid];
    if (!parent || parent.typeName !== "shape") break;
    x += parent.x ?? 0;
    y += parent.y ?? 0;
    pid = parent.parentId;
  }
  return { x, y };
}

describe("layout — label spacing reservation", () => {
  test("long label forces wider A-to-B distance than short label", async () => {
    const shortStore = makeStore("ok");
    const longStore = makeStore("very-long-label-text-here-many-chars");

    const shortRes = await runLayout(shortStore, { mode: "layered-lr", scope: "all" }, new Map());
    const longRes = await runLayout(longStore, { mode: "layered-lr", scope: "all" }, new Map());

    const shortAfter: Record<string, any> = { ...shortStore.store };
    for (const [id, [, next]] of Object.entries(shortRes.batch.updated)) shortAfter[id] = next;
    const longAfter: Record<string, any> = { ...longStore.store };
    for (const [id, [, next]] of Object.entries(longRes.batch.updated)) longAfter[id] = next;

    const shortA = abs(shortAfter["shape:A"], shortAfter);
    const shortB = abs(shortAfter["shape:B"], shortAfter);
    const longA = abs(longAfter["shape:A"], longAfter);
    const longB = abs(longAfter["shape:B"], longAfter);

    const shortGap = shortB.x - (shortA.x + 120);
    const longGap = longB.x - (longA.x + 120);

    expect(longGap).toBeGreaterThan(shortGap);
  });
});
