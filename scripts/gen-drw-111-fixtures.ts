/**
 * Generator for DRW-111 manual E2E test fixtures room.
 * Covers Blocks 1–7 + edge cases from docs/manual-tests/drw-111-visual-fidelity.md
 *
 * Usage:
 *   bun scripts/gen-drw-111-fixtures.ts > .shemma/canvas/drw-111-fixtures.json
 */

// ─── ID helpers ─────────────────────────────────────────────────────────────

let _idCounter = 1;

function nextShapeId(): string {
  return `shape:fxr-${(_idCounter++).toString(36).padStart(8, "0")}`;
}

function nextBindingId(): string {
  return `binding:fxr-${(_idCounter++).toString(36).padStart(8, "0")}`;
}

// ─── Rich text ───────────────────────────────────────────────────────────────

function richText(s: string) {
  if (!s) {
    return { type: "doc", content: [{ type: "paragraph", content: [] }] };
  }
  return {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: s }] },
    ],
  };
}

// ─── Record factories ────────────────────────────────────────────────────────

type TLColor =
  | "black" | "grey" | "light-violet" | "violet"
  | "blue" | "light-blue" | "yellow" | "orange"
  | "green" | "light-green" | "light-red" | "red";

type TLFill = "none" | "semi" | "solid" | "pattern";
type TLSize = "s" | "m" | "l" | "xl";
type TLFont = "draw" | "sans" | "serif" | "mono";
type TLDash = "draw" | "dashed" | "dotted" | "solid";
type TLGeo = "rectangle" | "ellipse" | "rhombus" | "triangle";
type TLArrowhead = "none" | "arrow" | "triangle" | "square" | "dot" | "diamond" | "inverted" | "bar" | "pipe";

interface GeoProps {
  w?: number;
  h?: number;
  geo?: TLGeo;
  color?: TLColor;
  fill?: TLFill;
  size?: TLSize;
  font?: TLFont;
  dash?: TLDash;
  text?: string;
  parentId?: string;
  index?: string;
}

// ─── Fractional index generator ──────────────────────────────────────────────
// Generates valid tldraw IndexKey values in the sequence:
//   a0, a1, ..., a9, aA, ..., aZ, aa, ..., az, b00, b01, ..., b0z, b10, ...
// This matches what jittered-fractional-indexing generates with jitterBits=0.
// The integer part cycles through single uppercase letters (a, b, c, ...).
// The fractional digits use base-62 chars: 0-9, A-Z, a-z.

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function toB62(n: number, width: number): string {
  let result = "";
  for (let i = 0; i < width; i++) {
    result = B62[n % 62] + result;
    n = Math.floor(n / 62);
  }
  return result;
}

// Generate the Nth index key (0-based).
// Pattern: positions 0..61 are a0..az (1 digit), 62..3843 are b00..bzz (2 digits), etc.
function indexKeyAt(pos: number): string {
  if (pos < 62) {
    // Single-digit range: a0..az
    return "a" + B62[pos];
  }
  pos -= 62;
  if (pos < 62 * 62) {
    // Two-digit range: b00..bzz
    return "b" + toB62(pos, 2);
  }
  pos -= 62 * 62;
  if (pos < 62 * 62 * 62) {
    // Three-digit range: c000..czzz
    return "c" + toB62(pos, 3);
  }
  throw new Error(`Index position too large: ${pos + 62 + 62 * 62}`);
}

let _indexCursor = 0;

function nextIndex(): string {
  return indexKeyAt(_indexCursor++);
}

function geoShape(
  x: number,
  y: number,
  opts: GeoProps = {}
): Record<string, unknown> {
  const id = nextShapeId();
  const {
    w = 120, h = 80, geo = "rectangle",
    color = "blue", fill = "solid", size = "m",
    font = "draw", dash = "draw",
    text = "", parentId = "page:page", index,
  } = opts;
  return {
    id,
    typeName: "shape",
    type: "geo",
    x,
    y,
    parentId,
    index: index ?? nextIndex(),
    isLocked: false,
    opacity: 1,
    rotation: 0,
    props: {
      w,
      h,
      geo,
      color,
      labelColor: "black",
      fill,
      dash,
      size,
      font,
      align: "middle",
      verticalAlign: "middle",
      growY: 0,
      url: "",
      scale: 1,
      richText: richText(text),
    },
    meta: {},
  };
}

