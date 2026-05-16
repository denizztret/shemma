# di.draw Phase 2.2 — Sync Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close Phase 2.0+2.1 follow-ups (10 Important + 9 Minor); round-trip user-drawn arrows к backend (B1); add durable opLog + version-aware WS replay + no-silent-fail error surface. Ship as v0.3.0.

**Architecture:** Three concern-blocks: (A) followups — targeted fixes; (B) user-arrows — extend `to-patch.ts` для arrow shape detection + backend already accepts target:"edge"; (C) sync hardening — persist `opLog` в envelope (schemaVersion 1→2), client tracks `lastReceivedVersion`, WS `hello` handshake + `replay`/`truncated` server reply, frontend `ErrorBanner` для 422-responses.

**Tech Stack:** Bun runtime, Hono, tldraw 5.x, bun:test, Playwright (optional smoke).

**Spec:** `docs/superpowers/specs/2026-05-16-di-draw-phase2-2-sync-hardening-design.md` v0.1.

---

## File Structure

### Modified backend

| Path | Change |
|---|---|
| `apps/backend/src/config.ts` | slug length cap (I1) + test reset hook (m6) |
| `apps/backend/src/envelope.ts` | schemaVersion 1→2, persist `opLog` |
| `apps/backend/src/persistence.ts` | restore opLog on load (was clearing it) |
| `apps/backend/src/rooms.ts` | viewport TTL constant rename; evictIdle → flushIfDirty (m5); GET /api/rooms id validation (m1) — actually in routes/rooms.ts |
| `apps/backend/src/routes/rooms.ts` | I2 explicit flushIfDirty before import evict; I5 `existingId` в 409; m1 id validation на filename |
| `apps/backend/src/routes/domain.ts` | I2 idempotency cache LRU bound; m1 double bus.publish документировать |
| `apps/backend/src/routes/context.ts` | tsc strict (I1) |
| `apps/backend/src/routes/patch.ts` | inferUserMetadata расширен на target:"edge" (B1.2) |
| `apps/backend/src/domain/validate.ts` | tsc strict (I1) |
| `apps/backend/src/domain/layout.ts` | elkWorkerPath .d.ts (I1) |
| `apps/backend/src/domain/layout-postprocess.ts` | tsc strict (I1) |
| `apps/backend/src/domain/context.ts` | `role` optional на ElementCompact (Phase 2.1 m2) |
| `apps/backend/src/index.ts` | WS message handler — hello/replay |

### New backend tests

| Path | Covers |
|---|---|
| `apps/backend/tests/config-slug-length.test.ts` | I1 |
| `apps/backend/tests/workspace-isolation.test.ts` | I4 |
| `apps/backend/tests/rooms-import-409-content.test.ts` | I3 + I5 |
| `apps/backend/tests/envelope-oplog-roundtrip.test.ts` | Block D §11 |
| `apps/backend/tests/ws-hello-replay.test.ts` | Block D §12 |

### Modified frontend

| Path | Change |
|---|---|
| `apps/frontend/src/canvas/to-patch.ts` | B1.1+B1.2 — arrow detect → edge add/update/delete |
| `apps/frontend/src/canvas/from-canvas-state.ts` | apply `connectionPropsForEdge` (Phase 2.1 m3 — use dead export) |
| `apps/frontend/src/transport/ws.ts` | hello handshake, replay handling, lastReceivedVersion tracking |
| `apps/frontend/src/transport/api.ts` | error bus integration |
| `apps/frontend/src/App.tsx` | mount ErrorBanner |
| `apps/frontend/src/chrome/ErrorBanner.tsx` (new) | top-right toast |
| `apps/frontend/src/state/error-bus.ts` (new) | minimal pub/sub |

### Skill + release

| Path | Change |
|---|---|
| `.claude/skills/draw/SKILL.md` | minor — note user arrows now round-trip |
| `CHANGELOG.md` | `0.3.0` entry |
| `package.json` (root) | `0.2.0 → 0.3.0` |

---

## Task 1: Phase 2.0 minor batch (m1, m3, m4, m5, m6)

**Files:**
- Modify: `apps/backend/src/routes/rooms.ts` (m1 — validateRoomId на filename)
- Modify: `apps/backend/src/envelope.ts` (m3 — types fix для lastTouched/elementCount)
- Modify: `apps/backend/src/index.ts` (m4 — WS upgrade validateRoomId, close code 4422)
- Modify: `apps/backend/src/rooms.ts` (m5 — evictIdle вызывает flushIfDirty не store.save)
- Modify: `apps/backend/src/config.ts` (m6 — экспорт `__resetConfigForTests()`)

- [ ] **Step 1: m1 — GET /api/rooms id validation**

In `apps/backend/src/routes/rooms.ts`, find the listing handler (where `f.slice(0, -5)` reads filename without .json). Add validation:

```ts
import { validateRoomId } from "../rooms";
// ...
const id = f.slice(0, -5);
if (!validateRoomId(id)) continue;  // filter out malformed filenames
```

Test: добавить в `routes-rooms.test.ts` test "ignores filenames that fail validateRoomId" — pre-seed `storageDir` with `bad name.json`, expect listing skips it.

- [ ] **Step 2: m4 — WS upgrade validates ?room=**

In `apps/backend/src/index.ts:Bun.serve.fetch`, where `srv.upgrade(req, { data: { room } })` happens, validate `room` first:

```ts
import { validateRoomId } from "./rooms";
// ...
const room = url.searchParams.get("room") ?? DEFAULT_ROOM;
if (!validateRoomId(room)) {
  return new Response("invalid room id", { status: 422 });
}
if (srv.upgrade(req, { data: { room } })) return;
```

