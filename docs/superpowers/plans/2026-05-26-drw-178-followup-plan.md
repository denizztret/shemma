# DRW-178 follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch shemma's mermaid-imported diagrams to native tldraw elbow arrows, add smart-layout pipeline (per-container direction heuristic + elbow-midpoint distribution + label-spacing reservation), parameterize layout via `LayoutParams`, and add a `POST /api/smart-insert` endpoint for adding single shapes without full re-layout.

**Architecture:** Pipeline `determineContainerDirection → ELK positions → computeAnchors → computeElbowMidpoints → reserveEdgeLabelSpacing` runs on `POST /api/layout` and produces deterministic results for a given topology+params. All new layout decisions are made on the backend; the frontend uses native tldraw `arrow` shape with `kind:"elbow"` and benefits from native binding reactivity (no custom shape, no runtime libavoid).

**Tech Stack:** Bun + TypeScript backend, tldraw 5.x frontend (kind:"elbow", `TLArrowBinding` with `normalizedAnchor + isPrecise + snap`), ELK layered (existing), Hono routes, `bun test`.

**Spec:** [`docs/superpowers/specs/2026-05-26-drw-178-followup-design.md`](../specs/2026-05-26-drw-178-followup-design.md)
**Research:** [`docs/references/drw-178-followup/research.md`](../../references/drw-178-followup/research.md)
**Branch:** `feature/drw-173-attempt-2` (from tag `0.27.1`, commit `2d6f792`)

---

## Phase 1 — Switch to elbow + measure-and-reserve labels

Goal: mermaid-imported arrows render as `kind:"elbow"`; layout pipeline reserves horizontal space for label width so labels never overflow into neighbouring shapes/arrows.

### Task 1.1 — Switch `compile.ts:makeArrowShape` to `kind:"elbow"`

**Files:**
- Modify: `apps/backend/src/domain/compile.ts:58` (single-character change `arc` → `elbow`)
- Test: `apps/backend/src/domain/compile.test.ts` (existing — find the assertion that checks `kind:"arc"` and flip)

- [ ] **Step 1: Locate existing test that checks `kind`**

Run: `grep -n "kind" apps/backend/src/domain/compile.test.ts`
Expected: a line like `expect(arrow.props.kind).toBe("arc")`.

- [ ] **Step 2: Flip the test to expect "elbow"**

Edit the existing test:

```typescript
expect(arrow.props.kind).toBe("elbow");
```

- [ ] **Step 3: Run the test — verify it FAILS**

Run: `bun --cwd apps/backend test src/domain/compile.test.ts -t "kind"`
Expected: FAIL — actual value is "arc".

- [ ] **Step 4: Change `kind:"arc"` to `kind:"elbow"` in compile.ts:58**

```typescript
// apps/backend/src/domain/compile.ts:57-58
props: {
  kind: "elbow",  // was: "arc"
  color: "black",
  ...
}
```

- [ ] **Step 5: Run the test — verify it PASSES**

Run: `bun --cwd apps/backend test src/domain/compile.test.ts`
Expected: all green.

- [ ] **Step 6: Run full backend test suite to catch regressions**

Run: `bun --cwd apps/backend test`
Expected: all green. If any snapshot tests fail due to kind change, update them inline.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/domain/compile.ts apps/backend/src/domain/compile.test.ts
git commit -m "feat(drw-178): default new arrows to kind:elbow in compile.ts"
```

---

### Task 1.2 — Switch `schema.ts:makeArrowShapeLocal` to `kind:"elbow"`

**Files:**
- Modify: `apps/backend/src/routes/schema.ts:130`
- Test: `apps/backend/src/routes/schema.test.ts` (existing — find `kind` assertion)

- [ ] **Step 1: Locate existing test that checks `kind` in schema route**

Run: `grep -n "kind" apps/backend/src/routes/schema.test.ts`
Expected: assertions on `arrow.props.kind`.

- [ ] **Step 2: Flip all `kind:"arc"` expectations to `"elbow"`**

For every test asserting `kind:"arc"` on a mermaid-imported arrow, change to `kind:"elbow"`. Do NOT flip tests for converted external arrows — only mermaid-import path.

- [ ] **Step 3: Run schema tests — verify they FAIL**

Run: `bun --cwd apps/backend test src/routes/schema.test.ts -t "kind"`
Expected: failures.

- [ ] **Step 4: Change `kind:"arc"` to `kind:"elbow"` in schema.ts:130**

```typescript
// apps/backend/src/routes/schema.ts:129-130
props: {
  kind: "elbow",  // was: "arc"
  color: "black",
  ...
}
```

- [ ] **Step 5: Run schema tests — verify PASS**

Run: `bun --cwd apps/backend test src/routes/schema.test.ts`
Expected: all green.

- [ ] **Step 6: Run full backend test suite**

Run: `bun --cwd apps/backend test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/routes/schema.ts apps/backend/src/routes/schema.test.ts
git commit -m "feat(drw-178): default schema-create arrows to kind:elbow"
```

---

### Task 1.3 — Add `label-metrics.ts` heuristic in shemma-domain

**Files:**
- Create: `packages/shemma-domain/src/label-metrics.ts`
- Create: `packages/shemma-domain/src/label-metrics.test.ts`
- Modify: `packages/shemma-domain/src/index.ts` (re-export)

**Heuristic:** width = `lines * lineWidth`, where `lineWidth = avgCharWidth(font, fontSize) * charsPerLine`. For tldraw default font `"draw"` size `"m"` (16px), `avgCharWidth ≈ 7px` (latin) / `8px` (cyrillic-aware). We use 8px as conservative average. `lineHeight = fontSize * 1.4`.

- [ ] **Step 1: Write failing test — single-line latin label**

Create `packages/shemma-domain/src/label-metrics.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { measureLabelHeuristic } from "./label-metrics";

describe("measureLabelHeuristic", () => {
  test("empty label → zero dimensions", () => {
    expect(measureLabelHeuristic("", {})).toEqual({ width: 0, height: 0, lines: 0 });
  });

  test("short label fits in one line", () => {
    const r = measureLabelHeuristic("calls", {});
    expect(r.lines).toBe(1);
    expect(r.width).toBeGreaterThan(0);
    expect(r.width).toBeLessThan(60); // 5 chars × ~8px = ~40px
  });

  test("long label wraps within max width", () => {
    const r = measureLabelHeuristic(
      "A".repeat(60),
      { maxWidth: 200 }
    );
    expect(r.lines).toBeGreaterThan(1);
    expect(r.width).toBeLessThanOrEqual(200);
  });

  test("maxLines caps the wrapping", () => {
    const r = measureLabelHeuristic("A".repeat(200), { maxWidth: 100, maxLines: 3 });
    expect(r.lines).toBe(3);
  });

  test("cyrillic chars use same average width", () => {
    const latin = measureLabelHeuristic("aaaaa", {});
    const cyrillic = measureLabelHeuristic("ккккк", {});
    expect(cyrillic.width).toBe(latin.width);
  });
});
```

- [ ] **Step 2: Run test — verify FAIL (no module)**

Run: `bun --cwd packages/shemma-domain test src/label-metrics.test.ts`
Expected: error "Cannot find module './label-metrics'".

- [ ] **Step 3: Create `label-metrics.ts` with heuristic implementation**

```typescript
// packages/shemma-domain/src/label-metrics.ts

export type LabelMetricsOptions = {
  /** Heuristic font size in px (default 16, tldraw size "m"). */
  fontSize?: number;
  /** Maximum wrap width before line break (default 200). */
  maxWidth?: number;
  /** Maximum lines (default 3). Excess truncated, no ellipsis (just clamped). */
  maxLines?: number;
};

export type LabelMetrics = {
  width: number;
  height: number;
  lines: number;
};

const DEFAULT_FONT_SIZE = 16;
const DEFAULT_MAX_WIDTH = 200;
const DEFAULT_MAX_LINES = 3;
const AVG_CHAR_WIDTH_RATIO = 0.5; // char_width = fontSize * 0.5 (~8px at 16)
const LINE_HEIGHT_RATIO = 1.4;