interface ArrowProps {
  color?: TLColor;
  size?: TLSize;
  font?: TLFont;
  dash?: TLDash;
  arrowheadStart?: TLArrowhead;
  arrowheadEnd?: TLArrowhead;
  label?: string;
  parentId?: string;
  index?: string;
}

interface ArrowResult {
  arrow: Record<string, unknown>;
  bindings: Record<string, unknown>[];
}

function arrowShape(
  startShapeId: string,
  endShapeId: string,
  opts: ArrowProps = {}
): ArrowResult {
  const arrowId = nextShapeId();
  const {
    color = "black", size = "m", font = "draw", dash = "draw",
    arrowheadStart = "none", arrowheadEnd = "arrow",
    label = "", parentId = "page:page", index,
  } = opts;

  const arrow: Record<string, unknown> = {
    id: arrowId,
    typeName: "shape",
    type: "arrow",
    x: 0,
    y: 0,
    parentId,
    index: index ?? nextIndex(),
    isLocked: false,
    opacity: 1,
    rotation: 0,
    props: {
      kind: "arc",
      color,
      labelColor: "black",
      fill: "none",
      dash,
      size,
      arrowheadStart,
      arrowheadEnd,
      font,
      start: { x: 0, y: 0 },
      end: { x: 0, y: 0 },
      bend: 0,
      elbowMidPoint: 0.5,
      labelPosition: 0.5,
      scale: 1,
      richText: richText(label),
    },
    meta: {},
  };

  const startBinding: Record<string, unknown> = {
    id: nextBindingId(),
    typeName: "binding",
    type: "arrow",
    fromId: arrowId,
    toId: startShapeId,
    props: {
      terminal: "start",
      normalizedAnchor: { x: 0.5, y: 0.5 },
      isExact: false,
      isPrecise: false,
      snap: "none",
    },
    meta: {},
  };

  const endBinding: Record<string, unknown> = {
    id: nextBindingId(),
    typeName: "binding",
    type: "arrow",
    fromId: arrowId,
    toId: endShapeId,
    props: {
      terminal: "end",
      normalizedAnchor: { x: 0.5, y: 0.5 },
      isExact: false,
      isPrecise: false,
      snap: "none",
    },
    meta: {},
  };

  return { arrow, bindings: [startBinding, endBinding] };
}

interface FrameProps {
  color?: TLColor;
  name?: string;
  index?: string;
}

function frameShape(
  x: number,
  y: number,
  w: number,
  h: number,
  opts: FrameProps = {}
): { id: string; record: Record<string, unknown> } {
  const id = nextShapeId();
  const { color = "black", name = "Frame", index } = opts;
  return {
    id,
    record: {
      id,
      typeName: "shape",
      type: "frame",
      x,
      y,
      parentId: "page:page",
      index: index ?? nextIndex(),
      isLocked: false,
      opacity: 1,
      rotation: 0,
      props: {
        name,
        w,
        h,
        color,
      },
      meta: {},
    },
  };
}

interface NoteProps {
  color?: TLColor;
  size?: TLSize;
  font?: TLFont;
  text?: string;
  index?: string;
}

function noteShape(
  x: number,
  y: number,
  opts: NoteProps = {}
): Record<string, unknown> {
  const id = nextShapeId();
  const { color = "yellow", size = "m", font = "draw", text = "", index } = opts;
  return {
    id,
    typeName: "shape",
    type: "note",
    x,
    y,
    parentId: "page:page",
    index: index ?? nextIndex(),
    isLocked: false,
    opacity: 1,
    rotation: 0,
    props: {
      color,
      fontSizeAdjustment: 1,
      growY: 0,
      labelColor: "black",
      richText: richText(text),
      align: "middle",
      verticalAlign: "middle",
      scale: 1,
      size,
      font,
      url: "",
      textFirstEditedBy: null,
    },
    meta: {},
  };
}