Test: `tests/ws-validate-room.test.ts` (new file) — open WS with `?room=bad%20name`, expect 422 (HTTP, since upgrade rejected before WS handshake).

- [ ] **Step 3: m5 — evictIdle uses flushIfDirty**

In `apps/backend/src/rooms.ts:evictIdle` (search for the method), replace `await this.store.save(id, s)` with `await this.flushIfDirty(id)`. Reason: flushIfDirty cancels the pending debounce timer; raw store.save doesn't, leading to double-write if both fire.

Test: добавить в `rooms.test.ts` test "evictIdle cancels pending debounce" — set up a dirty room with pending debounce, call evictIdle, assert that `persistence.flushAll()` после этого no-ops (т.е. debounce уже отменён).

- [ ] **Step 4: m3 — envelope types**

In `apps/backend/src/envelope.ts:parseFull`, ensure `lastTouched` and `elementCount` are always set in the returned envelope (either parsed from file or computed from canvas). Fix:

```ts
return {
  schemaVersion: parsed.schemaVersion ?? 1,
  roomId: parsed.roomId ?? id,
  version: parsed.version ?? 0,
  lastTouched: parsed.lastTouched ?? Date.now(),
  elementCount: parsed.elementCount ?? (parsed.canvas?.nodes?.length ?? 0) + (parsed.canvas?.edges?.length ?? 0) + (parsed.canvas?.groups?.length ?? 0),
  canvas: parsed.canvas ?? emptyCanvasState(),
  prompts: parsed.prompts ?? [],
};
```

No new test; existing envelope tests should still pass.

- [ ] **Step 5: m6 — config test reset hook**

In `apps/backend/src/config.ts`, expose a `__resetConfigForTests()` function that clears module-level `_cache`. Add comment that it's test-only.

```ts
let _cache: Config | null = null;
// ...
export function __resetConfigForTests(): void {
  _cache = null;
}
```

No test needed; this is a utility for future tests that change env vars.

- [ ] **Step 6: Run all backend tests**

`cd apps/backend && bun test` → expect prior 178 + 2 new (m1, m4, m5 tests) = 181 pass.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/{config,envelope,index,rooms}.ts apps/backend/src/routes/rooms.ts \
        apps/backend/tests/ws-validate-room.test.ts apps/backend/tests/rooms.test.ts apps/backend/tests/routes-rooms.test.ts
git commit -m "fix(backend): phase 2.0 minor follow-ups — id validation, envelope types, evictIdle flush, config reset"
```

---

## Task 2: Phase 2.1 minor batch (m1, m2, m3)

**Files:**
- Modify: `apps/backend/src/routes/domain.ts` (m1 documenting double bus.publish)
- Modify: `apps/backend/src/domain/context.ts` (m2 — role optional)
- Modify: `apps/backend/src/domain/context.ts` tests (m2 reflection)
- Modify: `apps/frontend/src/canvas/from-canvas-state.ts` (m3 — apply connectionPropsForEdge)

- [ ] **Step 1: m1 — document double bus.publish**

In `apps/backend/src/routes/domain.ts`, find the second `bus.publish(...)` call (the layout writeback one) и добавить comment выше:

```ts
// Intentional second publish: clients receive a two-phase render —
// first the semantic mutation, then the layout-adjusted positions.
// Echo-guard de-dupes own-origin clientOpId; for cross-client, this
// gives a visible "rearrange" animation. Combining into one publish
// would defeat that. See [[phase-2-1-followups]] m1.
bus.publish(id, { ops: posOps, source: "ai", version: room.version });
```

No code change. Just documentation.

- [ ] **Step 2: m2 — role optional on ElementCompact for unknown**

In `apps/backend/src/domain/context.ts:nodeToCompact`, do not default `role` к `"service"`. If `n.meta?.role` отсутствует — `role` поле в `ElementCompact` omit. Change `ElementCompact` type to `role?: Role`.

```ts
export type ElementCompact = {
  id: string;
  role?: Role;
  label?: string;
  parent?: string;
  pinned?: true;
};

function nodeToCompact(canvas: CanvasState, n: Node): ElementCompact {
  const out: ElementCompact = { id: (n.meta?.name as string) ?? n.id };
  const role = n.meta?.role as Role | undefined;
  if (role) out.role = role;
  // ... rest unchanged
}
```

Update context tests:
- `summary.byRole` уже handles undefined через `(n.meta?.role as Role | undefined) ?? "service"`. Replace with: skip nodes without role (or use a sentinel `__unknown` key).

Decision: skip unknown-role nodes in `byRole` count. Add test "nodes without meta.role contribute to total but not to byRole".

- [ ] **Step 3: m3 — use connectionPropsForEdge in from-canvas-state**

In `apps/frontend/src/canvas/from-canvas-state.ts`, find `edgeToShape` (or equivalent that converts `Edge` → tldraw arrow shape). Apply `connectionPropsForEdge(kind)`:

```ts
import { connectionPropsForEdge } from "./role-render";
// ...
const kind = e.meta?.kind as ConnectionKind | undefined;
const connProps = connectionPropsForEdge(kind);
shape.props.dash = connProps.dashed ? "dashed" : "solid";
if (connProps.defaultLabel && !shape.props.text) {
  // ... set as richText placeholder
}
```

(Exact placement depends on existing code; the implementer reads the file.)

Frontend build: `bun run --cwd apps/frontend build` → green.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/routes/domain.ts apps/backend/src/domain/context.ts \
        apps/backend/tests/domain/context.test.ts \
        apps/frontend/src/canvas/from-canvas-state.ts
git commit -m "fix(phase2.1 minor): comment two-phase domain publish; role optional in compact; apply connectionPreset"
```

