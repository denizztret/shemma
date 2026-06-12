// DRW-199 probe: извлечение боксов/рёбер фрейма из room-JSON (обобщённый extract).
// usage: bun extract2.mjs <room.json> <frameId> <out.json>
import { readFileSync, writeFileSync } from "node:fs";

const [roomPath, FRAME, outPath] = process.argv.slice(2);
const room = JSON.parse(readFileSync(roomPath, "utf8"));
const store = room.store.store;
const records = Object.values(store);
const shapes = new Map(
  records.filter((r) => r.typeName === "shape").map((s) => [s.id, s]),
);

const inFrameSubtree = (id) => {
  let cur = shapes.get(id);
  while (cur) {
    if (cur.id === FRAME) return true;
    cur = shapes.get(cur.parentId);
  }
  return false;
};

const absPos = (s) => {
  let x = s.x ?? 0;
  let y = s.y ?? 0;
  let cur = shapes.get(s.parentId);
  while (cur) {
    x += cur.x ?? 0;
    y += cur.y ?? 0;
    cur = shapes.get(cur.parentId);
  }
  return { x, y };
};

const sizeOf = (s) => {
  const p = s.props ?? {};
  return { w: p.w ?? 0, h: (p.h ?? 0) + (p.growY ?? 0) };
};

const labelOf = (s) =>
  s.meta?.didrawLabel ?? s.meta?.didrawName ?? s.props?.name ?? s.id;

const boxes = [];
for (const s of shapes.values()) {
  if (s.id === FRAME || !inFrameSubtree(s.id)) continue;
  if (s.type !== "geo" && s.type !== "schema-container") continue;
  const { x, y } = absPos(s);
  const { w, h } = sizeOf(s);
  boxes.push({
    id: s.id,
    label: String(labelOf(s)).slice(0, 40),
    kind: s.type === "schema-container" ? "container" : "leaf",
    parent: s.parentId === FRAME ? null : s.parentId,
    x,
    y,
    w,
    h,
  });
}

const byArrow = new Map();
for (const r of records) {
  if (r.typeName !== "binding" || r.type !== "arrow") continue;
  const e = byArrow.get(r.fromId) ?? {};
  e[r.props.terminal] = r.toId;
  byArrow.set(r.fromId, e);
}
const edges = [];
for (const [arrowId, e] of byArrow) {
  if (!e.start || !e.end) continue;
  if (!inFrameSubtree(e.start) || !inFrameSubtree(e.end)) continue;
  edges.push({ id: arrowId, from: e.start, to: e.end });
}

writeFileSync(outPath, JSON.stringify({ frame: FRAME, boxes, edges }, null, 2));
console.log(
  `${outPath}: boxes ${boxes.length} (leaf ${boxes.filter((b) => b.kind === "leaf").length} / cont ${boxes.filter((b) => b.kind === "container").length}), edges ${edges.length}`,
);