interface TextProps {
  color?: TLColor;
  font?: TLFont;
  size?: TLSize;
  textAlign?: "start" | "middle" | "end";
  index?: string;
}

function textShape(
  x: number,
  y: number,
  content: string,
  opts: TextProps = {}
): Record<string, unknown> {
  const id = nextShapeId();
  const { color = "black", font = "draw", size = "m", textAlign = "start", index } = opts;
  return {
    id,
    typeName: "shape",
    type: "text",
    x,
    y,
    parentId: "page:page",
    index: index ?? nextIndex(),
    isLocked: false,
    opacity: 1,
    rotation: 0,
    props: {
      color,
      font,
      size,
      scale: 1,
      autoSize: true,
      w: 100,
      richText: richText(content),
      textAlign,
    },
    meta: {},
  };
}

// ─── Label helper — small identifier text above each block ───────────────────

function blockLabel(x: number, y: number, label: string): Record<string, unknown> {
  return textShape(x, y - 30, `[${label}]`, { color: "grey", size: "s", font: "mono" });
}

// ─── Main canvas generation ──────────────────────────────────────────────────

const allRecords: Record<string, unknown>[] = [];

function add(...records: Record<string, unknown>[]) {
  allRecords.push(...records);
}

function addArrow(startId: string, endId: string, opts: ArrowProps = {}) {
  const { arrow, bindings } = arrowShape(startId, endId, opts);
  add(arrow as Record<string, unknown>);
  add(...(bindings as Record<string, unknown>[]));
  return (arrow as { id: string }).id;
}

// Helper: child geo inside a frame (parentId = frameId)
function childGeo(
  frameId: string,
  x: number,
  y: number,
  opts: GeoProps = {}
): Record<string, unknown> {
  return geoShape(x, y, { ...opts, parentId: frameId });
}

// ─── BLOCK 1.1 — 12 colors (3 rows × 4 cols) ────────────────────────────────

const COLORS_12: TLColor[] = [
  "black", "grey", "light-violet", "violet",
  "blue", "light-blue", "yellow", "orange",
  "green", "light-green", "light-red", "red",
];

const B1_X = 0;
const B1_Y = 0;
const CELL_W = 140;
const CELL_H = 90;
const CELL_GAP = 20;

add(blockLabel(B1_X, B1_Y, "1.1 — 12 Colors (solid fill)"));

const colorShapeIds: Record<string, string> = {};
for (let i = 0; i < COLORS_12.length; i++) {
  const col = i % 4;
  const row = Math.floor(i / 4);
  const x = B1_X + col * (CELL_W + CELL_GAP);
  const y = B1_Y + row * (CELL_H + CELL_GAP);
  const color = COLORS_12[i];
  const shape = geoShape(x, y, {
    w: CELL_W,
    h: CELL_H,
    color,
    fill: "solid",
    text: color,
    size: "m",
  });
  add(shape);
  colorShapeIds[color] = (shape as { id: string }).id;
}

// ─── BLOCK 1.2 — Fill modes ──────────────────────────────────────────────────

const B2_Y = B1_Y + 3 * (CELL_H + CELL_GAP) + 60;
add(blockLabel(B1_X, B2_Y, "1.2 — Fill modes (blue)"));

const FILLS: TLFill[] = ["none", "semi", "solid", "pattern"];
for (let i = 0; i < FILLS.length; i++) {
  const fill = FILLS[i];
  add(geoShape(B1_X + i * (CELL_W + CELL_GAP), B2_Y, {
    color: "blue",
    fill,
    text: `fill:${fill}`,
    w: CELL_W,
    h: CELL_H,
  }));
}

// ─── BLOCK 1.3 — Connector colors ───────────────────────────────────────────

const B3_Y = B2_Y + CELL_H + 80;
add(blockLabel(B1_X, B3_Y, "1.3 — Connector colors"));