---

## Task 3: I1 — slug length cap

**Files:**
- Modify: `apps/backend/src/config.ts:slugifyProject` — body length cap.
- Create: `apps/backend/tests/config-slug-length.test.ts`.

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, test } from "bun:test";
import { slugifyProject } from "../src/config";

describe("slugifyProject", () => {
  test("caps body to 246 chars + 9-char sha1 suffix = <=255 total", () => {
    const longPath = "/home/user/" + "a".repeat(250);
    const slug = slugifyProject(longPath);
    expect(slug.length).toBeLessThanOrEqual(255);
  });

  test("slug stays deterministic for same input", () => {
    const p = "/home/user/proj";
    expect(slugifyProject(p)).toBe(slugifyProject(p));
  });
});
```

Run → FAIL.

- [ ] **Step 2: Fix slugifyProject**

```ts
const MAX_BODY = 246;  // 246 + 1 dash + 8 hex = 255
function slugifyProject(path: string): string {
  // ... existing kebab logic produces `body`
  const truncated = body.length > MAX_BODY ? body.slice(0, MAX_BODY) : body;
  // ... append `-${sha1(path).slice(0,8)}`
}
```

Run → PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/config.ts apps/backend/tests/config-slug-length.test.ts
git commit -m "fix(config): cap slugifyProject body to 246 chars (avoid ENAMETOOLONG)"
```

---

## Task 4: I2 + I3 + I5 — rooms import explicit flush + 409 untouched test + existingId

**Files:**
- Modify: `apps/backend/src/routes/rooms.ts`
- Create: `apps/backend/tests/rooms-import-409-content.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// rooms-import-409-content.test.ts
import { describe, expect, test } from "bun:test";
import { makeApp } from "../src/index";

describe("POST /api/rooms/import — 409 semantics", () => {
  test("target untouched on 409", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    // seed target
    const r = await rooms.get("existing");
    r.canvas.nodes.push({ id: "shape:e_a", kind: "rect", x: 0, y: 0, label: "a" });
    // serialize so envelope written; then import with same target
    // ... (set up via real persistence in this test; use tmp dir)
    // Pre-content snapshot
    const before = JSON.stringify(await rooms.get("existing"));
    // Import attempt without force
    const res = await app.fetch(new Request("http://localhost/api/rooms/import?as=existing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ envelope: { /* valid envelope */ } }),
    }));
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; existingId: string };
    expect(body.error).toBe("room exists");
    expect(body.existingId).toBe("existing");
    const after = JSON.stringify(await rooms.get("existing"));
    expect(after).toBe(before);
  });
});
```

Run → FAIL (missing `existingId` in current response).

- [ ] **Step 2: Fix rooms route**

In `apps/backend/src/routes/rooms.ts:importHandler`, where the 409 is returned, add `existingId: targetId`. Also add explicit `await rooms.flushIfDirty(targetId)` before `rooms.evict(targetId)` (I2 explicit flush pattern):

```ts
if (target file exists && !force) {
  return c.json({ ok: false, error: "room exists", existingId: targetId }, 409);
}
await rooms.flushIfDirty(targetId);  // I2: explicit before evict
await rooms.evict(targetId);
// ... write new envelope
```

Run → PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/routes/rooms.ts apps/backend/tests/rooms-import-409-content.test.ts
git commit -m "fix(rooms): 409 import returns existingId; explicit flushIfDirty before evict; target untouched test"
```

---

## Task 5: I4 — workspace isolation tests

**Files:**
- Create: `apps/backend/tests/workspace-isolation.test.ts`

- [ ] **Step 1: Write tests covering spec §4.2**

```ts
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeApp } from "../src/index";