export function measureLabelHeuristic(
  text: string,
  opts: LabelMetricsOptions,
): LabelMetrics {
  if (!text) return { width: 0, height: 0, lines: 0 };
  const fontSize = opts.fontSize ?? DEFAULT_FONT_SIZE;
  const maxWidth = opts.maxWidth ?? DEFAULT_MAX_WIDTH;
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
  const avgCharWidth = fontSize * AVG_CHAR_WIDTH_RATIO;
  const lineHeight = Math.ceil(fontSize * LINE_HEIGHT_RATIO);

  const charsPerLine = Math.max(1, Math.floor(maxWidth / avgCharWidth));
  const idealLines = Math.ceil(text.length / charsPerLine);
  const lines = Math.min(idealLines, maxLines);

  // Width = chars on longest used line × avgCharWidth, but never exceeds maxWidth.
  const usedCharsLastLine = lines < idealLines
    ? charsPerLine
    : (text.length - (lines - 1) * charsPerLine) || charsPerLine;
  const longestChars = lines > 1 ? charsPerLine : usedCharsLastLine;
  const width = Math.min(maxWidth, Math.ceil(longestChars * avgCharWidth));
  const height = lines * lineHeight;

  return { width, height, lines };
}
```

- [ ] **Step 4: Add re-export to `packages/shemma-domain/src/index.ts`**

```typescript
export {
  measureLabelHeuristic,
  type LabelMetrics,
  type LabelMetricsOptions,
} from "./label-metrics";
```

- [ ] **Step 5: Run tests — verify PASS**

Run: `bun --cwd packages/shemma-domain test src/label-metrics.test.ts`
Expected: 5 pass.

- [ ] **Step 6: Run full domain suite**

Run: `bun --cwd packages/shemma-domain test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add packages/shemma-domain/src/label-metrics.ts packages/shemma-domain/src/label-metrics.test.ts packages/shemma-domain/src/index.ts
git commit -m "feat(drw-178): heuristic label measure (chars × avg-char-width)"
```

---

### Task 1.4 — Inject label-derived edge spacing into ELK input

**Files:**
- Modify: `apps/backend/src/domain/layout.ts` (find the call site that builds ELK edge options — around `runLayoutSubgraph` / single-pass)
- Test: `apps/backend/tests/domain/layout-label-spacing.test.ts` (new)

The change: per edge, compute `labelMetrics.width` from arrow `richText`, then set ELK edge layout option `org.eclipse.elk.spacing.nodeNode` (or per-edge minimum length) at least `width + 2 * 12` (margin). For arrows with no label, no override.

- [ ] **Step 1: Read the existing ELK edge build code**

Run: `grep -n "elk.edge\|elkEdges\|elkLayoutOptions" apps/backend/src/domain/layout.ts | head -20`

Identify where edges are converted to ELK format. Read the surrounding 60 lines for context.

- [ ] **Step 2: Write a failing integration test**

Create `apps/backend/tests/domain/layout-label-spacing.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { runLayout } from "../../src/domain/layout";
import type { TLStoreSnapshot } from "../../src/store-types";

function makeStore(arrowLabel: string): TLStoreSnapshot {
  // Two shapes A (left) and B (right) inside frame, one arrow A→B with given label.
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

function abs(rec: { x?: number; y?: number; parentId?: string }, store: any): { x: number; y: number } {
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

    const shortAfter = { ...shortStore.store };
    for (const [id, [, next]] of Object.entries(shortRes.batch.updated)) shortAfter[id] = next as any;
    const longAfter = { ...longStore.store };
    for (const [id, [, next]] of Object.entries(longRes.batch.updated)) longAfter[id] = next as any;

    const shortA = abs(shortAfter["shape:A"], shortAfter);
    const shortB = abs(shortAfter["shape:B"], shortAfter);
    const longA = abs(longAfter["shape:A"], longAfter);
    const longB = abs(longAfter["shape:B"], longAfter);

    const shortGap = shortB.x - (shortA.x + 120);
    const longGap = longB.x - (longA.x + 120);

    // The long-label edge should reserve more horizontal space than short-label.
    expect(longGap).toBeGreaterThan(shortGap);
  });
});
```

- [ ] **Step 3: Run — verify FAIL**

Run: `bun --cwd apps/backend test tests/domain/layout-label-spacing.test.ts`
Expected: FAIL (long gap not greater than short — both equal because no spacing logic yet).

- [ ] **Step 4: Add a helper `extractArrowLabel` in `layout.ts`**

Add near top of file (after imports):

```typescript
function extractArrowLabel(shape: ShapeRec): string {
  const rt = (shape.props as { richText?: { content?: Array<{ content?: Array<{ text?: string }> }> } } | undefined)?.richText;
  if (!rt?.content) return "";
  const parts: string[] = [];
  for (const block of rt.content) {
    if (!Array.isArray(block?.content)) continue;
    for (const span of block.content) {
      if (typeof span?.text === "string") parts.push(span.text);
    }
  }
  return parts.join("");
}
```

- [ ] **Step 5: At the edge-building site, set `labelEdgeLength` per edge**

Find the section that produces ELK edges (search for `elkEdges` or `targets:` / `sources:`). In that loop, for each edge with a label, set the ELK `org.eclipse.elk.edge.thickness` and `org.eclipse.elk.spacing.edgeLabel` plus a `labels` array. Minimal implementation: bump `org.eclipse.elk.spacing.nodeNode` on the layout if any edge has a long label.

Concrete: at the layout-options assembly site (search for `org.eclipse.elk.layered.spacing.nodeNodeBetweenLayers`), add:

```typescript
// DRW-178 label-spacing reservation: collect arrow labels, scale nodeNode spacing.
import { measureLabelHeuristic } from "@shemma/domain";
let maxLabelWidth = 0;
for (const s of shapes) {
  if (s.type !== "arrow") continue;
  const text = extractArrowLabel(s);
  if (!text) continue;
  const m = measureLabelHeuristic(text, { maxWidth: 200, maxLines: 3 });
  if (m.width > maxLabelWidth) maxLabelWidth = m.width;
}
const labelSpacingPx = maxLabelWidth > 0 ? maxLabelWidth + 24 : 0;
// existing line:
//   "org.eclipse.elk.layered.spacing.nodeNodeBetweenLayers": "60"
// → adjust to:
const layerSpacing = Math.max(60, labelSpacingPx);
elkLayoutOptions["org.eclipse.elk.layered.spacing.nodeNodeBetweenLayers"] = String(layerSpacing);
```

(The exact variable name `elkLayoutOptions` may differ — adapt to actual code. Read the file around the spacing line to apply.)

- [ ] **Step 6: Run — verify PASS**

Run: `bun --cwd apps/backend test tests/domain/layout-label-spacing.test.ts`
Expected: PASS.

- [ ] **Step 7: Run all backend tests**

Run: `bun --cwd apps/backend test`
Expected: all green. If existing layout snapshot tests break because spacing increased, update snapshots (they were calibrated without label reservation).

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/domain/layout.ts apps/backend/tests/domain/layout-label-spacing.test.ts
git commit -m "feat(drw-178): reserve edge layer spacing for arrow-label width"
```

---

### Task 1.5 — Live verification of Phase 1

Manual check, not automated. Captures phase-end visual evidence.

- [ ] **Step 1: Restart backend with Phase 1 changes**

Run: `pkill -f 'bun apps/backend/src/index.ts' || true; sleep 1; SHEMMA_PROFILE=release bun apps/backend/src/index.ts > /tmp/shemma-backend.log 2>&1 &`
Wait 3 seconds.
Verify: `curl -s http://localhost:8787/api/health | head -3` shows `"ok":true`.

- [ ] **Step 2: Create fresh room from DRW-173 mermaid**

In the browser already at `http://localhost:5173/?space=di-draw&room=drw-178-phase1-verify`, run via chrome-devtools evaluate:

```javascript
fetch('/api/schema/create?space=di-draw&room=drw-178-phase1-verify', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ mermaid: /* paste content of docs/references/routing-comparison/drw-173-source.mmd */ }),
}).then(r => r.json())
```

- [ ] **Step 3: Take full-page screenshot**