const CONNECTOR_COLORS: TLColor[] = ["black", "red", "green", "blue"];
const connectorLeftIds: string[] = [];
const connectorRightIds: string[] = [];

for (let i = 0; i < CONNECTOR_COLORS.length; i++) {
  const x = B1_X + i * (CELL_W + CELL_GAP);
  const leftShape = geoShape(x, B3_Y, { w: 50, h: 40, color: "grey", fill: "none", text: "A" });
  const rightShape = geoShape(x + 70, B3_Y, { w: 50, h: 40, color: "grey", fill: "none", text: "B" });
  add(leftShape, rightShape);
  connectorLeftIds.push((leftShape as { id: string }).id);
  connectorRightIds.push((rightShape as { id: string }).id);
  addArrow((leftShape as { id: string }).id, (rightShape as { id: string }).id, {
    color: CONNECTOR_COLORS[i],
    label: CONNECTOR_COLORS[i],
  });
}

// ─── BLOCK 1.4 — Sticky note colors ─────────────────────────────────────────

const B4_Y = B3_Y + CELL_H + 80;
add(blockLabel(B1_X, B4_Y, "1.4 — Sticky note colors"));

add(noteShape(B1_X, B4_Y, { text: "Default (no color)" }));
add(noteShape(B1_X + 180, B4_Y, { color: "yellow", text: "yellow" }));
add(noteShape(B1_X + 360, B4_Y, { color: "red", text: "red" }));

// ─── BLOCK 2 — Sizes ─────────────────────────────────────────────────────────

const BLK2_Y = B4_Y + 180 + 60;
add(blockLabel(B1_X, BLK2_Y, "2 — Sizes (s/m/l/xl)"));

const SIZES: TLSize[] = ["s", "m", "l", "xl"];
const sizeShapeIds: string[] = [];

for (let i = 0; i < SIZES.length; i++) {
  const size = SIZES[i];
  const shape = geoShape(B1_X + i * (CELL_W + CELL_GAP), BLK2_Y, {
    color: "blue", fill: "solid", size, text: `geo:${size}`,
    w: CELL_W, h: CELL_H,
  });
  add(shape);
  sizeShapeIds.push((shape as { id: string }).id);
}

// Sticky notes at 4 sizes
add(blockLabel(B1_X, BLK2_Y + CELL_H + 40, "2b — Sticky sizes"));
for (let i = 0; i < SIZES.length; i++) {
  add(noteShape(B1_X + i * 180, BLK2_Y + CELL_H + 60, {
    color: "yellow",
    size: SIZES[i],
    text: `note:${SIZES[i]}`,
  }));
}

// Arrows at 4 sizes (between size rects to save space — synthetic floating arrows)
add(blockLabel(B1_X + 800, BLK2_Y, "2c — Arrow sizes"));
const arrowSizeLeftIds: string[] = [];
const arrowSizeRightIds: string[] = [];
for (let i = 0; i < SIZES.length; i++) {
  const ax = B1_X + 800;
  const ay = BLK2_Y + i * 60;
  const ls = geoShape(ax, ay, { w: 50, h: 35, color: "grey", fill: "none", text: SIZES[i] });
  const rs = geoShape(ax + 200, ay, { w: 50, h: 35, color: "grey", fill: "none", text: SIZES[i] });
  add(ls, rs);
  arrowSizeLeftIds.push((ls as { id: string }).id);
  arrowSizeRightIds.push((rs as { id: string }).id);
  addArrow((ls as { id: string }).id, (rs as { id: string }).id, {
    size: SIZES[i], label: `arrow:${SIZES[i]}`,
  });
}

// ─── BLOCK 3 — Fonts ─────────────────────────────────────────────────────────

const BLK3_Y = BLK2_Y + CELL_H + 280;
add(blockLabel(B1_X, BLK3_Y, "3 — Font mapping (draw/sans/serif/mono)"));