describe("workspace isolation", () => {
  let dir1: string, dir2: string;
  beforeEach(() => { dir1 = mkdtempSync(join(tmpdir(), "didraw-iso-1-")); dir2 = mkdtempSync(join(tmpdir(), "didraw-iso-2-")); });
  afterEach(() => { rmSync(dir1, { recursive: true, force: true }); rmSync(dir2, { recursive: true, force: true }); });

  test("two daemons with SAME storageDir see same rooms", async () => {
    const a = makeApp({ storageDir: dir1 });
    const b = makeApp({ storageDir: dir1 });
    const r1 = await a.rooms.get("shared");
    r1.canvas.nodes.push({ id: "shape:e_a", kind: "rect", x: 0, y: 0, label: "a" });
    await a.rooms.flushIfDirty("shared");
    await b.rooms.evict("shared");  // force re-read from disk
    const r2 = await b.rooms.get("shared");
    expect(r2.canvas.nodes).toHaveLength(1);
  });

  test("two daemons with DIFFERENT storageDir are isolated", async () => {
    const a = makeApp({ storageDir: dir1 });
    const b = makeApp({ storageDir: dir2 });
    const r1 = await a.rooms.get("isolated");
    r1.canvas.nodes.push({ id: "shape:e_x", kind: "rect", x: 0, y: 0, label: "x" });
    await a.rooms.flushIfDirty("isolated");
    const r2 = await b.rooms.get("isolated");
    expect(r2.canvas.nodes).toHaveLength(0);
  });
});
```

Run → PASS если механизм работает корректно.

- [ ] **Step 2: Commit**

```bash
git add apps/backend/tests/workspace-isolation.test.ts
git commit -m "test(backend): workspace isolation — same storageDir shares, different is isolated"
```

---

## Task 6: Phase 2.1 I1 — tsc-strict warnings closure

**Files:**
- Modify: `apps/backend/src/domain/validate.ts`
- Modify: `apps/backend/src/domain/layout-postprocess.ts`
- Modify: `apps/backend/src/domain/layout.ts`
- Modify: `apps/backend/src/routes/context.ts`
- Create: `apps/backend/types.d.ts` (for elkWorkerPath module declaration)

Run first: `cd apps/backend && bun run tsc --noEmit 2>&1 | tail -30` to see current error count baseline.

- [ ] **Step 1: validate.ts — narrow DeleteAction discriminator**

Add explicit narrowing helper:

```ts
function isDeleteWithIds(a: DeleteAction): a is { kind: "delete"; ids: ElementId[]; cascade?: boolean } {
  return "ids" in a;
}
```

Replace `"ids" in a ? a.ids : [a.id]` with the helper or use `for...of actions` (iterator narrows). 

For the `actions[i]` index access errors: refactor to `for (const a of actions)` where possible; for the index-needed cases (errors use `actionIndex: i`), keep index but `const a = actions[i]!`.

- [ ] **Step 2: layout-postprocess.ts — for...of loop**

Replace nested `for (let i; i<...; i++)` with two-pointer `for...of` if possible. Otherwise use `!` assertion on `ids[i]!` after explicit length guard.

- [ ] **Step 3: layout.ts — elkWorkerPath module declaration**

Create `apps/backend/types.d.ts`:
```ts
declare module "*.min.js" {
  const path: string;
  export default path;
}
```

This silences the import-attribute-without-types warning.

- [ ] **Step 4: context.ts — parseViewport tuple narrowing**

After the `.length === 4` guard, narrow via cast:
```ts
if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
const [x, y, w, h] = parts as [number, number, number, number];
return { x, y, w, h };
```

- [ ] **Step 5: Verify tsc clean**

```bash
cd apps/backend && bun run tsc --noEmit
```
Expected: returns to baseline pre-Phase-2.1 (9 pre-existing errors only). Run `bun test` → still 181+ pass.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/domain/{validate,layout-postprocess,layout}.ts \
        apps/backend/src/routes/context.ts apps/backend/types.d.ts
git commit -m "fix(backend): clear ~87 tsc-strict warnings in Phase 2.1 files (noUncheckedIndexedAccess)"
```

---

## Task 7: Phase 2.1 I2 — bounded idempotency cache

**Files:**
- Modify: `apps/backend/src/routes/domain.ts`

- [ ] **Step 1: Write test for bounded cache**

In `tests/routes-domain.test.ts`, add:

```ts
test("idempotency cache evicts oldest entries past max", async () => {
  const { app } = makeApp({ inMemory: true });
  const MAX = 1000;
  // Send MAX+1 unique-clientOpId domain requests
  for (let i = 0; i <= MAX; i++) {
    await postDomain(app, { actions: [{ kind: "define", role: "service", name: `n${i}` }], clientOpId: `op-${i}` });
  }
  // First (op-0) should be evicted now; resending with same id triggers NEW request, not cached
  const before = (await rooms.get("d1")).version;
  const res = await postDomain(app, { actions: [{ kind: "define", role: "service", name: "n0" }], clientOpId: "op-0" });
  const body = await res.json() as { idempotent?: boolean; version: number };
  expect(body.idempotent).toBeFalsy();  // would be true if still cached
});
```

(Test takes ~1-2 seconds due to 1001 requests; acceptable.)

- [ ] **Step 2: Implement LRU bound**

Replace `Map<string, DomainResponse>` with a simple bounded LRU:

```ts
const MAX_IDEMPOTENCY_ENTRIES = 1000;

function makeLruCache<K, V>(max: number) {
  const m = new Map<K, V>();
  return {
    get(k: K): V | undefined {
      const v = m.get(k);
      if (v !== undefined) { m.delete(k); m.set(k, v); }  // bump to most-recent
      return v;
    },
    set(k: K, v: V): void {
      if (m.has(k)) m.delete(k);
      m.set(k, v);
      if (m.size > max) {
        const oldest = m.keys().next().value;
        if (oldest !== undefined) m.delete(oldest);
      }
    },
  };
}

const idempotencyCache = makeLruCache<string, DomainResponse>(MAX_IDEMPOTENCY_ENTRIES);
```

Use inside the route closure (Phase 2.1 fix scoped it там).

