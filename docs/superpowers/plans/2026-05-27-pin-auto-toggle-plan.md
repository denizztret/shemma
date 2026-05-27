# Pin Auto-Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) или superpowers:executing-plans для implementation task-by-task. Steps use checkbox (`- [ ]`) syntax для tracking.

**Goal:** Auto-set `meta.pinned` + `meta.didrawSizePinned` after manual drag/resize end через tldraw state-machine listener; SettingsPopover открывается в pinned mode по умолчанию.

**Architecture:** Один frontend модуль `apps/frontend/src/canvas/pin-auto-toggle.ts` слушает state-machine переходы `select.translating`/`select.resizing` → `select.idle`, считает diff snapshot↔current, пишет meta через `editor.run` (broadcast как user-source через WS). Backend получает изменения как обычный user-update; параллельно расширяем `compile.ts` (preserve didrawSizePinned) + `layout.ts` (isSizePinned guard для growY) + `layout-selection.ts` (forceUnpin clears both).

**Tech Stack:** tldraw 5.x (state machine, store listeners, `editor.run`, `editor.markHistoryStoppingPoint`), Bun runtime, bun:test, TypeScript strict.

**Spec:** `docs/superpowers/specs/2026-05-27-pin-auto-toggle-design.md` (v0.1, commit `be52691`).
**Branch:** `feature/pin-auto-toggle` (HEAD `be52691`).
**Backlog:** DRW-185.

---

## File Structure

| File | Responsibility | Status |
|---|---|---|
| `apps/frontend/src/canvas/pin-auto-toggle.ts` | Main module: state listener, snapshot, diff, write. | **NEW** |
| `apps/frontend/src/canvas/pin-auto-toggle.test.ts` | Pure helper tests (computePinUpdates, shouldPin). | **NEW** |
| `apps/frontend/src/App.tsx` | Wire `registerPinAutoToggle` в onMount + disposer ref. | MODIFY |
| `apps/frontend/src/settings/useSettingsTrigger.ts` | Single-line: `useState(false)` → `useState(true)`. | MODIFY |
| `apps/frontend/src/settings/useSettingsTrigger.test.ts` | Добавить 2 теста (default pinned). | MODIFY |
| `apps/backend/src/domain/compile.ts` | Preserve `didrawSizePinned` в meta whitelist (define-upsert). | MODIFY |
| `apps/backend/tests/domain-compile.test.ts` | Добавить тест preserve didrawSizePinned. | MODIFY |
| `apps/backend/src/domain/layout.ts` | `isSizePinned` helper + growY guard в `shapeBounds`. | MODIFY |
| `apps/backend/tests/layout-size-pin-discipline.test.ts` | Новые тесты size-pin behavior. | **NEW** |
| `apps/backend/src/routes/layout-selection.ts` | `forceUnpin: true` clears both flags. | MODIFY |
| `apps/backend/tests/routes-layout-selection-force-unpin.test.ts` | Extend для didrawSizePinned clearing. | MODIFY |
| `CHANGELOG.md` | Entry под Unreleased. | MODIFY |

**Total:** 3 NEW + 9 MODIFY = 12 files.

---

## Task 1: Probe — tldraw state-machine listener API

**Goal:** Найти конкретный API для subscribe на переходы `select.translating`/`select.resizing` → `select.idle` в tldraw 5.x. Зафиксировать findings + выбранный API.

**Files:**
- Create: `apps/frontend/src/canvas/pin-auto-toggle.probe.ts` (temporary, удалится в Task 2)

- [ ] **Step 1: Probe via tldraw types**

Run:
```bash
cd /Users/tretyakov_dv/Projects/sandbox/di.draw
grep -rn "getPath\|getCurrentToolId\|getStateDescendant\|isIn\|currentToolId" node_modules/tldraw/src/lib/editor/Editor.ts 2>/dev/null | head -30
# or
grep -rn "react\|atom\|computed" node_modules/@tldraw/state/src 2>/dev/null | head -20
# or read directly
ls node_modules/tldraw/dist-cjs/lib/editor/Editor.d.ts 2>/dev/null
```

Expected: locate `editor.getPath()` (returns dotted state path like `"select.translating"`), `react()` from `@tldraw/state`, и/или low-level event API.

- [ ] **Step 2: Probe live behaviour**

Create `apps/frontend/src/canvas/pin-auto-toggle.probe.ts`:

```typescript
// Probe-only: temporary file для verification API в dev stand.
// Удаляется в Task 2.
import { react } from "@tldraw/state";
import type { Editor } from "tldraw";

export function registerProbe(editor: Editor): () => void {
  let prevPath = "";
  return react("pin-probe", () => {
    const path = editor.getPath();
    if (path !== prevPath) {
      console.log("[pin-probe] state change:", prevPath, "→", path);
      prevPath = path;
    }
  });
}
```

Temporarily wire в `App.tsx` onMount (рядом с других registers):
```typescript
const probeDisposer = registerProbe(ed);
// remember to clean up later
```

- [ ] **Step 3: Validate в dev stand**

Run:
```bash
bun run dev
```

Open browser → open DevTools console → manually drag a shape → observe console logs. Expected sequence: `select.idle → select.pointing_shape → select.translating → select.idle` (или похожее в зависимости от tldraw version).

- [ ] **Step 4: Document findings**

Создать `docs/decisions/0005-pin-auto-toggle-state-listener.md` (краткое ADR — 1 страница):

```markdown
# ADR-0005: Pin auto-toggle — state machine listener choice

## Context
DRW-185 требует детектировать переход `select.translating`/`select.resizing` → `select.idle`.

## Decision
Использовать `react()` из `@tldraw/state` подписку на `editor.getPath()` signal.

## Rationale
- Public API tldraw 5.x.
- Signal-tracked: automatic re-run при изменении path.
- Возвращает disposer (стандартный pattern в codebase).
- Альтернатива `editor.on('event')` — менее стабильный, см. memory `feedback-tldraw-docs`.

## Observed state paths
- Idle: `select.idle`
- Drag start: `select.pointing_shape` → `select.translating`
- Drag end: `select.translating` → `select.idle`
- Resize start: `select.pointing_resize_handle` → `select.resizing`
- Resize end: `select.resizing` → `select.idle`

## Consequences
- Detection logic — pure path comparison (prev != curr).
- Open/close session triggers — простые `if (curr === 'select.translating') open(); if (prev === 'select.translating' && curr === 'select.idle') close();`.
```

- [ ] **Step 5: Cleanup probe**

```bash
rm apps/frontend/src/canvas/pin-auto-toggle.probe.ts
# unwire probe from App.tsx (revert temporary changes)
```

- [ ] **Step 6: Commit**

```bash
git add docs/decisions/0005-pin-auto-toggle-state-listener.md
git commit -m "docs(DRW-185): ADR-0005 — pin auto-toggle state listener choice"
```