const FONTS: TLFont[] = ["draw", "sans", "serif", "mono"];
for (let i = 0; i < FONTS.length; i++) {
  const font = FONTS[i];
  add(geoShape(B1_X + i * (CELL_W + CELL_GAP), BLK3_Y, {
    color: "blue", fill: "semi", size: "m",
    font, text: `font:${font}`,
    w: CELL_W, h: CELL_H,
  }));
  // Also sticky note with same font
  add(noteShape(B1_X + i * 180, BLK3_Y + CELL_H + 40, {
    color: "yellow", font, text: `note:${font}`,
  }));
  // Text widget
  add(textShape(B1_X + i * 180, BLK3_Y + CELL_H + 180, `text:${font}`, { font, size: "m" }));
}

// ─── BLOCK 4 — Arrowheads ─────────────────────────────────────────────────────

const BLK4_Y = BLK3_Y + CELL_H + 300;
add(blockLabel(B1_X, BLK4_Y, "4 — Arrowheads (9 types)"));

const ARROWHEADS: TLArrowhead[] = [
  "none", "arrow", "triangle", "square", "dot",
  "diamond", "inverted", "bar", "pipe",
];

for (let i = 0; i < ARROWHEADS.length; i++) {
  const ax = B1_X + (i % 5) * 220;
  const ay = BLK4_Y + Math.floor(i / 5) * 120;
  const head = ARROWHEADS[i];
  const ls = geoShape(ax, ay, { w: 60, h: 40, color: "grey", fill: "none", text: "S" });
  const rs = geoShape(ax + 120, ay, { w: 60, h: 40, color: "grey", fill: "none", text: "E" });
  add(ls, rs);
  add(textShape(ax, ay + 50, `end:${head}`, { color: "grey", size: "s", font: "mono" }));
  addArrow((ls as { id: string }).id, (rs as { id: string }).id, {
    arrowheadEnd: head, arrowheadStart: "none",
    color: "black", label: head,
  });
}

// Bonus combo arrow: start=diamond, end=triangle
const comboY = BLK4_Y + 250;
add(blockLabel(1200, comboY, "4b — combo: diamond+triangle"));
const comboL = geoShape(1200, comboY, { w: 60, h: 40, color: "blue", fill: "none", text: "S" });
const comboR = geoShape(1350, comboY, { w: 60, h: 40, color: "blue", fill: "none", text: "E" });
add(comboL, comboR);
addArrow((comboL as { id: string }).id, (comboR as { id: string }).id, {
  arrowheadStart: "diamond", arrowheadEnd: "triangle",
  color: "blue", label: "diamond→triangle",
});

// ─── BLOCK 5 — Frames ────────────────────────────────────────────────────────

const BLK5_Y = BLK4_Y + 400;

// 5.1 Single frame with 3 children
add(blockLabel(B1_X, BLK5_Y, "5.1 — Single frame, 3 children"));
const f51 = frameShape(B1_X, BLK5_Y, 520, 180, { name: "Backend Services", color: "blue" });
add(f51.record);
add(childGeo(f51.id, 20, 50, { color: "blue", fill: "semi", text: "Service A", w: 120, h: 70 }));
add(childGeo(f51.id, 180, 50, { color: "green", fill: "semi", text: "Service B", w: 120, h: 70 }));
add(childGeo(f51.id, 340, 50, { color: "red", fill: "semi", text: "Service C", w: 120, h: 70 }));

// 5.2 Nested frames
const BLK52_Y = BLK5_Y + 320;
add(blockLabel(B1_X, BLK52_Y, "5.2 — Nested frames (F1 ⊃ F2 + outer)"));
const f52_outer = frameShape(B1_X, BLK52_Y, 700, 300, { name: "Platform", color: "black" });
add(f52_outer.record);
// F2 inside F1 (as child - parentId = f52_outer.id)
const f52_inner = frameShape(20, 60, 360, 180, {
  name: "Core Services",
  color: "blue",
});
// Override parentId for inner frame
(f52_inner.record as Record<string, unknown>).parentId = f52_outer.id;
add(f52_inner.record);
add(childGeo(f52_inner.id, 20, 50, { color: "blue", fill: "semi", text: "Service X", w: 120, h: 70 }));
add(childGeo(f52_inner.id, 180, 50, { color: "violet", fill: "semi", text: "Service Y", w: 120, h: 70 }));
// Outer child (sibling of inner frame)
add(childGeo(f52_outer.id, 420, 80, { color: "orange", fill: "semi", text: "Outer Svc", w: 150, h: 80 }));