Run → PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/routes/domain.ts apps/backend/tests/routes-domain.test.ts
git commit -m "fix(domain): bounded LRU idempotency cache (max 1000 entries)"
```

---

## Task 8: B1.1 — frontend arrow detection (add)

**Files:**
- Modify: `apps/frontend/src/canvas/to-patch.ts`
- Modify: `apps/frontend/src/canvas/id-prefix.ts` (if it has `tlShapeIdToEdgeId` or similar)

**Reference required:** read https://tldraw.dev/docs/shapes#arrow + https://tldraw.dev/docs/bindings — arrow bindings carry `props.terminal: "start" | "end"` and `boundShapeId`. Memory `feedback-tldraw-docs` mandates fetching docs before tldraw code.

- [ ] **Step 1: Remove arrow skip in diffToOps**

Find `if (s.type === "arrow") continue;` lines and replace with arrow handling:

```ts
if (s.type === "arrow") {
  const arrow = s as TLArrowShape;
  // Find bindings for this arrow's start and end terminals
  const bindings = currentBindings.filter((b) => b.fromId === arrow.id);
  const startBinding = bindings.find((b) => b.props.terminal === "start");
  const endBinding = bindings.find((b) => b.props.terminal === "end");

  function endpointFor(binding: TLBinding | undefined, fallbackPos: { x: number; y: number }): Endpoint {
    if (binding) return { kind: "node", id: tlShapeIdToCanvasId(binding.toId) };
    return { kind: "point", x: fallbackPos.x, y: fallbackPos.y };
  }

  const arrowProps = arrow.props as { start: { x: number; y: number }; end: { x: number; y: number }; richText?: unknown; dash?: string };
  const from = endpointFor(startBinding, arrowProps.start);
  const to = endpointFor(endBinding, arrowProps.end);
  const edgeId = tlArrowIdToEdgeId(arrow.id);
  const label = richTextToPlain(arrowProps.richText);
  const dashed = arrowProps.dash === "dashed";

  // If edge already exists in `prev` snapshot, this is an UPDATE; else ADD.
  const prevEdge = prev.edges.find((e) => e.id === edgeId);
  if (!prevEdge) {
    ops.push({ op: "add", target: "edge", value: { id: edgeId, from, to, label, style: { dashed } } });
  } else {
    const set: Record<string, unknown> = {};
    if (!endpointEq(prevEdge.from, from)) set.from = from;
    if (!endpointEq(prevEdge.to, to)) set.to = to;
    if (prevEdge.label !== label) set.label = label;
    if (prevEdge.style?.dashed !== dashed) set.style = { dashed };
    if (Object.keys(set).length > 0) ops.push({ op: "update", target: "edge", id: edgeId, set });
  }
  continue;
}
```

Helpers `tlArrowIdToEdgeId` (probably parallel к `tlShapeIdToCanvasId`) and `endpointEq`, `richTextToPlain` — define in `id-prefix.ts` / `richtext.ts` if not present.

- [ ] **Step 2: Type imports**

Import `TLArrowShape`, `TLBinding` from tldraw. Confirm via fetched docs the exact types.

- [ ] **Step 3: Frontend build + smoke**

`bun run --cwd apps/frontend build` — should be green. Manual smoke not required this step (covered Task 10).

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/canvas/to-patch.ts apps/frontend/src/canvas/id-prefix.ts
git commit -m "feat(frontend): detect user-drawn arrows in diffToOps (B1 — add/update path)"
```

---

## Task 9: B1.2 — frontend arrow delete + inferUserMetadata for edges

**Files:**
- Modify: `apps/frontend/src/canvas/to-patch.ts` (delete detection)
- Modify: `apps/backend/src/routes/patch.ts` (`inferUserMetadata` accepts edge updates)
- Modify: `apps/backend/tests/routes-patch-inference.test.ts` (extend)

- [ ] **Step 1: Detect arrow delete in to-patch**

In the delete-detection loop of `to-patch.ts` (where prev shapes that no longer exist trigger `delete` ops), check if the deleted shape was an arrow and emit `delete edge`:

```ts
for (const prevShape of prev.shapes) {
  if (!currentShapeIds.has(prevShape.id)) {
    if (prevShape.type === "arrow") {
      ops.push({ op: "delete", target: "edge", id: tlArrowIdToEdgeId(prevShape.id) });
    } else {
      ops.push({ op: "delete", target: "node", id: tlShapeIdToCanvasId(prevShape.id) });
    }
  }
}
```

- [ ] **Step 2: Backend inferUserMetadata accepts edge style change**

In `apps/backend/src/routes/patch.ts:inferUserMetadata`, extend to also process `target:"edge"`:

```ts
return ops.map((op) => {
  if (op.op !== "update") return op;
  if (op.target === "node") {
    // existing pin + style logic
  } else if (op.target === "edge") {
    const set = op.set as { style?: unknown; meta?: Record<string, unknown> };
    if (set.style === undefined) return op;
    const current = canvas.edges.find((e) => e.id === op.id);
    const meta = { ...(current?.meta ?? {}), ...(set.meta ?? {}), styleOwnedBy: "user" };
    return { ...op, set: { ...set, meta } };
  }
  return op;
});
```

Update signature: `canvas: { nodes: ..., edges: ... }` (extend type).

- [ ] **Step 3: Test edge styleOwnedBy inference**

In `routes-patch-inference.test.ts`, add:

```ts
test("user updates edge style → meta.styleOwnedBy=user", async () => {
  const { app, rooms } = makeApp({ inMemory: true });
  const r = await rooms.get("test");
  r.canvas.nodes.push({ id: "shape:e_a", kind: "rect", x: 0, y: 0, label: "a" });
  r.canvas.nodes.push({ id: "shape:e_b", kind: "rect", x: 0, y: 0, label: "b" });
  r.canvas.edges.push({ id: "shape:c_0", from: { kind: "node", id: "shape:e_a" }, to: { kind: "node", id: "shape:e_b" } });

  await postPatch(app, [{ op: "update", target: "edge", id: "shape:c_0", set: { style: { dashed: true } } }], "user");
  const edge = (await rooms.get("test")).canvas.edges[0];
  expect((edge.meta as { styleOwnedBy?: string }).styleOwnedBy).toBe("user");
});
```

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/canvas/to-patch.ts apps/backend/src/routes/patch.ts \
        apps/backend/tests/routes-patch-inference.test.ts