Save to `docs/references/drw-178-followup/phase1-verify-drw173.png`.

- [ ] **Step 4: Verify all arrows are `kind:"elbow"`**

```javascript
window.__editor.store.allRecords().filter(r => r.typeName === 'shape' && r.type === 'arrow').map(a => a.props.kind)
```
Expected: every element is "elbow".

- [ ] **Step 5: Compare visually with `docs/references/routing-comparison/elk-ortho-reference-sample.png`**

Document differences in `docs/references/drw-178-followup/phase1-verify-notes.md` (free-form). Acceptance: no regressions vs current baseline `shemma-current-baseline.png`; arrows are visibly angular not curved.

- [ ] **Step 6: Commit verification artifacts**

```bash
git add docs/references/drw-178-followup/phase1-verify-*.{png,md}
git commit -m "docs(drw-178): phase 1 live verification artifacts"
```

---

## Phase 2 — Elbow midpoint distribution + container direction heuristic

### Task 2.1 — Add `computeElbowMidpoints` in backend

**Files:**
- Create: `apps/backend/src/domain/midpoints.ts`
- Create: `apps/backend/src/domain/midpoints.test.ts`

Algorithm: group arrows by `(sourceId, sourceSide, targetId, targetSide)`. In each group, sort stably and assign `elbowMidPoint = (i+1)/(N+1)`. Sides come from `arrow.meta.didrawSourcePort/TargetPort` (written by DRW-172 `computeAnchors`).

- [ ] **Step 1: Write failing test — three arrows with same endpoint sides get distributed midpoints**

Create `apps/backend/src/domain/midpoints.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { computeElbowMidpoints } from "./midpoints";
import type { TLStoreSnapshot } from "../store-types";

function makeArrow(id: string, srcSide: string, dstSide: string, srcId: string, dstId: string): any {
  return {
    id, typeName: "shape", type: "arrow", x: 0, y: 0, parentId: "page:page",
    index: "a1", isLocked: false, opacity: 1, rotation: 0,
    props: { kind: "elbow", elbowMidPoint: 0.5 },
    meta: { didrawSourcePort: srcSide, didrawTargetPort: dstSide },
  };
}

describe("computeElbowMidpoints", () => {
  test("single arrow gets default 0.5", () => {
    const store = { store: { "shape:a1": makeArrow("shape:a1", "right", "left", "shape:A", "shape:B") }, schema: { schemaVersion: 1 } } as unknown as TLStoreSnapshot;
    const batch = computeElbowMidpoints(store);
    expect(Object.keys(batch.updated).length).toBe(0); // no change — already 0.5
  });

  test("three arrows same source/target sides get 0.25/0.5/0.75", () => {
    const store = { store: {
      "shape:a1": makeArrow("shape:a1", "right", "top", "shape:A", "shape:B"),
      "shape:a2": makeArrow("shape:a2", "right", "top", "shape:A", "shape:B"),
      "shape:a3": makeArrow("shape:a3", "right", "top", "shape:A", "shape:B"),
    }, schema: { schemaVersion: 1 } } as unknown as TLStoreSnapshot;
    const batch = computeElbowMidpoints(store);
    const mids = ["shape:a1", "shape:a2", "shape:a3"].map(id => (batch.updated[id]?.[1] as any)?.props?.elbowMidPoint ?? 0.5);
    expect(mids).toEqual([0.25, 0.5, 0.75]);
  });

  test("different sides don't share a group", () => {
    const store = { store: {
      "shape:a1": makeArrow("shape:a1", "right", "top", "shape:A", "shape:B"),
      "shape:a2": makeArrow("shape:a2", "right", "bottom", "shape:A", "shape:B"), // different target side
    }, schema: { schemaVersion: 1 } } as unknown as TLStoreSnapshot;
    const batch = computeElbowMidpoints(store);
    // both single-member groups → each stays at 0.5 → no update
    expect(Object.keys(batch.updated).length).toBe(0);
  });

  test("arrows without port meta are skipped", () => {
    const a: any = makeArrow("shape:a1", "right", "left", "shape:A", "shape:B");
    delete a.meta.didrawSourcePort;
    const store = { store: { "shape:a1": a }, schema: { schemaVersion: 1 } } as unknown as TLStoreSnapshot;
    const batch = computeElbowMidpoints(store);
    expect(Object.keys(batch.updated).length).toBe(0);
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

Run: `bun --cwd apps/backend test src/domain/midpoints.test.ts`
Expected: error "Cannot find module".

- [ ] **Step 3: Implement `midpoints.ts`**

```typescript
// apps/backend/src/domain/midpoints.ts
//
// DRW-178: distribute elbowMidPoint values among arrows that share the
// same (sourceId, sourceSide, targetId, targetSide). Within each group
// arrows get mid values (i+1)/(N+1) — symmetric, matching DRW-172 anchor
// distribution. Singletons stay at 0.5 (no-op).

import type { StoreChangeBatch, TLRecord, TLStoreSnapshot } from "../store-types";

type ArrowRec = TLRecord & {
  type?: string;
  props?: { elbowMidPoint?: number; kind?: string };
  meta?: { didrawSourcePort?: string; didrawTargetPort?: string };
};

const EPS = 1e-6;

export function computeElbowMidpoints(store: TLStoreSnapshot): StoreChangeBatch {
  const updated: Record<string, [TLRecord, TLRecord]> = {};
  const arrows: ArrowRec[] = [];
  for (const id in store.store) {
    const r = store.store[id] as ArrowRec | undefined;
    if (!r || r.typeName !== "shape" || r.type !== "arrow") continue;
    if (r.props?.kind !== "elbow") continue;
    if (!r.meta?.didrawSourcePort || !r.meta?.didrawTargetPort) continue;
    arrows.push(r);
  }

  // Find source/target shape ids from bindings.
  type SourceTarget = { src: string | undefined; dst: string | undefined };
  const endpointsByArrow = new Map<string, SourceTarget>();
  for (const id in store.store) {
    const b = store.store[id] as TLRecord & {
      fromId?: string;
      toId?: string;
      props?: { terminal?: string };
    } | undefined;
    if (!b || b.typeName !== "binding" || b.type !== "arrow") continue;
    if (typeof b.fromId !== "string") continue;
    const entry = endpointsByArrow.get(b.fromId) ?? { src: undefined, dst: undefined };
    if (b.props?.terminal === "start") entry.src = b.toId;
    else if (b.props?.terminal === "end") entry.dst = b.toId;
    endpointsByArrow.set(b.fromId, entry);
  }

  const groups = new Map<string, ArrowRec[]>();
  for (const a of arrows) {
    const ep = endpointsByArrow.get(a.id);
    if (!ep?.src || !ep?.dst) continue;
    const key = `${ep.src}|${a.meta!.didrawSourcePort}|${ep.dst}|${a.meta!.didrawTargetPort}`;
    const arr = groups.get(key) ?? [];
    arr.push(a);
    groups.set(key, arr);
  }

  for (const [, group] of groups) {
    if (group.length < 2) continue; // singleton stays 0.5
    group.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const n = group.length;
    for (let i = 0; i < n; i++) {
      const arrow = group[i]!;
      const newMid = (i + 1) / (n + 1);
      const oldMid = arrow.props?.elbowMidPoint ?? 0.5;
      if (Math.abs(oldMid - newMid) < EPS) continue;
      const newRec = {
        ...arrow,
        props: { ...arrow.props, elbowMidPoint: newMid },
      } as TLRecord;
      updated[arrow.id] = [arrow as TLRecord, newRec];
    }
  }

  return { added: {}, updated, removed: {} };
}
```

- [ ] **Step 4: Run tests — verify PASS**

Run: `bun --cwd apps/backend test src/domain/midpoints.test.ts`
Expected: 4 pass.

- [ ] **Step 5: Run full backend suite**

Run: `bun --cwd apps/backend test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/domain/midpoints.ts apps/backend/src/domain/midpoints.test.ts
git commit -m "feat(drw-178): computeElbowMidpoints — (i+1)/(N+1) per same-sides group"
```

---

### Task 2.2 — Add `determineContainerDirection` heuristic

**Files:**
- Create: `apps/backend/src/domain/directions.ts`
- Create: `apps/backend/src/domain/directions.test.ts`

Heuristic: if `meta.didrawDirection` set → return it (explicit override). Else count external in/out edges crossing container border per cardinal side (top/bottom/left/right). Pick direction so the side with most external traffic receives the closest child.

- [ ] **Step 1: Write failing tests**

Create `apps/backend/src/domain/directions.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { determineContainerDirection } from "./directions";