// 5.3 Empty frame
const BLK53_Y = BLK52_Y + 400;
add(blockLabel(B1_X, BLK53_Y, "5.3 — Empty frame"));
const f53 = frameShape(B1_X, BLK53_Y, 300, 160, { name: "Empty Container", color: "grey" });
add(f53.record);

// 5.4 Single-child frame
const BLK54_Y = BLK53_Y + 260;
add(blockLabel(B1_X, BLK54_Y, "5.4 — Single-child frame"));
const f54 = frameShape(B1_X, BLK54_Y, 300, 160, { name: "Lonely", color: "green" });
add(f54.record);
add(childGeo(f54.id, 80, 50, { color: "green", fill: "semi", text: "Only Child", w: 120, h: 70 }));

// 5.5 Frame border colors (4 frames with different colors)
const BLK55_Y = BLK54_Y + 260;
add(blockLabel(B1_X, BLK55_Y, "5.5 — Frame border colors"));
const FRAME_COLORS: TLColor[] = ["black", "blue", "green", "red"];
for (let i = 0; i < FRAME_COLORS.length; i++) {
  const color = FRAME_COLORS[i];
  const fx = B1_X + i * 260;
  const f = frameShape(fx, BLK55_Y, 220, 150, { name: `Frame ${color}`, color });
  add(f.record);
  add(childGeo(f.id, 50, 40, { color, fill: "semi", text: color, w: 100, h: 60 }));
}

// ─── BLOCK 6 — Connector style (hotfix) ─────────────────────────────────────

const BLK6_Y = BLK55_Y + 260;
add(blockLabel(B1_X, BLK6_Y, "6.1+6.2 — Connector style (color/size, no fontFamily)"));

const s6L = geoShape(B1_X, BLK6_Y, { color: "red", fill: "solid", text: "Source", w: 120, h: 70 });
const s6R = geoShape(B1_X + 300, BLK6_Y, { color: "green", fill: "solid", text: "Target", w: 120, h: 70 });
add(s6L, s6R);
addArrow((s6L as { id: string }).id, (s6R as { id: string }).id, {
  color: "red", size: "l", font: "mono",
  arrowheadStart: "none", arrowheadEnd: "triangle",
  label: "red+size:l+mono",
});

// ─── BLOCK 7 — Standalone text widgets ──────────────────────────────────────

const BLK7_Y = BLK6_Y + 200;
add(blockLabel(B1_X, BLK7_Y, "7 — Standalone text widgets"));

add(textShape(B1_X, BLK7_Y, "Red mono (m)", { color: "red", font: "mono", size: "m" }));
add(textShape(B1_X + 250, BLK7_Y, "Blue large sans", { color: "blue", font: "sans", size: "l" }));
add(textShape(B1_X + 550, BLK7_Y, "Default draw", { color: "black", font: "draw", size: "m" }));

// ─── Edge cases ──────────────────────────────────────────────────────────────

const EDGE_Y = BLK7_Y + 150;
add(blockLabel(B1_X, EDGE_Y, "Edge — unicode, long label, empty label"));

add(geoShape(B1_X, EDGE_Y, {
  color: "violet", fill: "semi",
  text: "🚀 Сервис 服务",
  w: 180, h: 80,
}));

add(geoShape(B1_X + 220, EDGE_Y, {
  color: "blue", fill: "none",
  text: "A".repeat(200),
  w: 300, h: 80,
}));

add(geoShape(B1_X + 560, EDGE_Y, {
  color: "grey", fill: "none",
  text: "",
  w: 120, h: 80,
}));