git commit -m "feat(B1): frontend arrow delete + backend edge styleOwnedBy inference"
```

---

## Task 10: B1.3 — integration test for arrow roundtrip

**Files:**
- Create: `apps/frontend/playwright/arrow-roundtrip.spec.ts` (если Playwright suite будет добавлен в этом плане; иначе skip + note)
- OR: Create backend-only integration via CLI subprocess (используя 2-х клиентов).

Option chosen: backend integration via `tests/integration/arrow-roundtrip.test.ts` (CLI invokes don't draw arrows; this test seeds via direct patch). We test the contract, not the UI.

- [ ] **Step 1: Write backend test**

```ts
import { describe, expect, test } from "bun:test";
import { makeApp } from "../src/index";

describe("user arrow roundtrip", () => {
  test("add edge op → opLog has it; ws broadcast contains it", async () => {
    const { app, rooms, bus } = makeApp({ inMemory: true });
    const r = await rooms.get("ar1");
    r.canvas.nodes.push({ id: "shape:e_a", kind: "rect", x: 0, y: 0, label: "a" });
    r.canvas.nodes.push({ id: "shape:e_b", kind: "rect", x: 0, y: 0, label: "b" });

    let received: unknown = null;
    bus.subscribe?.("ar1", (msg) => { received = msg; });  // depends on bus API

    const res = await app.fetch(new Request("http://localhost/api/patch?room=ar1", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ops: [{ op: "add", target: "edge", value: { id: "shape:c_user", from: { kind: "node", id: "shape:e_a" }, to: { kind: "node", id: "shape:e_b" }, style: { dashed: false } } }],
        source: "user",
      }),
    }));
    expect(res.status).toBe(200);

    expect((await rooms.get("ar1")).canvas.edges).toHaveLength(1);
    expect((await rooms.get("ar1")).opLog.at(-1)?.ops[0]).toMatchObject({ op: "add", target: "edge" });
  });
});
```

(`bus.subscribe` may need a small extension if not already there — implementer checks.)

- [ ] **Step 2: Commit**

```bash
git add apps/backend/tests/integration/arrow-roundtrip.test.ts
git commit -m "test(B1): backend integration test for user-arrow add via /api/patch"
```

---

## Task 11: Durable opLog — envelope schemaVersion 2

**Files:**
- Modify: `apps/backend/src/envelope.ts`
- Modify: `apps/backend/src/persistence.ts`
- Create: `apps/backend/tests/envelope-oplog-roundtrip.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// envelope-oplog-roundtrip.test.ts
import { describe, expect, test } from "bun:test";
import { parseFull, serialize } from "../src/envelope";
import { makeRoomState } from "../src/rooms";

describe("envelope opLog roundtrip", () => {
  test("v2 envelope persists opLog and round-trips", () => {
    const s = makeRoomState();
    s.opLog.push({ ops: [], source: "ai", version: 1, at: 100 });
    s.opLog.push({ ops: [], source: "user", version: 2, at: 200 });
    const json = serialize("room1", s);
    const env = parseFull(JSON.parse(json), "room1");
    expect(env.opLog).toBeDefined();
    expect(env.opLog).toHaveLength(2);
    expect(env.opLog?.[1].version).toBe(2);
  });

  test("v1 envelope reads with empty opLog", () => {
    const v1 = { schemaVersion: 1, roomId: "r", version: 5, canvas: { nodes: [], edges: [], groups: [] }, prompts: [] };
    const env = parseFull(v1, "r");
    expect(env.schemaVersion).toBe(1);
    expect(env.opLog).toEqual([]);
  });

  test("serialized envelope has schemaVersion 2", () => {
    const s = makeRoomState();
    const json = serialize("room1", s);
    const parsed = JSON.parse(json);
    expect(parsed.schemaVersion).toBe(2);
  });
});
```

Run → FAIL.

- [ ] **Step 2: Bump envelope schema**

In `apps/backend/src/envelope.ts`:
- Update `PersistedEnvelope` type: `schemaVersion: 1 | 2;  opLog?: OpLogEntry[]`.
- `serialize`: always emits `schemaVersion: 2` + `opLog: state.opLog.slice(-config.opLogMaxSize)`.
- `parseFull`: if `schemaVersion === 1`, set `opLog: []`. If `=== 2`, parse `opLog ?? []`.

- [ ] **Step 3: persistence.ts restores opLog**

In `apps/backend/src/persistence.ts:load`, where it currently does `opLog: []`, replace with `opLog: envelope.opLog ?? []`. Now restart-survivable.

- [ ] **Step 4: Run tests**

`cd apps/backend && bun test` → all green (including new envelope-oplog test).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/envelope.ts apps/backend/src/persistence.ts \
        apps/backend/tests/envelope-oplog-roundtrip.test.ts
git commit -m "feat(persist): envelope schemaVersion 2 with durable opLog; v1 reads with empty log"
```

---

## Task 12: WS hello/replay — server side

**Files:**
- Modify: `apps/backend/src/index.ts` (websocket.message handler)
- Modify: `apps/backend/src/types.ts` (WsMessage union extension)
- Create: `apps/backend/tests/ws-hello-replay.test.ts`

- [ ] **Step 1: Extend WsMessage union**

```ts
// types.ts
export type WsClientMessage =
  | { kind: "hello"; lastVersion: number };

export type WsMessage =
  | { kind: "hello"; version: number }  // legacy initial
  | { kind: "sync-ack"; version: number }
  | { kind: "replay"; ops: OpLogEntry[]; version: number }
  | { kind: "truncated"; version: number }
  | { kind: "patch"; ops: PatchOp[]; source: "ai" | "user"; version: number; originClientId?: string };
```

- [ ] **Step 2: Implement server message handler**

In `apps/backend/src/index.ts:websocket.message`:

```ts
async message(ws, raw) {
  const { room } = ws.data as { room: string };
  let msg: WsClientMessage;
  try { msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)); }
  catch { return; }
  if (msg.kind === "hello") {
    const r = await rooms.get(room);
    const last = msg.lastVersion ?? 0;
    if (last >= r.version) {
      ws.send(JSON.stringify({ kind: "sync-ack", version: r.version }));
      return;
    }
    const minLogVer = r.opLog[0]?.version ?? (r.version + 1);
    if (last + 1 >= minLogVer) {
      const replay = r.opLog.filter(e => e.version > last);
      ws.send(JSON.stringify({ kind: "replay", ops: replay, version: r.version }));
    } else {
      ws.send(JSON.stringify({ kind: "truncated", version: r.version }));
    }
  }
}
```

- [ ] **Step 3: Tests**

```ts
// ws-hello-replay.test.ts — uses Bun's WS client + real server
describe("WS hello/replay", () => {
  test("sync-ack when client up-to-date", async () => { /* ... */ });
  test("replay sends ops since lastVersion", async () => { /* ... */ });
  test("truncated when gap exceeds opLog window", async () => { /* ... */ });
  test("malformed hello is ignored (no crash)", async () => { /* ... */ });
});
```

(Use `Bun.serve` test setup similar to existing CLI integration tests; spawn server with `startServer({inMemory: true, port: 0})`, open ws via `new WebSocket(...)`.)

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/index.ts apps/backend/src/types.ts apps/backend/tests/ws-hello-replay.test.ts
git commit -m "feat(ws): hello/replay protocol — client lastVersion → server sync-ack | replay | truncated"
```

---

## Task 13: WS hello/replay — frontend side

**Files:**
- Modify: `apps/frontend/src/transport/ws.ts`
- Modify: `apps/frontend/src/App.tsx`

- [ ] **Step 1: Track lastReceivedVersion in ws client**

In `apps/frontend/src/transport/ws.ts`, expose `lastReceivedVersion` state (closure or argument). On open, send `{kind: "hello", lastVersion: lastReceivedVersion}`. Handle server replies:

```ts
ws.onopen = () => {
  ws.send(JSON.stringify({ kind: "hello", lastVersion: lastReceivedVersion }));
};

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.kind === "sync-ack") {
    lastReceivedVersion = msg.version;
  } else if (msg.kind === "replay") {
    // apply each op via existing patch handler
    for (const entry of msg.ops) {
      handlePatch(entry);
    }
    lastReceivedVersion = msg.version;
  } else if (msg.kind === "truncated") {
    // fall back to full state fetch
    void onTruncated();
    lastReceivedVersion = msg.version;
  } else if (msg.kind === "patch") {
    handlePatch(msg);
    lastReceivedVersion = msg.version;
  }
  // legacy {kind: "hello", version} — ignore (handled by initial state fetch)
};
```

- [ ] **Step 2: Wire onTruncated callback**

In `App.tsx`, expose a callback that re-fetches `GET /api/state` and replaces canvas. Pass into `connectWs(...)`.

- [ ] **Step 3: Test (manual smoke since Playwright suite absent)**

Run dev server, open browser, observe network: WS connect → outgoing `{kind:"hello",lastVersion:0}` → incoming `{kind:"replay" | "sync-ack"}`. Document smoke steps in commit body.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/transport/ws.ts apps/frontend/src/App.tsx
git commit -m "feat(ws): client hello with lastVersion; apply replay/sync-ack/truncated"
```

---

## Task 14: ErrorBanner — no-silent-fail surface

**Files:**
- Create: `apps/frontend/src/state/error-bus.ts`
- Create: `apps/frontend/src/chrome/ErrorBanner.tsx`
- Modify: `apps/frontend/src/transport/api.ts`
- Modify: `apps/frontend/src/App.tsx`

- [ ] **Step 1: Error bus**

```ts
// state/error-bus.ts
type ErrItem = { id: string; text: string; at: number };
type Listener = (errors: ErrItem[]) => void;
const items: ErrItem[] = [];
const listeners = new Set<Listener>();
const TTL_MS = 5000;

export function pushError(text: string): void {
  const item = { id: crypto.randomUUID(), text, at: Date.now() };
  items.unshift(item);
  if (items.length > 5) items.pop();
  notify();
  setTimeout(() => {
    const idx = items.findIndex(i => i.id === item.id);
    if (idx >= 0) { items.splice(idx, 1); notify(); }
  }, TTL_MS);
}

export function subscribeErrors(l: Listener): () => void { listeners.add(l); l([...items]); return () => listeners.delete(l); }
function notify(): void { for (const l of listeners) l([...items]); }
```

- [ ] **Step 2: ErrorBanner component**