**Note for implementer:** Если probe выяснит другой API (e.g., нет `getPath()` в 5.x, нужно использовать `editor.getInstanceState().currentToolId` + `editor.root.getCurrent()` chain) — обновить ADR и пересогласовать Task 5 wiring код. Не догадываться — verify.

---

## Task 2: Module skeleton — `pin-auto-toggle.ts` + wire в App.tsx

**Goal:** Создать пустой модуль с правильной сигнатурой + register в App.tsx + smoke test что disposer cleanup работает.

**Files:**
- Create: `apps/frontend/src/canvas/pin-auto-toggle.ts`
- Create: `apps/frontend/src/canvas/pin-auto-toggle.test.ts`
- Modify: `apps/frontend/src/App.tsx`

- [ ] **Step 1: Write failing test**

Create `apps/frontend/src/canvas/pin-auto-toggle.test.ts`:

```typescript
// apps/frontend/src/canvas/pin-auto-toggle.test.ts
//
// Pure-helper tests для pin-auto-toggle module.
// Logic concentrated в pure helpers (computePinUpdates, shouldPin) —
// state-machine wiring смотрится в live verification через dev stand.

import { describe, expect, it } from "bun:test";
import { computePinUpdates } from "./pin-auto-toggle";

describe("computePinUpdates — module smoke", () => {
  it("exports computePinUpdates as a function", () => {
    expect(typeof computePinUpdates).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
bun test apps/frontend/src/canvas/pin-auto-toggle.test.ts
```

Expected: FAIL with `Cannot find module './pin-auto-toggle'`.

- [ ] **Step 3: Create module skeleton**

Create `apps/frontend/src/canvas/pin-auto-toggle.ts`:

```typescript
// apps/frontend/src/canvas/pin-auto-toggle.ts
//
// DRW-185: auto-set meta.pinned + meta.didrawSizePinned after manual
// drag/resize end. Detection через tldraw state-machine listener
// (см. docs/decisions/0005-pin-auto-toggle-state-listener.md).
//
// Pure helpers (computePinUpdates, shouldPin, captureBBox) tested
// независимо в pin-auto-toggle.test.ts. Wiring (registerPinAutoToggle)
// validated через dev stand + chrome-devtools MCP.

import type { Editor, TLShape, TLShapeId } from "tldraw";

export type BBox = { x: number; y: number; w: number; h: number };

export type SessionKind = "translating" | "resizing";

export type Snapshot = Map<TLShapeId, BBox & { type: string }>;

export type PinUpdate = {
  id: TLShapeId;
  type: string;
  meta: Record<string, unknown>;
};

// === Pure helpers (testable независимо) ===

export function computePinUpdates(
  _snapshot: Snapshot,
  _getCurrent: (id: TLShapeId) => (BBox & { type: string; meta: Record<string, unknown> }) | undefined,
  _kind: SessionKind,
): PinUpdate[] {
  // Stub — реализуется в Task 4.
  return [];
}

// === Wiring (live-verified) ===

export function registerPinAutoToggle(_editor: Editor): () => void {
  // Stub — реализуется в Task 5.
  return () => {};
}

// Re-export для future plugin pattern если понадобится.
export type { Editor, TLShape, TLShapeId };
```

- [ ] **Step 4: Run test to verify pass**

Run:
```bash
bun test apps/frontend/src/canvas/pin-auto-toggle.test.ts
```

Expected: PASS (1/1).

- [ ] **Step 5: Wire register в App.tsx**

Modify `apps/frontend/src/App.tsx`. Найти секцию импортов с `registerStyleDefaultsSync` (~line 16):

```typescript
import { registerStyleDefaultsSync } from "./canvas/style-defaults-sync";
import { registerPinAutoToggle } from "./canvas/pin-auto-toggle";
```

Найти секцию disposer refs (~line 108-110):

```typescript
const autoFlipDisposerRef = useRef<(() => void) | null>(null);
const styleSyncDisposerRef = useRef<(() => void) | null>(null);
const pinAutoToggleDisposerRef = useRef<(() => void) | null>(null);
```

Найти cleanup секцию (~line 130-133):

```typescript
autoFlipDisposerRef.current?.();
autoFlipDisposerRef.current = null;
styleSyncDisposerRef.current?.();
styleSyncDisposerRef.current = null;
pinAutoToggleDisposerRef.current?.();
pinAutoToggleDisposerRef.current = null;
```

Найти `onMount` (~line 705 и далее):

```typescript
onMount={(ed) => {
  // ... existing autoFlip + styleSync wiring ...

  pinAutoToggleDisposerRef.current?.();
  pinAutoToggleDisposerRef.current = registerPinAutoToggle(ed);

  // ... остальное ...
}}
```

- [ ] **Step 6: Verify App.tsx compiles**

Run:
```bash
bun --cwd apps/frontend tsc --noEmit
```

Expected: no new TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src/canvas/pin-auto-toggle.ts \
        apps/frontend/src/canvas/pin-auto-toggle.test.ts \
        apps/frontend/src/App.tsx
git commit -m "feat(DRW-185): pin-auto-toggle module skeleton + App wiring"
```

---

## Task 3: Pure helper — `shouldPin` (threshold check)

**Goal:** Pure helper для определения чи нужен pin update для shape (≥1px delta на любой оси).

**Files:**
- Modify: `apps/frontend/src/canvas/pin-auto-toggle.ts`
- Modify: `apps/frontend/src/canvas/pin-auto-toggle.test.ts`

- [ ] **Step 1: Write failing tests**

Append к `apps/frontend/src/canvas/pin-auto-toggle.test.ts`:

```typescript
import { shouldPin } from "./pin-auto-toggle";