// Empty frame name
const edgeFrame = frameShape(B1_X + 720, EDGE_Y, 200, 100, { name: "", color: "grey" });
add(edgeFrame.record);
add(childGeo(edgeFrame.id, 40, 30, { color: "grey", fill: "none", text: "child", w: 100, h: 50 }));

// 3-level nesting: F1 ⊃ F2 ⊃ F3 ⊃ shape
const EDGE3_Y = EDGE_Y + 200;
add(blockLabel(B1_X, EDGE3_Y, "Edge — 3-level nesting"));
const eF1 = frameShape(B1_X, EDGE3_Y, 600, 360, { name: "Level 1", color: "black" });
add(eF1.record);
const eF2 = frameShape(20, 40, 460, 260, { name: "Level 2", color: "blue" });
(eF2.record as Record<string, unknown>).parentId = eF1.id;
add(eF2.record);
const eF3 = frameShape(20, 40, 320, 160, { name: "Level 3", color: "green" });
(eF3.record as Record<string, unknown>).parentId = eF2.id;
add(eF3.record);
add(childGeo(eF3.id, 80, 50, { color: "green", fill: "solid", text: "Deepest Shape", w: 150, h: 70 }));

// ─── Assemble store ───────────────────────────────────────────────────────────

const document_record = {
  id: "document:document",
  typeName: "document",
  gridSize: 10,
  name: "",
  meta: {},
};

const page_record = {
  id: "page:page",
  typeName: "page",
  name: "Page 1",
  index: "a1",
  meta: {},
};

const storeMap: Record<string, unknown> = {};
storeMap["document:document"] = document_record;
storeMap["page:page"] = page_record;

for (const rec of allRecords) {
  const r = rec as { id: string };
  storeMap[r.id] = rec;
}

const schema = {
  schemaVersion: 2,
  sequences: {
    "com.tldraw.store": 5,
    "com.tldraw.asset": 1,
    "com.tldraw.camera": 1,
    "com.tldraw.document": 2,
    "com.tldraw.instance": 26,
    "com.tldraw.instance_page_state": 5,
    "com.tldraw.page": 1,
    "com.tldraw.instance_presence": 6,
    "com.tldraw.pointer": 1,
    "com.tldraw.shape": 4,
    "com.tldraw.user": 1,
    "com.tldraw.asset.image": 6,
    "com.tldraw.asset.video": 5,
    "com.tldraw.asset.bookmark": 2,
    "com.tldraw.shape.group": 0,
    "com.tldraw.shape.text": 4,
    "com.tldraw.shape.bookmark": 2,
    "com.tldraw.shape.draw": 4,
    "com.tldraw.shape.geo": 11,
    "com.tldraw.shape.note": 12,
    "com.tldraw.shape.line": 5,
    "com.tldraw.shape.frame": 1,
    "com.tldraw.shape.arrow": 8,
    "com.tldraw.shape.highlight": 3,
    "com.tldraw.shape.embed": 4,
    "com.tldraw.shape.image": 5,
    "com.tldraw.shape.video": 4,
    "com.tldraw.binding.arrow": 1,
  },
};

const shapeCount = allRecords.filter((r) => (r as { typeName: string }).typeName === "shape").length;
const bindingCount = allRecords.filter((r) => (r as { typeName: string }).typeName === "binding").length;

const room = {
  roomId: "drw-111-fixtures",
  schemaVersion: 3,
  version: 1,
  elementCount: shapeCount,
  lastTouched: new Date().toISOString(),
  shemma: {
    shemmaVersion: "0.24.0",
    createdAt: new Date().toISOString(),
  },
  meta: {},
  opLog: [],
  prompts: [],
  projectDir: null,
  store: {
    schema,
    store: storeMap,
  },
};

process.stdout.write(JSON.stringify(room, null, 2));
process.stderr.write(
  `\nGenerated: ${shapeCount} shapes, ${bindingCount} bindings, total records: ${
    Object.keys(storeMap).length
  }\n`
);