```tsx
// chrome/ErrorBanner.tsx
import { useEffect, useState } from "react";
import { subscribeErrors } from "../state/error-bus";

export function ErrorBanner() {
  const [errs, setErrs] = useState<Array<{id:string;text:string;at:number}>>([]);
  useEffect(() => subscribeErrors(setErrs), []);
  if (errs.length === 0) return null;
  return (
    <div style={{ position: "fixed", top: 12, right: 12, display: "flex", flexDirection: "column", gap: 8, zIndex: 9999, maxWidth: 320, pointerEvents: "none" }}>
      {errs.map(e => (
        <div key={e.id} style={{ background: "#c1273a", color: "white", padding: "8px 12px", borderRadius: 6, boxShadow: "0 2px 8px rgba(0,0,0,0.2)" }}>{e.text}</div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Wire api.ts**

In `apps/frontend/src/transport/api.ts`, where `sendPatch` (and `sendDomain` if exists) handle `!ok` responses, call `pushError(\`patch rejected: ${error}\`)`.

- [ ] **Step 4: Mount ErrorBanner in App.tsx**

Add `<ErrorBanner />` near the top-level layout (outside Tldraw chrome but inside app root).

- [ ] **Step 5: Manual smoke**

Send invalid patch via curl: `curl -X POST 'http://localhost:8788/api/patch?room=default' -H 'content-type: application/json' -d '{"ops":[{"op":"add","target":"node","value":{"id":"shape:e_dup"}},{"op":"add","target":"node","value":{"id":"shape:e_dup"}}],"source":"user"}'` → expect 422. Open browser → banner appears.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/state/error-bus.ts apps/frontend/src/chrome/ErrorBanner.tsx \
        apps/frontend/src/transport/api.ts apps/frontend/src/App.tsx
git commit -m "feat(frontend): ErrorBanner surfaces backend 422 reasons (no-silent-fail)"
```

---

## Task 15: CHANGELOG + version 0.3.0 + tag

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `package.json` (root): 0.2.0 → 0.3.0
- Modify: `.claude/skills/draw/SKILL.md` (one-line note that user arrows are now persisted)
- Tag: `v0.3.0`

- [ ] **Step 1: Add CHANGELOG entry**

Insert before `## 0.2.0 — 2026-05-16`:

```markdown
## 0.3.0 — 2026-05-NN

### Phase 2.2 — Sync hardening + user-arrows

**Round-trip:**
- User-drawn arrows in tldraw теперь персистятся в backend как `Edge` ops (B1). Bindings → `Endpoint{kind:"node",id}`; floating endpoints → `Endpoint{kind:"point",x,y}`. Style/label/dashed honored.

**Persistence:**
- `PersistedEnvelope` bumped schemaVersion 1→2: добавлено `opLog: OpLogEntry[]` (capped at `opLogMaxSize`). v1 envelopes читаются с empty opLog (lossy для существующих файлов; expected); первая write апгрейдит файл.

**WS sync:**
- Hello/replay protocol: client отправляет `{kind:"hello", lastVersion}` на reconnect; server отвечает `sync-ack` (in-sync), `replay` (delta) или `truncated` (gap exceeds opLog window — client refetches state).
- Legacy clients без hello получают initial state через старый GET path (compat preserved).

**No-silent-fail:**
- Rejected backend patches (422 на `/api/patch`, `/api/domain`) surface в frontend `ErrorBanner` (top-right toast, 5s TTL).

**Fixed (Phase 2.0 follow-ups):**
- Slug length capped (I1); rooms import explicit flushIfDirty (I2); 409 untouched test (I3); workspace isolation tests (I4); 409 import response carries `existingId` (I5); GET /api/rooms filename id validation (m1); envelope `lastTouched`/`elementCount` types (m3); WS upgrade validates `?room=` (m4); `evictIdle` uses `flushIfDirty` (m5); config test reset hook (m6).

**Fixed (Phase 2.1 follow-ups):**
- ~87 tsc-strict warnings cleared (I1); idempotency cache bounded LRU max 1000 (I2); two-phase domain bus.publish documented (m1); `nodeToCompact.role` optional для unknown nodes (m2); `connectionPropsForEdge` теперь применяется в `edgeToShape` (m3, dead export resolved).
```

- [ ] **Step 2: Bump version**

`package.json`: `"version": "0.2.0"` → `"0.3.0"`. If `release/VERSION` exists, sync.

- [ ] **Step 3: One-line skill note**

In `.claude/skills/draw/SKILL.md`, add at end of "User overrides — respect them" section:

```
User-drawn arrows are now round-tripped to backend (Phase 2.2). They appear in `context` as connections with `meta.styleOwnedBy:"user"` if user-styled.
```

- [ ] **Step 4: Final test**

```bash
cd /Users/tretyakov_dv/Projects/sandbox/di.draw && bun run test
```

Expected: all packages green.

- [ ] **Step 5: Commit + tag**

```bash
git add CHANGELOG.md package.json .claude/skills/draw/SKILL.md
[ -f release/VERSION ] && git add release/VERSION
git commit -m "release: 0.3.0 — Phase 2.2 sync hardening + user-arrows + follow-ups"
git tag v0.3.0
```

---

## Self-Review

### Spec coverage check

| Spec section | Task(s) |
|---|---|
| §2 B1 user-arrows detection | Task 8 (add), 9 (delete + edge style infer), 10 (roundtrip test) |
| §3 opLog persistence | Task 11 (envelope v2 + persistence load) |
| §4 Versioned WS sync | Task 12 (server), Task 13 (client) |
| §5 No-silent-fail | Task 14 (ErrorBanner) |
| §6 Followups closure | Tasks 1 (2.0 minor), 2 (2.1 minor), 3-5 (2.0 important), 6-7 (2.1 important) |

### Placeholder scan
- Task 8 says "(Exact placement depends on existing code)" — acceptable, implementer reads file.
- Task 10 uses `bus.subscribe?.` — may need a small bus API addition; flagged как DONE_WITH_CONCERNS if missing.

### Type consistency
- `WsClientMessage.kind: "hello"` matches server expectation в Task 12.
- `OpLogEntry` used identically across envelope (Task 11), WS replay (Task 12), client apply (Task 13).
- `Endpoint` union (kind:"node"|"point") reused в B1 (Task 8).

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-16-di-draw-phase2-2-sync-hardening-implementation.md`.**

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, batched review per `feedback-batched-reviews`.
2. **Inline Execution** — same session via `superpowers:executing-plans` with checkpoints.

Which approach?