describe("determineContainerDirection", () => {
  test("respects explicit meta.didrawDirection", () => {
    expect(determineContainerDirection({
      container: { id: "c1", meta: { didrawDirection: "LR" } } as any,
      edgesIn: [], edgesOut: [],
    })).toBe("LR");
  });

  test("default TB when no edges", () => {
    expect(determineContainerDirection({
      container: { id: "c1", meta: {} } as any,
      edgesIn: [], edgesOut: [],
    })).toBe("TB");
  });

  test("majority horizontal external edges → LR", () => {
    expect(determineContainerDirection({
      container: { id: "c1", meta: {} } as any,
      edgesIn: [{ side: "left" }, { side: "left" }, { side: "right" }],
      edgesOut: [],
    })).toBe("LR");
  });

  test("majority vertical external edges → TB", () => {
    expect(determineContainerDirection({
      container: { id: "c1", meta: {} } as any,
      edgesIn: [{ side: "top" }, { side: "top" }],
      edgesOut: [{ side: "bottom" }],
    })).toBe("TB");
  });

  test("tie → defaults to TB", () => {
    expect(determineContainerDirection({
      container: { id: "c1", meta: {} } as any,
      edgesIn: [{ side: "left" }],
      edgesOut: [{ side: "top" }],
    })).toBe("TB");
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

Run: `bun --cwd apps/backend test src/domain/directions.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement `directions.ts`**

```typescript
// apps/backend/src/domain/directions.ts
//
// DRW-178: heuristic for choosing TB vs LR per container when mermaid
// did not provide an explicit direction. Uses cardinal-side counts of
// edges that cross the container border.

import type { TLRecord } from "../store-types";

export type Direction = "TB" | "LR";

export type CardinalSide = "top" | "bottom" | "left" | "right";

export type ExternalEdge = { side: CardinalSide };

export type DetermineInput = {
  container: TLRecord & { meta?: { didrawDirection?: string } };
  edgesIn: ExternalEdge[];
  edgesOut: ExternalEdge[];
};

export function determineContainerDirection(input: DetermineInput): Direction {
  const explicit = input.container.meta?.didrawDirection;
  if (explicit === "LR" || explicit === "TB") return explicit;

  let horizontal = 0;
  let vertical = 0;
  for (const e of input.edgesIn.concat(input.edgesOut)) {
    if (e.side === "left" || e.side === "right") horizontal += 1;
    else vertical += 1;
  }
  return horizontal > vertical ? "LR" : "TB";
}
```

- [ ] **Step 4: Run tests — verify PASS**

Run: `bun --cwd apps/backend test src/domain/directions.test.ts`
Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/domain/directions.ts apps/backend/src/domain/directions.test.ts
git commit -m "feat(drw-178): determineContainerDirection heuristic (cardinal counts)"
```

---

### Task 2.3 — Integrate midpoints + directions into layout pipeline

**Files:**
- Modify: `apps/backend/src/domain/layout.ts` (pipeline end of `runLayout`, after `computeAnchors`)
- Modify: `apps/backend/src/routes/layout.ts` (so /api/layout still works end-to-end)
- Test: `apps/backend/src/domain/layout-pipeline-integration.test.ts` (new)

For container direction: read each container's `meta.didrawDirection`; if absent, count cross-border edges and set it once before ELK runs. For midpoints: call `computeElbowMidpoints` after `computeAnchors`, merge results into the batch.

- [ ] **Step 1: Write integration test**

```typescript
// apps/backend/src/domain/layout-pipeline-integration.test.ts
import { describe, expect, test } from "bun:test";
import { runLayout } from "./layout";
import type { TLStoreSnapshot } from "../store-types";

// Helper: A→B with two parallel arrows. After layout both arrows should have
// distinct elbowMidPoint values.
function makeTwoParallelArrows(): TLStoreSnapshot {
  const baseShape = (id: string, x: number, y: number) => ({
    id, typeName: "shape", type: "geo", x, y, parentId: "shape:frame",
    index: "a1", isLocked: false, opacity: 1, rotation: 0,
    props: { geo: "rectangle", w: 120, h: 120 }, meta: {},
  });
  const arrow = (id: string) => ({
    id, typeName: "shape", type: "arrow", x: 0, y: 0, parentId: "shape:frame",
    index: "a3", isLocked: false, opacity: 1, rotation: 0,
    props: { kind: "elbow", color: "black", fill: "none", dash: "draw", size: "m", labelColor: "black", font: "draw", start: { x: 0, y: 0 }, end: { x: 0, y: 0 }, bend: 0, elbowMidPoint: 0.5, labelPosition: 0.5, scale: 1, richText: { type: "doc", content: [{ type: "paragraph" }] }, arrowheadStart: "none", arrowheadEnd: "arrow" }, meta: {},
  });
  const binding = (id: string, fromId: string, toId: string, terminal: string) => ({
    id, typeName: "binding", type: "arrow", fromId, toId,
    props: { terminal, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: "none" },
  });
  return {
    store: {
      "shape:frame": { id: "shape:frame", typeName: "shape", type: "frame", x: 0, y: 0, parentId: "page:page", index: "a1", isLocked: false, opacity: 1, rotation: 0, props: { w: 600, h: 300, name: "F" }, meta: {} },
      "shape:A": baseShape("shape:A", 0, 0),
      "shape:B": baseShape("shape:B", 400, 0),
      "shape:a1": arrow("shape:a1"),
      "shape:a2": arrow("shape:a2"),
      "binding:s1": binding("binding:s1", "shape:a1", "shape:A", "start"),
      "binding:e1": binding("binding:e1", "shape:a1", "shape:B", "end"),
      "binding:s2": binding("binding:s2", "shape:a2", "shape:A", "start"),
      "binding:e2": binding("binding:e2", "shape:a2", "shape:B", "end"),
    },
    schema: { schemaVersion: 1, sequenceNumber: 0, storeVersion: 1, recordVersions: {} },
  } as unknown as TLStoreSnapshot;
}

describe("layout pipeline integration (Phase 2)", () => {
  test("parallel arrows get distinct elbow midpoints", async () => {
    const store = makeTwoParallelArrows();
    const res = await runLayout(store, { mode: "layered-lr", scope: "all" }, new Map());
    const a1 = (res.batch.updated["shape:a1"]?.[1] as any)?.props?.elbowMidPoint;
    const a2 = (res.batch.updated["shape:a2"]?.[1] as any)?.props?.elbowMidPoint;
    expect(a1).toBeDefined();
    expect(a2).toBeDefined();
    expect(a1).not.toBe(a2);
    expect([a1, a2].sort()).toEqual([1/3, 2/3]);
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

Run: `bun --cwd apps/backend test src/domain/layout-pipeline-integration.test.ts`
Expected: FAIL (a1 === a2 because midpoints not wired).

- [ ] **Step 3: Wire `computeElbowMidpoints` into `runLayout` after `computeAnchors`**

In `apps/backend/src/domain/layout.ts`, near the bottom of `runLayout` (after the existing anchor step or at the final batch assembly), add:

```typescript
// DRW-178 elbow midpoint distribution — runs after computeAnchors so it
// can read meta.didrawSourcePort/TargetPort.
import { computeElbowMidpoints } from "./midpoints";

// ... existing pipeline produces `batch` and `anchorBatch`
const storeAfterAnchors = applyStoreChanges(applyStoreChanges(store, batch), anchorBatch);
const midpointBatch = computeElbowMidpoints(storeAfterAnchors);
const fullBatch = mergeBatch(mergeBatch(batch, anchorBatch), midpointBatch);
return { batch: fullBatch, affected, ... };
```

(Adapt to the actual variable names; `mergeBatch` should already exist or be defined nearby.)

- [ ] **Step 4: Run integration test — verify PASS**

Run: `bun --cwd apps/backend test src/domain/layout-pipeline-integration.test.ts`
Expected: pass.

- [ ] **Step 5: Run full backend suite**

Run: `bun --cwd apps/backend test`
Expected: all green. If existing layout tests assert specific elbowMidPoint=0.5 on multi-arrow rooms, update to expected distributed values.

- [ ] **Step 6: Add direction heuristic integration (containers without explicit direction)**

In `runLayout` near the start (before ELK call), iterate containers; for any container whose `meta.didrawDirection` is absent, compute external in/out edges crossing its border, call `determineContainerDirection`, and write `meta.didrawDirection` via the result batch. This makes ELK use the chosen direction in subsequent layered pass.

Concrete: add helper `inferContainerDirections(store): StoreChangeBatch` near the top of `layout.ts`. It walks all containers, classifies crossing edges by side, and emits batch updates. Call it before the ELK invocation; merge result into the running batch.

- [ ] **Step 7: Add integration test for direction inference**

In the same `layout-pipeline-integration.test.ts`, add another test:

```typescript
test("container without explicit direction gets meta.didrawDirection inferred", async () => {
  const store: any = makeTwoParallelArrows();
  // baseline has no didrawDirection on the frame
  const res = await runLayout(store, { mode: "layered-lr", scope: "all" }, new Map());
  const updatedFrame = res.batch.updated["shape:frame"]?.[1] as any;
  expect(updatedFrame?.meta?.didrawDirection).toBeDefined();
});
```

Run: `bun --cwd apps/backend test src/domain/layout-pipeline-integration.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/domain/layout.ts apps/backend/src/domain/layout-pipeline-integration.test.ts
git commit -m "feat(drw-178): wire elbow midpoint distribution and direction inference"
```

---

### Task 2.4 — Live verification Phase 2

- [ ] **Step 1: Restart backend with Phase 2 changes** (same command as Task 1.5 Step 1).

- [ ] **Step 2: Create fresh room `drw-178-phase2-verify` from DRW-173 mermaid** (same call as Task 1.5 Step 2).

- [ ] **Step 3: Trigger layout pass**

```javascript
fetch('/api/layout?room=drw-178-phase2-verify&space=di-draw', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ mode: 'layered-lr', scope: 'all', spacing: 'normal' }),
}).then(r => r.json())
```

- [ ] **Step 4: Take screenshot, save to `docs/references/drw-178-followup/phase2-verify-drw173.png`**

- [ ] **Step 5: Verify Оркестрация subgraph has LR direction** (read its `meta.didrawDirection` from store dump)

- [ ] **Step 6: Visual diff vs Phase 1 result and elk-ortho-reference**

Document in `docs/references/drw-178-followup/phase2-verify-notes.md`.

- [ ] **Step 7: Commit verification artifacts**

```bash
git add docs/references/drw-178-followup/phase2-verify-*.{png,md}
git commit -m "docs(drw-178): phase 2 live verification artifacts"
```

---

## Phase 3 — LayoutParams parameterization

### Task 3.1 — Define `LayoutParams` type + defaults

**Files:**
- Create: `packages/shemma-domain/src/layout-params.ts`
- Create: `packages/shemma-domain/src/layout-params.test.ts`
- Modify: `packages/shemma-domain/src/index.ts` (re-export)

- [ ] **Step 1: Write failing test**

```typescript
// packages/shemma-domain/src/layout-params.test.ts
import { describe, expect, test } from "bun:test";
import { applyLayoutParamsDefaults, validateLayoutParams, type LayoutParams } from "./layout-params";

describe("layout params", () => {
  test("applyLayoutParamsDefaults fills missing fields", () => {
    const full = applyLayoutParamsDefaults({});
    expect(full.nodeMinWidth).toBe(120);
    expect(full.edgeSpacing).toBe(16);
    expect(full.defaultDirection).toBe("TB");
    expect(full.autoDirectionEnabled).toBe(true);
  });

  test("user values override defaults", () => {
    const full = applyLayoutParamsDefaults({ nodeMinWidth: 200, defaultDirection: "LR" });
    expect(full.nodeMinWidth).toBe(200);
    expect(full.defaultDirection).toBe("LR");
    expect(full.nodeMinHeight).toBe(60); // default kept
  });

  test("validateLayoutParams rejects negative values", () => {
    expect(() => validateLayoutParams({ nodeMinWidth: -10 } as Partial<LayoutParams>)).toThrow();
  });

  test("validateLayoutParams accepts empty object", () => {
    expect(() => validateLayoutParams({})).not.toThrow();
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

Run: `bun --cwd packages/shemma-domain test src/layout-params.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement `layout-params.ts`**

```typescript
// packages/shemma-domain/src/layout-params.ts
export type LayoutParams = {
  nodeMinWidth: number;
  nodeMinHeight: number;
  nodePadding: number;
  containerPadding: number;
  containerLabelHeight: number;
  edgeSpacing: number;
  edgeNodeSpacing: number;
  edgeLabelMaxWidth: number;
  edgeLabelMaxLines: number;
  edgeLabelMargin: number;
  edgeLabelFontSize: number;
  defaultDirection: "TB" | "LR";
  autoDirectionEnabled: boolean;
  anchorOffsetMode: "distribute" | "center";
  midpointDistribution: "even" | "fixed-0.5";
};

export const DEFAULT_LAYOUT_PARAMS: LayoutParams = {
  nodeMinWidth: 120,
  nodeMinHeight: 60,
  nodePadding: 16,
  containerPadding: 24,
  containerLabelHeight: 32,
  edgeSpacing: 16,
  edgeNodeSpacing: 20,
  edgeLabelMaxWidth: 200,
  edgeLabelMaxLines: 3,
  edgeLabelMargin: 12,
  edgeLabelFontSize: 16,
  defaultDirection: "TB",
  autoDirectionEnabled: true,
  anchorOffsetMode: "distribute",
  midpointDistribution: "even",
};

export function applyLayoutParamsDefaults(partial: Partial<LayoutParams>): LayoutParams {
  return { ...DEFAULT_LAYOUT_PARAMS, ...partial };
}

export function validateLayoutParams(p: Partial<LayoutParams>): void {
  const numericFields: Array<keyof LayoutParams> = [
    "nodeMinWidth", "nodeMinHeight", "nodePadding", "containerPadding",
    "containerLabelHeight", "edgeSpacing", "edgeNodeSpacing",
    "edgeLabelMaxWidth", "edgeLabelMaxLines", "edgeLabelMargin", "edgeLabelFontSize",
  ];
  for (const k of numericFields) {
    const v = p[k];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new Error(`LayoutParams.${String(k)} must be a non-negative finite number; got ${v}`);
    }
  }
}
```

- [ ] **Step 4: Re-export from index**

```typescript
// packages/shemma-domain/src/index.ts (append)
export {
  type LayoutParams,
  DEFAULT_LAYOUT_PARAMS,
  applyLayoutParamsDefaults,
  validateLayoutParams,
} from "./layout-params";
```

- [ ] **Step 5: Run tests — verify PASS**

Run: `bun --cwd packages/shemma-domain test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/shemma-domain/src/layout-params.ts packages/shemma-domain/src/layout-params.test.ts packages/shemma-domain/src/index.ts
git commit -m "feat(drw-178): LayoutParams type with defaults + validator"
```

---

### Task 3.2 — Thread `LayoutParams` through layout pipeline

**Files:**
- Modify: `apps/backend/src/domain/layout.ts` (`runLayout` signature, internal helpers)
- Modify: `apps/backend/src/domain/midpoints.ts` (accept params)
- Modify: `apps/backend/src/domain/directions.ts` (accept params)

- [ ] **Step 1: Add `params` argument to `runLayout`**

Signature change:

```typescript
import { applyLayoutParamsDefaults, type LayoutParams } from "@shemma/domain";

export async function runLayout(
  store: TLStoreSnapshot,
  hint: LayoutHint,
  index: Map<string, string>,
  paramsPartial?: Partial<LayoutParams>,
): Promise<{ batch: StoreChangeBatch; affected: string[]; reason?: string }> {
  const params = applyLayoutParamsDefaults(paramsPartial ?? {});
  // ... pass `params` to inner helpers
}
```

- [ ] **Step 2: Replace hard-coded numbers with `params.*`**

Find all instances where hardcoded numbers are used for layout (search for `60`, `16`, `120` etc. — be selective). Replace with `params.nodeMinHeight`, `params.edgeSpacing`, `params.nodeMinWidth` respectively. For ELK options assembly, use `params.edgeNodeSpacing` etc.

For the label-width spacing computation introduced in Task 1.4, replace `maxWidth: 200, maxLines: 3` with `maxWidth: params.edgeLabelMaxWidth, maxLines: params.edgeLabelMaxLines, fontSize: params.edgeLabelFontSize`.

- [ ] **Step 3: Update midpoints.ts to accept params (no-op if mode is "fixed-0.5")**

```typescript
import type { LayoutParams } from "@shemma/domain";
export function computeElbowMidpoints(store: TLStoreSnapshot, params?: Pick<LayoutParams, "midpointDistribution">): StoreChangeBatch {
  if (params?.midpointDistribution === "fixed-0.5") {
    return { added: {}, updated: {}, removed: {} };
  }
  // existing logic
}
```

- [ ] **Step 4: Update directions.ts to honour `autoDirectionEnabled`**

```typescript
import type { LayoutParams } from "@shemma/domain";
export function determineContainerDirection(
  input: DetermineInput,
  params?: Pick<LayoutParams, "defaultDirection" | "autoDirectionEnabled">,
): Direction {
  const explicit = input.container.meta?.didrawDirection;
  if (explicit === "LR" || explicit === "TB") return explicit;
  if (params && params.autoDirectionEnabled === false) {
    return params.defaultDirection;
  }
  // existing logic
}
```

- [ ] **Step 5: Add test — overriding `midpointDistribution:"fixed-0.5"` skips midpoint changes**

Add to `midpoints.test.ts`:

```typescript
test("midpointDistribution=fixed-0.5 returns empty batch", () => {
  const store = { store: {
    "shape:a1": makeArrow("shape:a1", "right", "top", "shape:A", "shape:B"),
    "shape:a2": makeArrow("shape:a2", "right", "top", "shape:A", "shape:B"),
  }, schema: { schemaVersion: 1 } } as unknown as TLStoreSnapshot;
  const batch = computeElbowMidpoints(store, { midpointDistribution: "fixed-0.5" });
  expect(Object.keys(batch.updated).length).toBe(0);
});
```

- [ ] **Step 6: Run all tests**

Run: `bun --cwd apps/backend test && bun --cwd packages/shemma-domain test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/domain/layout.ts apps/backend/src/domain/midpoints.ts apps/backend/src/domain/midpoints.test.ts apps/backend/src/domain/directions.ts
git commit -m "feat(drw-178): thread LayoutParams through layout pipeline"
```

---

### Task 3.3 — Accept `params` in `/api/layout` body

**Files:**
- Modify: `apps/backend/src/routes/layout.ts`
- Modify: `apps/backend/src/routes/layout.test.ts` (if doesn't exist, create)

- [ ] **Step 1: Update endpoint body parser**

```typescript
// apps/backend/src/routes/layout.ts
import { validateLayoutParams, type LayoutParams } from "@shemma/domain";

const body = (await c.req.json().catch(() => ({}))) as {
  mode?: string;
  scope?: string;
  spacing?: string;
  params?: Partial<LayoutParams>;
};

if (body.params) {
  try { validateLayoutParams(body.params); }
  catch (e) { return c.json({ ok: false, error: (e as Error).message }, 400); }
}

// pass body.params into runLayout:
lr = await runLayout(r.store, hint, r.didrawIndex, body.params);
```

- [ ] **Step 2: Add test — invalid params return 400**

```typescript
// apps/backend/src/routes/layout.test.ts (extend or create)
test("invalid LayoutParams.nodeMinWidth returns 400", async () => {
  // ... setup app + room ...
  const res = await app.request("/api/layout?room=test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ params: { nodeMinWidth: -1 } }),
  });
  expect(res.status).toBe(400);
});
```

- [ ] **Step 3: Run — verify PASS**

Run: `bun --cwd apps/backend test src/routes/layout.test.ts`

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/routes/layout.ts apps/backend/src/routes/layout.test.ts
git commit -m "feat(drw-178): /api/layout accepts optional LayoutParams in body"
```

---

### Task 3.4 — Determinism integration test (Phase 3 acceptance)

**Files:**
- Create: `apps/backend/src/domain/layout-determinism.test.ts`

- [ ] **Step 1: Write test that scrambles positions twice, runs layout, checks identical output**

```typescript
// apps/backend/src/domain/layout-determinism.test.ts
import { describe, expect, test } from "bun:test";
import { runLayout } from "./layout";
import type { TLStoreSnapshot } from "../store-types";

function chainStore(positions: Array<{ x: number; y: number }>): TLStoreSnapshot {
  const ids = ["A", "B", "C", "D"];
  const store: Record<string, unknown> = {
    "shape:frame": { id: "shape:frame", typeName: "shape", type: "frame", x: 0, y: 0, parentId: "page:page", index: "a1", isLocked: false, opacity: 1, rotation: 0, props: { w: 800, h: 400, name: "F" }, meta: {} },
  };
  ids.forEach((id, i) => {
    store[`shape:${id}`] = { id: `shape:${id}`, typeName: "shape", type: "geo", x: positions[i]!.x, y: positions[i]!.y, parentId: "shape:frame", index: "a1", isLocked: false, opacity: 1, rotation: 0, props: { geo: "rectangle", w: 120, h: 60 }, meta: {} };
  });
  // Chain arrows A→B→C→D
  for (let i = 0; i < ids.length - 1; i++) {
    const aId = `shape:a${i}`;
    store[aId] = { id: aId, typeName: "shape", type: "arrow", x: 0, y: 0, parentId: "shape:frame", index: "a3", isLocked: false, opacity: 1, rotation: 0, props: { kind: "elbow", color: "black", fill: "none", dash: "draw", size: "m", labelColor: "black", font: "draw", start: { x: 0, y: 0 }, end: { x: 0, y: 0 }, bend: 0, elbowMidPoint: 0.5, labelPosition: 0.5, scale: 1, richText: { type: "doc", content: [{ type: "paragraph" }] }, arrowheadStart: "none", arrowheadEnd: "arrow" }, meta: {} };
    store[`binding:s${i}`] = { id: `binding:s${i}`, typeName: "binding", type: "arrow", fromId: aId, toId: `shape:${ids[i]}`, props: { terminal: "start", normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: "none" } };
    store[`binding:e${i}`] = { id: `binding:e${i}`, typeName: "binding", type: "arrow", fromId: aId, toId: `shape:${ids[i + 1]}`, props: { terminal: "end", normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: "none" } };
  }
  return { store, schema: { schemaVersion: 1, sequenceNumber: 0, storeVersion: 1, recordVersions: {} } } as unknown as TLStoreSnapshot;
}

describe("layout determinism", () => {
  test("same topology, different starting positions → same final positions", async () => {
    const s1 = chainStore([{ x: 100, y: 100 }, { x: 300, y: 50 }, { x: 50, y: 200 }, { x: 400, y: 250 }]);
    const s2 = chainStore([{ x: 500, y: 200 }, { x: 50, y: 100 }, { x: 250, y: 50 }, { x: 100, y: 250 }]);

    const r1 = await runLayout(s1, { mode: "layered-lr", scope: "all" }, new Map());
    const r2 = await runLayout(s2, { mode: "layered-lr", scope: "all" }, new Map());

    const final = (res: typeof r1, original: typeof s1) => {
      const ids = ["A", "B", "C", "D"];
      return ids.map(id => {
        const updated = res.batch.updated[`shape:${id}`]?.[1] as any;
        const src = original.store[`shape:${id}`] as any;
        return { id, x: updated?.x ?? src.x, y: updated?.y ?? src.y };
      });
    };

    expect(final(r1, s1)).toEqual(final(r2, s2));
  });
});
```

- [ ] **Step 2: Run — verify PASS**

Run: `bun --cwd apps/backend test src/domain/layout-determinism.test.ts`
Expected: passes (ELK is deterministic, our pipeline doesn't introduce randomness).

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/domain/layout-determinism.test.ts
git commit -m "test(drw-178): layout pipeline determinism — same topology = same result"
```

---

## Phase 4 — Smart-insert endpoint

### Task 4.1 — `findEmptySlot` + expansion rule

**Files:**
- Create: `apps/backend/src/domain/empty-space.ts`
- Create: `apps/backend/src/domain/empty-space.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// apps/backend/src/domain/empty-space.test.ts
import { describe, expect, test } from "bun:test";
import { findEmptySlot, computeExpansion } from "./empty-space";

describe("findEmptySlot", () => {
  test("returns center for empty parent", () => {
    const slot = findEmptySlot(
      { w: 400, h: 300 }, [],
      { w: 100, h: 50 }, 10,
    );
    expect(slot).toBeDefined();
    // Center-biased: roughly center placement
    expect(slot!.x).toBeGreaterThan(100);
    expect(slot!.x).toBeLessThan(200);
  });

  test("avoids occupied region", () => {
    const slot = findEmptySlot(
      { w: 400, h: 300 },
      [{ x: 50, y: 50, w: 200, h: 100 }],
      { w: 100, h: 50 }, 10,
    );
    expect(slot).toBeDefined();
    // Must not overlap [50..250]x[50..150] with 10px padding
    const occ = { x: 50, y: 50, w: 200, h: 100 };
    const overlap =
      slot!.x + 100 + 10 > occ.x &&
      occ.x + occ.w + 10 > slot!.x &&
      slot!.y + 50 + 10 > occ.y &&
      occ.y + occ.h + 10 > slot!.y;
    expect(overlap).toBe(false);
  });

  test("returns null when no space fits", () => {
    const slot = findEmptySlot(
      { w: 100, h: 100 },
      [{ x: 0, y: 0, w: 100, h: 100 }],
      { w: 100, h: 100 }, 10,
    );
    expect(slot).toBeNull();
  });
});

describe("computeExpansion", () => {
  test("LR direction expands width", () => {
    const e = computeExpansion(
      { w: 400, h: 300 }, { w: 120, h: 60 }, 20, "LR",
    );
    expect(e.dw).toBeGreaterThan(0);
    expect(e.dh).toBe(0);
    expect(e.position.x + 120 + 20).toBeLessThanOrEqual(400 + e.dw);
  });

  test("TB direction expands height", () => {
    const e = computeExpansion(
      { w: 400, h: 300 }, { w: 120, h: 60 }, 20, "TB",
    );
    expect(e.dh).toBeGreaterThan(0);
    expect(e.dw).toBe(0);
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

Run: `bun --cwd apps/backend test src/domain/empty-space.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement `empty-space.ts`**

```typescript
// apps/backend/src/domain/empty-space.ts
//
// DRW-178: light-layout helpers for smart-insert.

export type Rect = { x: number; y: number; w: number; h: number };
export type Size = { w: number; h: number };
export type Slot = { x: number; y: number };

const SCAN_STEP = 10;

export function findEmptySlot(
  parent: Size,
  occupants: Rect[],
  size: Size,
  padding: number,
): Slot | null {
  if (size.w + 2 * padding > parent.w) return null;
  if (size.h + 2 * padding > parent.h) return null;

  const candidates: Slot[] = [];
  for (let y = padding; y + size.h + padding <= parent.h; y += SCAN_STEP) {
    for (let x = padding; x + size.w + padding <= parent.w; x += SCAN_STEP) {
      const fits = occupants.every(o =>
        x + size.w + padding <= o.x ||
        o.x + o.w + padding <= x ||
        y + size.h + padding <= o.y ||
        o.y + o.h + padding <= y
      );
      if (fits) candidates.push({ x, y });
    }
  }
  if (!candidates.length) return null;
  const cx = parent.w / 2, cy = parent.h / 2;
  candidates.sort((a, b) =>
    Math.hypot(a.x + size.w / 2 - cx, a.y + size.h / 2 - cy) -
    Math.hypot(b.x + size.w / 2 - cx, b.y + size.h / 2 - cy)
  );
  return candidates[0]!;
}

export type Expansion = { dw: number; dh: number; position: Slot };

export function computeExpansion(
  parent: Size,
  size: Size,
  padding: number,
  direction: "TB" | "LR",
): Expansion {
  if (direction === "LR") {
    const dw = size.w + 2 * padding;
    return {
      dw, dh: 0,
      position: { x: parent.w + padding, y: Math.max(padding, parent.h / 2 - size.h / 2) },
    };
  }
  const dh = size.h + 2 * padding;
  return {
    dw: 0, dh,
    position: { x: Math.max(padding, parent.w / 2 - size.w / 2), y: parent.h + padding },
  };
}
```

- [ ] **Step 4: Run tests — verify PASS**

Run: `bun --cwd apps/backend test src/domain/empty-space.test.ts`
Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/domain/empty-space.ts apps/backend/src/domain/empty-space.test.ts
git commit -m "feat(drw-178): empty-space finder + expansion rule"
```

---

### Task 4.2 — `/api/smart-insert` endpoint

**Files:**
- Create: `apps/backend/src/routes/smart-insert.ts`
- Create: `apps/backend/src/routes/smart-insert.test.ts`
- Modify: `apps/backend/src/index.ts` (register route)

- [ ] **Step 1: Write failing test**

```typescript
// apps/backend/src/routes/smart-insert.test.ts
import { describe, expect, test, beforeEach } from "bun:test";
// import standard test fixtures used by other route tests (see schema.test.ts for pattern)

describe("POST /api/smart-insert", () => {
  test("returns position inside empty container", async () => {
    // setup app + room with a single container, no occupants
    // POST { containerId: "shape:frame", size: { w: 120, h: 60 } }
    // expect 200, response has { position: { x: number, y: number } }, no expansion
    // — concrete fixture wiring follows existing test patterns in schema.test.ts
  });

  test("expands container when no space fits", async () => {
    // setup room with container fully occupied
    // POST → expect 200, response has expansion: { dw or dh > 0 }
  });

  test("returns 404 for non-existent container", async () => {
    // expect 404
  });
});
```

(Adapt fixture setup from existing `apps/backend/src/routes/schema.test.ts`; reuse helpers if available.)

- [ ] **Step 2: Implement `smart-insert.ts`**

```typescript
// apps/backend/src/routes/smart-insert.ts
import { Hono } from "hono";
import { resolveRoomId } from "../rooms";
import { applyStoreChanges, rebuildDidrawIndex } from "../store-ops";
import type { StoreChangeBus } from "../types";
import { bundleForRequest } from "./_space-context";
import { findEmptySlot, computeExpansion } from "../domain/empty-space";

export function smartInsertRoutes(bus: StoreChangeBus) {
  return new Hono().post("/api/smart-insert", async (c) => {
    const rv = resolveRoomId(c.req.query("room"));
    if (!rv.ok) return c.json({ ok: false, error: rv.reason }, 422);
    const id = rv.id;
    const body = (await c.req.json().catch(() => ({}))) as {
      containerId?: string;
      size?: { w: number; h: number };
      biasDirection?: "TB" | "LR";
      padding?: number;
    };
    if (!body.containerId || !body.size) {
      return c.json({ ok: false, error: "containerId and size required" }, 400);
    }

    const { rooms, scheduleSave, space } = bundleForRequest(c);
    const r = await rooms.get(id);
    const container = r.store.store[body.containerId] as any;
    if (!container || container.typeName !== "shape") {
      return c.json({ ok: false, error: "container not found" }, 404);
    }
    const parentSize = { w: container.props.w, h: container.props.h };
    const padding = body.padding ?? 20;
    const occupants: Array<{ x: number; y: number; w: number; h: number }> = [];
    for (const recId in r.store.store) {
      const rec = r.store.store[recId] as any;
      if (rec?.typeName !== "shape") continue;
      if (rec.parentId !== body.containerId) continue;
      occupants.push({ x: rec.x ?? 0, y: rec.y ?? 0, w: rec.props?.w ?? 0, h: rec.props?.h ?? 0 });
    }

    const slot = findEmptySlot(parentSize, occupants, body.size, padding);
    if (slot) {
      return c.json({ ok: true, position: slot, expansion: null });
    }

    const direction = body.biasDirection ?? (container.meta?.didrawDirection as "TB" | "LR" | undefined) ?? "TB";
    const expansion = computeExpansion(parentSize, body.size, padding, direction);
    return c.json({ ok: true, position: expansion.position, expansion: { dw: expansion.dw, dh: expansion.dh } });
  });
}
```

- [ ] **Step 3: Register route in `apps/backend/src/index.ts`**

```typescript
import { smartInsertRoutes } from "./routes/smart-insert";
// in the app.route(...) section:
app.route("/", smartInsertRoutes(bus));
```

- [ ] **Step 4: Run tests — verify PASS**

Run: `bun --cwd apps/backend test src/routes/smart-insert.test.ts`
Expected: pass.

- [ ] **Step 5: Full suite**

Run: `bun --cwd apps/backend test`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/routes/smart-insert.ts apps/backend/src/routes/smart-insert.test.ts apps/backend/src/index.ts
git commit -m "feat(drw-178): POST /api/smart-insert — light insertion endpoint"
```

---

## Phase 5 — Final verification and release prep

### Task 5.1 — End-to-end live verification on DRW-173 graph

- [ ] **Step 1: Restart backend with all phases applied**

Same restart sequence as Task 1.5.

- [ ] **Step 2: Create fresh room `drw-178-final-verify` from DRW-173 mermaid**

Same fetch as Task 1.5 Step 2 with different room name.

- [ ] **Step 3: Trigger layout pass with default params**

```javascript
fetch('/api/layout?room=drw-178-final-verify&space=di-draw', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ mode: 'layered-lr', scope: 'all', spacing: 'normal' }),
}).then(r => r.json())
```

- [ ] **Step 4: Verify acceptance criteria from spec §6**

Run via chrome-devtools evaluate:

```javascript
const all = window.__editor.store.allRecords();
const arrows = all.filter(r => r.typeName === 'shape' && r.type === 'arrow');
const routed = all.filter(r => r.typeName === 'shape' && r.type === 'routed-arrow');
const elbowCount = arrows.filter(a => a.props.kind === 'elbow').length;
const containerDirs = all.filter(r => r.typeName === 'shape' && (r.type === 'schema-container' || r.type === 'frame')).map(c => ({ id: c.id, dir: c.meta?.didrawDirection }));
({ arrowsTotal: arrows.length, elbowCount, routedTotal: routed.length, containerDirs });
```

Expected: `routedTotal:0`, `arrowsTotal == elbowCount` (all native elbow), containers have inferred or explicit directions.

- [ ] **Step 5: Take full-page screenshot, save to `docs/references/drw-178-followup/final-verify-drw173.png`**

- [ ] **Step 6: Side-by-side comparison with `docs/references/routing-comparison/elk-ortho-reference-sample.png`**

Document in `docs/references/drw-178-followup/final-verify-notes.md`. Acceptance: visually comparable to elk-ortho-reference, no overflowing labels, no missing styling, container directions look reasonable.

- [ ] **Step 7: Commit verification artifacts**

```bash
git add docs/references/drw-178-followup/final-verify-*.{png,md}
git commit -m "docs(drw-178): final live verification artifacts"
```

---

### Task 5.2 — Quality review across all phases (single pass)

Per `feedback-batched-reviews`, single review at phase-end across full diff Phase 1–4.

- [ ] **Step 1: Generate full phase diff**

Run: `git log --oneline 2d6f792..HEAD`
Inspect: should list ~16-18 commits per task above.

- [ ] **Step 2: Read full diff**

Run: `git diff 2d6f792..HEAD --stat`
Identify any files with surprising size deltas.

- [ ] **Step 3: Run all test suites one more time**

Run: `bun --cwd packages/shemma-domain test && bun --cwd apps/backend test && bun --cwd packages/shemma-client test && bun --cwd packages/shemma-cli test && bun --cwd packages/shemma-mcp test`

Expected: all green.

- [ ] **Step 4: Open spec, walk through each acceptance criterion, mark satisfied/not**

Reference: `docs/superpowers/specs/2026-05-26-drw-178-followup-design.md` §6 (Open questions / risks). For each risk: documented mitigation? Acceptable residual?

- [ ] **Step 5: If anything found — apply targeted fix commit; do NOT re-run all tasks**

---

### Task 5.3 — Update CHANGELOG and prepare for user acceptance

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `package.json` (version bump? — only if user gives release signal)

- [ ] **Step 1: Add entry to `CHANGELOG.md` under unreleased section**

```markdown
## Unreleased — DRW-178 follow-up

- Switched mermaid-imported arrows to native tldraw `kind:"elbow"` (was `"arc"`).
- Added layout pipeline steps: container direction heuristic (`determineContainerDirection`), elbow midpoint distribution (`computeElbowMidpoints`), label-width edge spacing reservation.
- Introduced `LayoutParams` configuration object (defaults in `packages/shemma-domain`).
- Added `POST /api/smart-insert` endpoint for light single-shape insertion.
- Removed `routed-arrow` custom shape and runtime libavoid integration from attempt-1/attempt-codex (reverted as architectural dead-end; native elbow + smart layout chosen instead).
```

- [ ] **Step 2: Commit CHANGELOG**

```bash
git add CHANGELOG.md
git commit -m "docs(drw-178): changelog — native elbow + smart layout pipeline"
```

- [ ] **Step 3: Stop. Hand off to user for live testing acceptance.**

Per `feedback-merge-needs-acceptance`: do NOT merge to main, do NOT tag a release until user has tested live and approved. State to user: "Phase 1-5 complete on `feature/drw-173-attempt-2`. Branch ready for live testing. Please open `http://localhost:5173/?space=di-draw&room=drw-178-final-verify` and verify visually."

---

## Acceptance criteria (spec §5 mapping)

| Spec §5 test | Implemented in | Verified by |
|---|---|---|
| `compile.test.ts` — kind:"elbow" | Task 1.1 | Task 1.1 Step 6 |
| `midpoints.test.ts` — distribution | Task 2.1 | Task 2.1 Step 4 |
| `directions.test.ts` — heuristic | Task 2.2 | Task 2.2 Step 4 |
| `empty-space.test.ts` — slot/expand | Task 4.1 | Task 4.1 Step 4 |
| `layout-params.test.ts` — validation | Task 3.1 | Task 3.1 Step 5 |
| layout determinism integration | Task 3.4 | Task 3.4 Step 2 |
| `schema.test.ts` — kind:"elbow" | Task 1.2 | Task 1.2 Step 5 |
| Live DRW-173 verification | Task 5.1 | Task 5.1 Step 6 |
| Manual user acceptance | — | Task 5.3 Step 3 |

## Out-of-scope reminders (from spec §2 "non-goals")

- No `routed-arrow` custom shape.
- No libavoid runtime.
- No auto-layout in edit mode.
- No UI panel for `LayoutParams`.

## Risks tracked (from spec §6)

- **Label measurement heuristic accuracy** — mitigation in Task 1.3 (conservative avg-char-width 8px); revisit in Phase 5 if visual regressions on cyrillic-heavy labels.
- **Container label placement** — out of scope of this plan; only flagged if visual test catches issue (Task 5.1 Step 6).
- **Auto-direction edge cases** — explicit `meta.didrawDirection` override always wins; user can manually correct in mermaid.
- **Smart-insert cascading expansion** — Task 4.2 returns expansion request; if it cascades, caller (frontend) escalates to full `/api/layout`. Not handled implicitly here.

## Notes for executor

- Work **only** on `feature/drw-173-attempt-2`. Do not checkout `feature/drw-173-attempt-1` or `feature/drw-173-attempt-codex`.
- Each task commits independently. Subagent dispatches one task per session.
- Live verification screenshots are controller-only (per `feedback-no-subagent-screenshot-trust`).
- All test counts above are starting points — adapt to actual numbers reported by `bun test`.