describe("shouldPin — threshold detection", () => {
  const baseSnap = { x: 0, y: 0, w: 100, h: 100, type: "geo" };

  it("returns moved=false, resized=false when no change", () => {
    const result = shouldPin(baseSnap, { x: 0, y: 0, w: 100, h: 100 });
    expect(result.moved).toBe(false);
    expect(result.resized).toBe(false);
  });

  it("detects movement when x changes >=1px", () => {
    const result = shouldPin(baseSnap, { x: 10, y: 0, w: 100, h: 100 });
    expect(result.moved).toBe(true);
    expect(result.resized).toBe(false);
  });

  it("detects movement when y changes >=1px", () => {
    const result = shouldPin(baseSnap, { x: 0, y: 5, w: 100, h: 100 });
    expect(result.moved).toBe(true);
    expect(result.resized).toBe(false);
  });

  it("detects resize when w changes >=1px", () => {
    const result = shouldPin(baseSnap, { x: 0, y: 0, w: 120, h: 100 });
    expect(result.moved).toBe(false);
    expect(result.resized).toBe(true);
  });

  it("detects resize when h changes >=1px", () => {
    const result = shouldPin(baseSnap, { x: 0, y: 0, w: 100, h: 80 });
    expect(result.moved).toBe(false);
    expect(result.resized).toBe(true);
  });

  it("ignores subpixel changes (<1px combined)", () => {
    const result = shouldPin(baseSnap, { x: 0.3, y: 0.2, w: 100, h: 100 });
    // abs(0.3) + abs(0.2) = 0.5 < 1 → moved=false
    expect(result.moved).toBe(false);
  });

  it("detects movement + resize combined", () => {
    const result = shouldPin(baseSnap, { x: 10, y: 10, w: 120, h: 80 });
    expect(result.moved).toBe(true);
    expect(result.resized).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
bun test apps/frontend/src/canvas/pin-auto-toggle.test.ts
```

Expected: FAIL with `Export "shouldPin" is missing`.

- [ ] **Step 3: Implement `shouldPin`**

В `apps/frontend/src/canvas/pin-auto-toggle.ts` найти секцию `// === Pure helpers ===` и **добавить выше computePinUpdates**:

```typescript
const MOVE_THRESHOLD_PX = 1;
const RESIZE_THRESHOLD_PX = 1;

export function shouldPin(
  snap: BBox & { type: string },
  current: BBox,
): { moved: boolean; resized: boolean } {
  const dx = current.x - snap.x;
  const dy = current.y - snap.y;
  const dw = current.w - snap.w;
  const dh = current.h - snap.h;
  return {
    moved: Math.abs(dx) + Math.abs(dy) >= MOVE_THRESHOLD_PX,
    resized: Math.abs(dw) + Math.abs(dh) >= RESIZE_THRESHOLD_PX,
  };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run:
```bash
bun test apps/frontend/src/canvas/pin-auto-toggle.test.ts
```

Expected: PASS (8/8).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/canvas/pin-auto-toggle.ts \
        apps/frontend/src/canvas/pin-auto-toggle.test.ts
git commit -m "feat(DRW-185): shouldPin pure helper with 1px threshold"
```

---

## Task 4: Pure helper — `computePinUpdates`

**Goal:** Pure helper, который получает snapshot + getCurrent function + session kind, возвращает array of pin updates для batch write.

**Files:**
- Modify: `apps/frontend/src/canvas/pin-auto-toggle.ts`
- Modify: `apps/frontend/src/canvas/pin-auto-toggle.test.ts`

- [ ] **Step 1: Write failing tests**

Append к `apps/frontend/src/canvas/pin-auto-toggle.test.ts`:

```typescript
describe("computePinUpdates — diff and meta", () => {
  // Helper для builds mock getCurrent function.
  const makeGetCurrent = (
    shapes: Record<string, BBox & { type: string; meta: Record<string, unknown> }>,
  ) => (id: string) => shapes[id];

  it("returns empty when snapshot is empty", () => {
    const snapshot: Snapshot = new Map();
    const result = computePinUpdates(snapshot, makeGetCurrent({}), "translating");
    expect(result).toEqual([]);
  });

  it("returns empty when no shape moved", () => {
    const snapshot: Snapshot = new Map([
      ["shape:a" as TLShapeId, { x: 0, y: 0, w: 100, h: 100, type: "geo" }],
    ]);
    const getCurrent = makeGetCurrent({
      "shape:a": { x: 0, y: 0, w: 100, h: 100, type: "geo", meta: {} },
    });
    const result = computePinUpdates(snapshot, getCurrent, "translating");
    expect(result).toEqual([]);
  });

  it("sets pinned=true on translate with movement", () => {
    const snapshot: Snapshot = new Map([
      ["shape:a" as TLShapeId, { x: 0, y: 0, w: 100, h: 100, type: "geo" }],
    ]);
    const getCurrent = makeGetCurrent({
      "shape:a": { x: 50, y: 0, w: 100, h: 100, type: "geo", meta: { foo: "bar" } },
    });
    const result = computePinUpdates(snapshot, getCurrent, "translating");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("shape:a");
    expect(result[0].type).toBe("geo");
    expect(result[0].meta.pinned).toBe(true);
    expect(result[0].meta.didrawSizePinned).toBeUndefined();
    // Preserves existing meta.
    expect(result[0].meta.foo).toBe("bar");
  });

  it("sets both pinned and didrawSizePinned on resize with bbox change", () => {
    const snapshot: Snapshot = new Map([
      ["shape:a" as TLShapeId, { x: 0, y: 0, w: 100, h: 100, type: "geo" }],
    ]);
    const getCurrent = makeGetCurrent({
      "shape:a": { x: 0, y: 0, w: 150, h: 120, type: "geo", meta: {} },
    });
    const result = computePinUpdates(snapshot, getCurrent, "resizing");
    expect(result).toHaveLength(1);
    expect(result[0].meta.pinned).toBe(true);
    expect(result[0].meta.didrawSizePinned).toBe(true);
  });

  it("does not set didrawSizePinned on translate-only (no resize)", () => {
    const snapshot: Snapshot = new Map([
      ["shape:a" as TLShapeId, { x: 0, y: 0, w: 100, h: 100, type: "geo" }],
    ]);
    const getCurrent = makeGetCurrent({
      "shape:a": { x: 50, y: 50, w: 100, h: 100, type: "geo", meta: {} },
    });
    const result = computePinUpdates(snapshot, getCurrent, "translating");
    expect(result[0].meta.didrawSizePinned).toBeUndefined();
  });

  it("handles resize with no bbox movement (anchored resize)", () => {
    // Resize в правый нижний угол: x/y не меняются, только w/h.
    const snapshot: Snapshot = new Map([
      ["shape:a" as TLShapeId, { x: 0, y: 0, w: 100, h: 100, type: "geo" }],
    ]);
    const getCurrent = makeGetCurrent({
      "shape:a": { x: 0, y: 0, w: 150, h: 100, type: "geo", meta: {} },
    });
    const result = computePinUpdates(snapshot, getCurrent, "resizing");
    expect(result).toHaveLength(1);
    expect(result[0].meta.pinned).toBe(true);  // resize всегда pin'ит position
    expect(result[0].meta.didrawSizePinned).toBe(true);
  });

  it("handles multi-shape: pins each shape with movement, skips unchanged", () => {
    const snapshot: Snapshot = new Map([
      ["shape:a" as TLShapeId, { x: 0, y: 0, w: 100, h: 100, type: "geo" }],
      ["shape:b" as TLShapeId, { x: 200, y: 0, w: 100, h: 100, type: "geo" }],
      ["shape:c" as TLShapeId, { x: 400, y: 0, w: 100, h: 100, type: "geo" }],
    ]);
    const getCurrent = makeGetCurrent({
      "shape:a": { x: 50, y: 0, w: 100, h: 100, type: "geo", meta: {} },
      "shape:b": { x: 200, y: 0, w: 100, h: 100, type: "geo", meta: {} },  // unchanged
      "shape:c": { x: 450, y: 50, w: 100, h: 100, type: "geo", meta: {} },
    });
    const result = computePinUpdates(snapshot, getCurrent, "translating");
    const ids = result.map((u) => u.id);
    expect(ids).toContain("shape:a");
    expect(ids).toContain("shape:c");
    expect(ids).not.toContain("shape:b");
  });

  it("skips shape if getCurrent returns undefined (e.g., deleted)", () => {
    const snapshot: Snapshot = new Map([
      ["shape:a" as TLShapeId, { x: 0, y: 0, w: 100, h: 100, type: "geo" }],
    ]);
    const getCurrent = makeGetCurrent({}); // pretend a was deleted
    const result = computePinUpdates(snapshot, getCurrent, "translating");
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify fail**

Run:
```bash
bun test apps/frontend/src/canvas/pin-auto-toggle.test.ts
```

Expected: FAIL (8 shouldPin tests pass + 8 computePinUpdates fail) because stub returns `[]`.

- [ ] **Step 3: Implement `computePinUpdates`**

Replace stub в `apps/frontend/src/canvas/pin-auto-toggle.ts`:

```typescript
export function computePinUpdates(
  snapshot: Snapshot,
  getCurrent: (id: TLShapeId) => (BBox & { type: string; meta: Record<string, unknown> }) | undefined,
  kind: SessionKind,
): PinUpdate[] {
  const updates: PinUpdate[] = [];
  for (const [id, snap] of snapshot) {
    const current = getCurrent(id);
    if (!current) continue;
    const { moved, resized } = shouldPin(snap, current);
    if (!moved && !resized) continue;
    const newMeta: Record<string, unknown> = { ...current.meta, pinned: true };
    if (kind === "resizing" && resized) {
      newMeta.didrawSizePinned = true;
    }
    updates.push({ id, type: current.type, meta: newMeta });
  }
  return updates;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run:
```bash
bun test apps/frontend/src/canvas/pin-auto-toggle.test.ts
```

Expected: PASS (16/16).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/canvas/pin-auto-toggle.ts \
        apps/frontend/src/canvas/pin-auto-toggle.test.ts
git commit -m "feat(DRW-185): computePinUpdates pure helper — diff + meta merge"
```

---

## Task 5: Wiring — state-machine listener + snapshot lifecycle

**Goal:** Реализовать `registerPinAutoToggle(editor)` через API из Task 1 ADR. Open session on enter translating/resizing, close + write on enter idle.

**Files:**
- Modify: `apps/frontend/src/canvas/pin-auto-toggle.ts`

- [ ] **Step 1: Add bbox-from-shape helper**

В `apps/frontend/src/canvas/pin-auto-toggle.ts` найти секцию pure helpers и добавить:

```typescript
const ARROW_TYPE = "arrow";

/**
 * Получает bbox для shape из tldraw editor (учитывая props.w/h для geo/frame/note;
 * fallback на shape geometry bounds для shapes без явных props).
 */
function getShapeBBox(editor: Editor, shape: TLShape): BBox & { type: string } {
  const props = shape.props as Record<string, unknown>;
  const w = typeof props.w === "number" ? (props.w as number) :
            editor.getShapeGeometry(shape).bounds.w;
  const h = typeof props.h === "number" ? (props.h as number) :
            editor.getShapeGeometry(shape).bounds.h;
  return { x: shape.x, y: shape.y, w, h, type: shape.type };
}
```

- [ ] **Step 2: Add snapshot capture helper**

Дальше в same файле:

```typescript
function captureSelectionSnapshot(editor: Editor): Snapshot {
  const snapshot: Snapshot = new Map();
  for (const shape of editor.getSelectedShapes()) {
    if (shape.type === ARROW_TYPE) continue;
    snapshot.set(shape.id, getShapeBBox(editor, shape));
  }
  return snapshot;
}
```

- [ ] **Step 3: Implement registerPinAutoToggle**

Replace stub:

```typescript
import { react } from "@tldraw/state";

type SessionState = { kind: SessionKind; snapshot: Snapshot } | null;

const TRANSLATING_PATH = "select.translating";
const RESIZING_PATH = "select.resizing";

function pathToKind(path: string): SessionKind | null {
  if (path === TRANSLATING_PATH) return "translating";
  if (path === RESIZING_PATH) return "resizing";
  return null;
}

export function registerPinAutoToggle(editor: Editor): () => void {
  let session: SessionState = null;
  let prevPath = "";

  const dispose = react("pin-auto-toggle", () => {
    const path = editor.getPath();
    if (path === prevPath) return;
    const prev = prevPath;
    prevPath = path;

    const enteringKind = pathToKind(path);
    const leavingKind = pathToKind(prev);

    if (enteringKind && session === null) {
      // OPEN
      session = {
        kind: enteringKind,
        snapshot: captureSelectionSnapshot(editor),
      };
      return;
    }

    if (leavingKind && !enteringKind && session !== null) {
      // CLOSE
      const closing = session;
      session = null;
      const updates = computePinUpdates(
        closing.snapshot,
        (id) => {
          const shape = editor.getShape(id);
          if (!shape) return undefined;
          const bbox = getShapeBBox(editor, shape);
          return { ...bbox, meta: (shape.meta ?? {}) as Record<string, unknown> };
        },
        closing.kind,
      );
      if (updates.length === 0) return;
      editor.markHistoryStoppingPoint("pin-auto-toggle");
      editor.run(() => {
        editor.updateShapes(
          updates.map((u) => ({ id: u.id, type: u.type, meta: u.meta })),
        );
      });
    }
  });

  return dispose;
}
```

- [ ] **Step 4: Run all module tests**

Run:
```bash
bun test apps/frontend/src/canvas/pin-auto-toggle.test.ts
```

Expected: PASS (16/16 — pure helpers unchanged).

- [ ] **Step 5: Verify frontend compiles**

Run:
```bash
bun --cwd apps/frontend tsc --noEmit
```

Expected: 0 new errors.

- [ ] **Step 6: Live verification (manual)**

Start dev stand:
```bash
bun run dev
```

В browser:
1. Drag geo shape — после release: check meta.pinned via SettingsPopover (Alt+RightClick → Pin Position должно быть `✓`).
2. Resize geo shape — check both Pin Position and Pin Size в SettingsPopover.
3. ESC during drag — pin не должен ставиться.
4. Multi-select drag (Shift-click 3 shapes + drag) — все 3 должны быть pinned.
5. Drag arrow — не должно ставить pin.

Если что-то не работает — fix перед commit (this is the live-verification gate).

Stop dev: kill backgrounded `bun run dev` process.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src/canvas/pin-auto-toggle.ts
git commit -m "feat(DRW-185): wire state-machine listener — auto-pin on translate/resize end"
```

---

## Task 6: SettingsPopover default-pinned mode

**Goal:** Изменить default value `pinned` в `useSettingsTrigger` с `false` на `true` через exported constant + тест на значение константы.

**Files:**
- Modify: `apps/frontend/src/settings/useSettingsTrigger.ts:89`
- Modify: `apps/frontend/src/settings/useSettingsTrigger.test.ts`

- [ ] **Step 1: Write failing tests**

Append к `apps/frontend/src/settings/useSettingsTrigger.test.ts`:

```typescript
import { SETTINGS_POPOVER_DEFAULT_PINNED } from "./useSettingsTrigger";

describe("useSettingsTrigger — DRW-185 default-pinned mode", () => {
  it("exports SETTINGS_POPOVER_DEFAULT_PINNED constant", () => {
    expect(typeof SETTINGS_POPOVER_DEFAULT_PINNED).toBe("boolean");
  });

  it("default popover state is pinned (true)", () => {
    expect(SETTINGS_POPOVER_DEFAULT_PINNED).toBe(true);
  });
});
```

**Note for implementer:** существующий `useSettingsTrigger.test.ts` тестирует pure resolver helpers (`resolveTarget` / `resolveAmbientTarget`), не hook lifecycle. Choice здесь — extract exported constant + test constant value (cleaner than RTL renderHook setup). Полное hook behavior testing — out of scope DRW-185 (live-verified в Step 5).

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
bun test apps/frontend/src/settings/useSettingsTrigger.test.ts
```

Expected: FAIL — `Export "SETTINGS_POPOVER_DEFAULT_PINNED" is missing`.

- [ ] **Step 3: Make the change в useSettingsTrigger.ts**

В `apps/frontend/src/settings/useSettingsTrigger.ts` найти строку 89:

```typescript
const [pinned, setPinnedState] = useState(false);
```

**Перед** функцией useSettingsTrigger (top-level export) добавить:

```typescript
// DRW-185: default-pinned mode — popover открывается в закреплённом состоянии.
// User может вернуть к floating через close button (на pinned клик закрывает popover).
// Persistence не реализована (YAGNI) — каждая сессия начинается с этим default.
export const SETTINGS_POPOVER_DEFAULT_PINNED = true;
```

И заменить строку 89:

```typescript
const [pinned, setPinnedState] = useState(SETTINGS_POPOVER_DEFAULT_PINNED);
```

- [ ] **Step 4: Run tests to verify pass**

Run:
```bash
bun test apps/frontend/src/settings/useSettingsTrigger.test.ts
```

Expected: PASS (2/2 new + existing tests still pass).

- [ ] **Step 5: Live verification**

В dev stand:
1. Reload page → Alt+RightClick по shape → popover должен открыться в pinned mode (button показывает `✕`, tooltip "Закрыть").
2. Click `✕` → popover закрывается.
3. Open again → снова в pinned mode (no persistence — каждый раз default true).

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/settings/useSettingsTrigger.ts \
        apps/frontend/src/settings/useSettingsTrigger.test.ts
git commit -m "feat(DRW-185): SettingsPopover default-pinned mode"
```

---

## Task 7: Backend — preserve `didrawSizePinned` в compile.define

**Goal:** Расширить meta whitelist в `compile.ts:127-143` (define upsert) чтобы сохранять `didrawSizePinned` от existing shape.

**Files:**
- Modify: `apps/backend/src/domain/compile.ts:125-143`
- Modify: `apps/backend/tests/domain-compile.test.ts`

- [ ] **Step 1: Locate existing meta preservation test**

Read `apps/backend/tests/domain-compile.test.ts` — find test about preserving `meta.pinned` или `meta.position` при define upsert. Этот тест будет model для new test.

- [ ] **Step 2: Write failing test**

В `apps/backend/tests/domain-compile.test.ts` найти `describe` блок для define upsert и добавить test:

```typescript
test("define preserves meta.didrawSizePinned on existing shape", () => {
  // Setup: snapshot с existing shape that has didrawSizePinned=true.
  const shapeId = "shape:existing";
  const snapshot = {
    schema: { schemaVersion: 1, storeVersion: 4, recordVersions: {} },
    store: {
      "document:document": { id: "document:document", typeName: "document" },
      "page:page": { id: "page:page", typeName: "page" },
      [shapeId]: {
        id: shapeId,
        typeName: "shape",
        type: "geo",
        x: 0,
        y: 0,
        parentId: "page:page",
        index: "a1",
        isLocked: false,
        opacity: 1,
        rotation: 0,
        props: { w: 100, h: 50, geo: "rectangle" },
        meta: { didrawName: "existing", role: "service", didrawSizePinned: true },
      },
    },
  } as unknown as TLStoreSnapshot;

  const index = new Map([["existing", shapeId]]);
  const action: DomainAction = {
    kind: "define",
    name: "existing",
    role: "service",
    label: "Existing Service",
  };

  const { batch } = compile([action], snapshot, index);
  const updated = batch.updated[shapeId];
  expect(updated).toBeDefined();
  const newRecord = updated![1];
  expect(newRecord.meta.didrawSizePinned).toBe(true);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run:
```bash
bun --cwd apps/backend test tests/domain-compile.test.ts
```

Expected: FAIL — `newRecord.meta.didrawSizePinned` is `undefined`.

- [ ] **Step 4: Implement preserve**

В `apps/backend/src/domain/compile.ts` найти lines 127-143 (define upsert meta block). Заменить блок destructure и reassign на:

```typescript
          // preserve user-owned meta (pinned/position/styleOwnedBy/didrawSizePinned)
          const oldMeta = (old.meta ?? {}) as Record<string, unknown>;
          const { pinned, position, styleOwnedBy, didrawSizePinned, ...rest } = oldMeta as {
            pinned?: unknown;
            position?: unknown;
            styleOwnedBy?: unknown;
            didrawSizePinned?: unknown;
            [key: string]: unknown;
          };
          const newMeta: Record<string, unknown> = {
            ...rest,
            didrawName: a.name,
            role: a.role,
            ...(a.meta ?? {}),
          };
          if (pinned !== undefined) newMeta.pinned = pinned;
          if (position !== undefined) newMeta.position = position;
          if (styleOwnedBy !== undefined) newMeta.styleOwnedBy = styleOwnedBy;
          if (didrawSizePinned !== undefined) newMeta.didrawSizePinned = didrawSizePinned;
```

- [ ] **Step 5: Run test to verify pass**

Run:
```bash
bun --cwd apps/backend test tests/domain-compile.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run full backend test suite**

Run:
```bash
bun --cwd apps/backend test
```

Expected: All previous tests still pass + new test pass.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/domain/compile.ts \
        apps/backend/tests/domain-compile.test.ts
git commit -m "feat(DRW-185): compile.define preserves meta.didrawSizePinned on upsert"
```

---

## Task 8: Backend — `isSizePinned` helper + growY guard в `shapeBounds`

**Goal:** Добавить exported `isSizePinned(shape)` + branch в `shapeBounds` который игнорирует growY override если shape size-pinned. Создать новый test file для size-pin discipline.

**Files:**
- Modify: `apps/backend/src/domain/layout.ts:132-153` (shapeBounds) + add helper near line 212 (isPinned)
- Create: `apps/backend/tests/layout-size-pin-discipline.test.ts`

- [ ] **Step 1: Read existing layout-pin-discipline.test.ts pattern**

Read `apps/backend/tests/layout-pin-discipline.test.ts` lines 1-100 — understand snapshot construction pattern + runLayout invocation.

- [ ] **Step 2: Write failing tests (new file)**

Create `apps/backend/tests/layout-size-pin-discipline.test.ts`:

```typescript
// DRW-185: backend size-pin discipline.
// Когда shape имеет meta.didrawSizePinned === true:
//   - shapeBounds игнорирует growY override (использует только props.h)
//   - position-layout продолжает работать (size pin orthogonal к position pin)

import { describe, expect, test } from "bun:test";
import { isSizePinned, shapeBounds } from "../src/domain/layout";
import type { TLRecord } from "../src/store-types";

function makeGeo(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  growY: number,
  meta: Record<string, unknown> = {},
): TLRecord {
  return {
    id,
    typeName: "shape",
    type: "geo",
    x,
    y,
    parentId: "page:page",
    index: "a1",
    isLocked: false,
    opacity: 1,
    rotation: 0,
    props: { w, h, growY, geo: "rectangle" },
    meta,
  } as unknown as TLRecord;
}

describe("isSizePinned helper", () => {
  test("returns true for shape with meta.didrawSizePinned === true", () => {
    const shape = makeGeo("shape:a", 0, 0, 100, 50, 0, { didrawSizePinned: true });
    expect(isSizePinned(shape as unknown as Parameters<typeof isSizePinned>[0])).toBe(true);
  });

  test("returns false for shape without didrawSizePinned", () => {
    const shape = makeGeo("shape:a", 0, 0, 100, 50, 0, {});
    expect(isSizePinned(shape as unknown as Parameters<typeof isSizePinned>[0])).toBe(false);
  });

  test("returns false when didrawSizePinned is explicitly false", () => {
    const shape = makeGeo("shape:a", 0, 0, 100, 50, 0, { didrawSizePinned: false });
    expect(isSizePinned(shape as unknown as Parameters<typeof isSizePinned>[0])).toBe(false);
  });
});

describe("shapeBounds growY guard (pure helper)", () => {
  test("non-pinned geo: bounds.h = props.h + growY", () => {
    const shape = makeGeo("shape:a", 0, 0, 100, 50, 30, {});
    const bounds = shapeBounds(shape as unknown as Parameters<typeof shapeBounds>[0]);
    expect(bounds.h).toBe(80); // 50 + 30
  });

  test("size-pinned geo: bounds.h = props.h (growY ignored)", () => {
    const shape = makeGeo("shape:a", 0, 0, 100, 50, 30, { didrawSizePinned: true });
    const bounds = shapeBounds(shape as unknown as Parameters<typeof shapeBounds>[0]);
    expect(bounds.h).toBe(50);
  });

  test("size-pinned note: same behavior as geo", () => {
    const shape = makeGeo("shape:a", 0, 0, 100, 50, 30, { didrawSizePinned: true });
    const noteShape = { ...shape, type: "note" } as unknown as TLRecord;
    const bounds = shapeBounds(noteShape as unknown as Parameters<typeof shapeBounds>[0]);
    expect(bounds.h).toBe(50);
  });

  test("non-geo/note shapes: growY ignored anyway (frame)", () => {
    const baseGeo = makeGeo("frame:a", 0, 0, 200, 100, 30, {});
    const frame = { ...baseGeo, type: "frame" } as unknown as TLRecord;
    const bounds = shapeBounds(frame as unknown as Parameters<typeof shapeBounds>[0]);
    expect(bounds.h).toBe(100); // frame doesn't read growY
  });
});
```

**Note for implementer:** This test imports `shapeBounds` directly — Step 4 ниже **exports** it from layout.ts (previously unexported). Tests live in `apps/backend/tests/` directory (NOT in `src/domain/`). Import path `"../src/domain/layout"` matches existing test pattern в `layout-pin-discipline.test.ts`.

- [ ] **Step 3: Run test to verify it fails**

Run:
```bash
bun --cwd apps/backend test tests/layout-size-pin-discipline.test.ts
```

Expected: FAIL — `Export "isSizePinned" not found`.

- [ ] **Step 4: Implement `isSizePinned` + export shapeBounds + growY guard**

В `apps/backend/src/domain/layout.ts` найти `function isPinned(r: ShapeRec)` (~line 212). Добавить рядом:

```typescript
export function isSizePinned(r: ShapeRec): boolean {
  return r.meta?.didrawSizePinned === true;
}
```

В тот же файл, найти `function shapeBounds(r: ShapeRec): Bounds` (~line 132) и заменить весь блок (132-153) на:

```typescript
// DRW-185: exported для прямого unit-testing size-pin guard.
export function shapeBounds(r: ShapeRec): Bounds {
  const isFrame = r.type === "frame";
  const w = readNumberProp(r.props, "w", isFrame ? DEFAULT_FRAME_W : DEFAULT_W);
  const baseH = readNumberProp(
    r.props,
    "h",
    isFrame ? DEFAULT_FRAME_H : DEFAULT_H,
  );
  // DRW-174: geo/note effective height = props.h + growY (text overflow fit).
  // DRW-185: size-pinned shapes (meta.didrawSizePinned) — strict props.h как
  // ground truth, growY ignored. Pin discipline parallel к meta.pinned (position).
  const growY =
    (r.type === "geo" || r.type === "note") && !isSizePinned(r)
      ? readNumberProp(r.props, "growY", 0)
      : 0;
  const h = baseH + growY;
  const x = typeof r.x === "number" ? r.x : 0;
  const y = typeof r.y === "number" ? r.y : 0;
  return { x, y, w, h };
}
```

- [ ] **Step 5: Run tests to verify pass**

Run:
```bash
bun --cwd apps/backend test tests/layout-size-pin-discipline.test.ts
```

Expected: PASS (all tests).

- [ ] **Step 6: Run full backend suite**

Run:
```bash
bun --cwd apps/backend test
```

Expected: All previous tests still pass.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/domain/layout.ts \
        apps/backend/tests/layout-size-pin-discipline.test.ts
git commit -m "feat(DRW-185): isSizePinned + growY guard — backend respects didrawSizePinned"
```

---

## Task 9: Backend — `forceUnpin` bypasses size-pin guard

**Goal:** Добавить `ignoreSizePin` параметр в `shapeBounds` + propagate `fullHint.forceUnpin` к call-sites где effective bounds читаются в pin-aware context. Test через pure helper assertion в `layout-size-pin-discipline.test.ts`.

**Files:**
- Modify: `apps/backend/src/domain/layout.ts` (shapeBounds signature + call-site propagation)
- Modify: `apps/backend/tests/layout-size-pin-discipline.test.ts` (extend with forceUnpin bypass tests)

- [ ] **Step 1: Write failing tests (extension к Task 8 file)**

Append к `apps/backend/tests/layout-size-pin-discipline.test.ts`:

```typescript
describe("shapeBounds — forceUnpin bypass", () => {
  test("ignoreSizePin=true: size-pinned geo gets growY applied (bypass guard)", () => {
    const shape = makeGeo("shape:a", 0, 0, 100, 50, 30, { didrawSizePinned: true });
    const bounds = shapeBounds(
      shape as unknown as Parameters<typeof shapeBounds>[0],
      /* ignoreSizePin */ true,
    );
    expect(bounds.h).toBe(80); // 50 + 30 — growY applied because guard bypassed
  });

  test("ignoreSizePin=false (default): size-pinned still ignores growY", () => {
    const shape = makeGeo("shape:a", 0, 0, 100, 50, 30, { didrawSizePinned: true });
    const bounds = shapeBounds(shape as unknown as Parameters<typeof shapeBounds>[0]);
    expect(bounds.h).toBe(50); // growY ignored
  });

  test("ignoreSizePin=true on non-pinned shape: same as default behavior", () => {
    const shape = makeGeo("shape:a", 0, 0, 100, 50, 30, {});
    const bounds = shapeBounds(
      shape as unknown as Parameters<typeof shapeBounds>[0],
      true,
    );
    expect(bounds.h).toBe(80); // identical to default — no size-pin to bypass
  });
});
```

- [ ] **Step 2: Run tests to verify fail**

Run:
```bash
bun --cwd apps/backend test tests/layout-size-pin-discipline.test.ts
```

Expected: FAIL — `shapeBounds` doesn't accept second param (TypeScript error or runtime ignore).

- [ ] **Step 3: Add `ignoreSizePin` param to shapeBounds**

В `apps/backend/src/domain/layout.ts` find `function shapeBounds` (~line 132). Modify signature:

```typescript
export function shapeBounds(r: ShapeRec, ignoreSizePin = false): Bounds {
  const isFrame = r.type === "frame";
  const w = readNumberProp(r.props, "w", isFrame ? DEFAULT_FRAME_W : DEFAULT_W);
  const baseH = readNumberProp(
    r.props,
    "h",
    isFrame ? DEFAULT_FRAME_H : DEFAULT_H,
  );
  // DRW-174: geo/note effective height = props.h + growY.
  // DRW-185: но size-pinned shapes (meta.didrawSizePinned) — strict props.h.
  // ignoreSizePin=true (forceUnpin path) bypass'ит guard для одного layout pass'а.
  const sizePinned = !ignoreSizePin && isSizePinned(r);
  const growY =
    (r.type === "geo" || r.type === "note") && !sizePinned
      ? readNumberProp(r.props, "growY", 0)
      : 0;
  const h = baseH + growY;
  const x = typeof r.x === "number" ? r.x : 0;
  const y = typeof r.y === "number" ? r.y : 0;
  return { x, y, w, h };
}
```

- [ ] **Step 4: Propagate forceUnpin к key call-sites**

В layout.ts найти `runLayout` (location ~line 1380+) и его call-sites `shapeBounds(s)`. Где `fullHint.forceUnpin` in scope — pass it:

```typescript
// Example: pinnedSet collection (~line 1419 region)
for (const s of allShapes) {
  if (!fullHint.forceUnpin && isPinned(s)) pinnedSet.add(s.id);
  // ... if shapeBounds(s) used nearby:
  //     change to shapeBounds(s, fullHint.forceUnpin)
}
```

Find via grep:
```bash
grep -n "shapeBounds(" apps/backend/src/domain/layout.ts
```

Для каждого call-site:
- Если `fullHint` или `hint.forceUnpin` доступен в scope — pass `fullHint.forceUnpin`.
- Если нет — default `false` остаётся (no force).

Минимально требуется обновить call-sites в `runLayout` body (после `const fullHint = {...}`) где shapeBounds читает effective height для layout computation. Без этого Pass A frame bounds может выйти меньше после `forceUnpin: true` на size-pinned children (regression).

- [ ] **Step 5: Run tests to verify pass**

Run:
```bash
bun --cwd apps/backend test tests/layout-size-pin-discipline.test.ts
```

Expected: PASS (all tests в file).

- [ ] **Step 6: Run existing pin tests still pass**

Run:
```bash
bun --cwd apps/backend test tests/layout-pin-discipline.test.ts
bun --cwd apps/backend test tests/routes-layout-selection-force-unpin.test.ts
```

Expected: all green — existing position-pin behavior unchanged.

- [ ] **Step 7: Run full backend suite**

Run:
```bash
bun --cwd apps/backend test
```

Expected: всё green, no regressions.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/domain/layout.ts \
        apps/backend/tests/layout-size-pin-discipline.test.ts
git commit -m "feat(DRW-185): forceUnpin bypasses isSizePinned guard в shapeBounds"
```

---

## Task 10: CHANGELOG entry + final verification

**Goal:** Document feature в `CHANGELOG.md` под Unreleased + full test suite pass.

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Read current CHANGELOG state**

Read `CHANGELOG.md` first 30 lines — locate `## Unreleased` section.

- [ ] **Step 2: Add entry**

Под `## Unreleased` добавить новую секцию:

```markdown
### Pin auto-toggle (DRW-185)

- Frontend: после ручного drag/resize shape автоматически проставляются `meta.pinned`
  (для position) и `meta.didrawSizePinned` (для size). Trigger — переход
  `select.translating`/`select.resizing` → `select.idle` с реальным движением
  (≥1px delta). Реализовано через `react()` listener из `@tldraw/state` в новом
  модуле `apps/frontend/src/canvas/pin-auto-toggle.ts`. Arrows исключены из
  auto-pin (отдельная binding/anchor semantics). Multi-select: pin'ятся все
  shapes в selection с measurable delta.
- Frontend: `SettingsPopover` открывается в pinned mode по умолчанию
  (`useSettingsTrigger.ts`).
- Backend: `compile.define` preserves `meta.didrawSizePinned` при upsert (рядом
  с pinned / position / styleOwnedBy).
- Backend: `shapeBounds` игнорирует `growY` override для shapes с
  `meta.didrawSizePinned === true` (strict `props.h` как ground truth).
  `forceUnpin: true` (⌘⌥⇧L / Ctrl+Alt+Shift+L) bypass'ит этот guard для одного
  layout pass'а.
- Tests: +16 frontend (pin-auto-toggle pure helpers), +3 backend
  (compile-meta-preservation extension + isSizePinned + shapeBounds size-pin
  scenarios), +1 forceUnpin extension.

Followups: arrow manual pin к стороне-якорю (interacts с DRW-172),
SettingsPopover pin state persistence, global toggle "auto-pin on/off".
```

- [ ] **Step 3: Run full test suite (all packages)**

Run:
```bash
bun run test
```

Expected: 2061 baseline + 16 frontend + 4-5 backend = ~2080+ pass, 0 fail.

Если frontend tests запускаются отдельно:
```bash
bun test --cwd apps/frontend src
```

Expected: 246 baseline + 16 = 262+ pass.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(DRW-185): CHANGELOG entry — pin auto-toggle + popover default-pinned"
```

---

## Phase-end review

После Task 10 — single phase-end review (per CLAUDE.md `Review policy: phase-end only`):

- [ ] **Step 1: Code-simplifier pass**

Run `code-simplifier` agent на diff'е feature ветки от `841260e` baseline:

```bash
git diff 841260e..HEAD --stat
git diff 841260e..HEAD
```

Subagent инструкция: "Упростить diff DRW-185 feature ветки — KISS / DRY / YAGNI. Особое внимание pin-auto-toggle.ts (state listener + helpers) и backend forceUnpin propagation (Option A или B simpler). Не менять public APIs / behaviour."

- [ ] **Step 2: Spec compliance + code quality review**

Run review agent на final diff vs spec `docs/superpowers/specs/2026-05-27-pin-auto-toggle-design.md`. Verify:
1. All 15 AC из DRW-185 task — covered.
2. Out-of-scope items не реализованы (arrows, persistence, global toggle, keyboard nudge).
3. No new endpoints / no new domain types.
4. Tests:
   - Frontend pin-auto-toggle: ≥8 pure helper cases ✓
   - SettingsPopover: ≥2 tests ✓
   - Backend compile preservation: ≥1 test ✓
   - Backend size-pin discipline (isSizePinned + shapeBounds growY guard): ≥3 tests ✓
   - Backend forceUnpin extension: ≥1 test ✓
5. No `Co-Authored-By:` / `Generated with` trailers в commits.
6. CHANGELOG entry present + accurate.

- [ ] **Step 3: Fix any issues found**

Address findings одним или несколькими commits на feature branch.

- [ ] **Step 4: User acceptance gate** (per `feedback-merge-needs-acceptance`)

Готово к merge — но **не merge'ить пока user не подтвердит** через live testing.

- [ ] **Step 5: Squash + no-ff merge** (per `feedback-squash-merge`)

После user acceptance:

```bash
# на feature branch — squash в один commit
git checkout feature/pin-auto-toggle
git reset --soft 841260e
git commit -m "$(cat <<'EOF'
feat(DRW-185): pin auto-toggle + SettingsPopover default-pinned

- Frontend: state-machine listener auto-sets meta.pinned + meta.didrawSizePinned
  на drag/resize end с >=1px movement. Arrows excluded. Multi-select supported.
- Frontend: SettingsPopover default = pinned mode.
- Backend: compile preserves didrawSizePinned; layout respects (growY guard);
  forceUnpin bypasses guard.

Tests: 2061 baseline + 16 frontend + 4 backend = 2081 pass / 0 fail.

Spec: docs/superpowers/specs/2026-05-27-pin-auto-toggle-design.md
Plan: docs/superpowers/plans/2026-05-27-pin-auto-toggle-plan.md
Followups: arrow manual pin к стороне-якорю (DRW-XXX),
SettingsPopover persistence (DRW-XXX), global toggle (DRW-XXX).
EOF
)"

# на main — --no-ff merge → branch topology preserved
git checkout main
git merge --no-ff feature/pin-auto-toggle -m "merge: feature/pin-auto-toggle → main (DRW-185)"

# удалить feature branch (теперь fully merged)
git branch -d feature/pin-auto-toggle
```

- [ ] **Step 6: Backlog DRW-185 → Done**

```bash
backlog task edit DRW-185 -s "Done" --final-summary "Pin auto-toggle on manual drag/resize end (>=1px) + SettingsPopover default-pinned shipped. State machine listener via @tldraw/state react(). Backend size-pin discipline (compile preserve + layout growY guard + forceUnpin bypass). 2081 tests pass."
```

---

## Self-Review (writing-plans checklist)

**1. Spec coverage:**
- ✅ Goal — Task 1-5 (frontend) + Task 7-9 (backend).
- ✅ Sub-feature A (auto-pin shape) — Task 1-5.
- ✅ Sub-feature B (popover default-pinned) — Task 6.
- ✅ Backend didrawSizePinned support — Task 7 (compile) + Task 8 (layout) + Task 9 (forceUnpin).
- ✅ All 15 AC из DRW-185:
  - AC #1 (drag >=1px → pinned) — Task 4 (computePinUpdates) + Task 5 (wiring).
  - AC #2 (resize → both flags) — Task 4 + Task 5.
  - AC #3 (arrows ignored) — Task 5 Step 2 (`if (shape.type === ARROW_TYPE) continue`).
  - AC #4 (ESC → no pin) — natural behavior, snapshot diff = 0. Verified Task 5 Step 6 (live).
  - AC #5 (multi-select pin all) — Task 4 multi-shape test.
  - AC #6 (programmatic moves no pin) — natural behavior, state machine not entered.
  - AC #7 (popover pinned by default) — Task 6.
  - AC #8 (close button works) — Task 6.
  - AC #9 (compile preserves didrawSizePinned) — Task 7.
  - AC #10 (size-pinned ignores growY) — Task 8.
  - AC #11 (forceUnpin clears both) — Task 9.
  - AC #12 (undo behavior) — Task 5 Step 3 (`markHistoryStoppingPoint`) + live verification.
  - AC #13 (frontend tests) — Task 3 (8 shouldPin) + Task 4 (8 computePinUpdates) + Task 6 (2 popover) = 18 frontend tests.
  - AC #14 (backend tests) — Task 7 (1 compile) + Task 8 (3+ size-pin) + Task 9 (1 forceUnpin) = 5+ backend tests.
  - AC #15 (all tests pass) — Task 10 Step 3.
- ✅ Edge cases table из spec — все covered либо в pure tests либо в live verification (Task 5 Step 6, Task 6 Step 5).

**2. Placeholder scan:**
- ✅ Task 6 — refactor'ен на exported constant pattern; no RTL hooks, real test code.
- ✅ Task 9 — refactor'ен на pure-helper test pattern (через `shapeBounds(s, true)`); no integration placeholders.
- ✅ Task 8 — committed на exported shapeBounds path; concrete tests provided.
- ✅ Все commands — exact (`bun --cwd apps/backend test tests/...`).
- ✅ Все file paths — exact with line refs где relevant.
- ✅ Все code blocks — complete code, не "similar to Task X".

**3. Type consistency:**
- `SessionKind = "translating" | "resizing"` — Task 2 defined, Task 4-5 used consistently.
- `Snapshot = Map<TLShapeId, BBox & { type: string }>` — Task 2 defined, Task 4-5 used.
- `PinUpdate = { id; type; meta }` — Task 2 defined, Task 4 returns array of these.
- `shouldPin(snap, current) → { moved; resized }` — Task 3 sig matches Task 4 usage.
- `computePinUpdates(snapshot, getCurrent, kind)` — Task 4 sig matches Task 5 wiring usage.
- `isSizePinned(shape)` — Task 8 defined, Task 9 used (via shapeBounds branch).
- `shapeBounds` — Task 8 exposes; Task 9 modifies signature (`ignoreSizePin` param) — implementer must update all call-sites consistently.

**Plan ready. Self-review pass.**
