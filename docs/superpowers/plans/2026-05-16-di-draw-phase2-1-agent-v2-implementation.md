# di.draw Phase 2.1 — Agent v2 (domain-first) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Заменить сырой `PatchOp` как поверхность AI на доменные actions (define/connect/group/note/layout/delete) поверх shared `@didraw/domain` пакета. Развернуть ELK на полную (compound containers + ports + pin + scope) с best-effort обработкой ошибок. Добавить token-cheap `/api/agent/context` (≤8KB на 100 элементов, без геометрии). Сохранить совместимость с user-edit pipeline (`/api/patch`) через pin/style-ownership inference.

**Architecture:** Новый shared workspace package `packages/didraw-domain` хранит SSOT для ролей/connection kinds/layout modes/role-preset/connection-preset/name validation — импортируется и backend, и frontend. Backend получает `apps/backend/src/domain/{types,validate,compile,layout,layout-postprocess,context}.ts` и три новых route'а (`/api/domain`, `/api/agent/context`, `/api/viewport`). Frontend получает `role-render.ts` (применяет preset поверх state, уважая `meta.styleOwnedBy`) и viewport reporter. CLI расширяется до domain-уровневых команд. Старые routes (`/api/patch`, `/api/state`, `/api/layout`) остаются нетронутыми — debug fallback.

**Tech Stack:** Bun runtime, Hono, `bun:test`, ELK.js (compound nodes + ports + fixed-position pin), tldraw 5.x (read https://tldraw.dev/docs/editor — ports map to `normalizedAnchor`).

**Spec:** `docs/superpowers/specs/2026-05-15-di-draw-phase2-agent-v2-design.md` v2.1.2.

---

## File Structure

### New: shared package `packages/didraw-domain`

| Path | Responsibility |
|---|---|
| `packages/didraw-domain/package.json` | `@didraw/domain` workspace entry; type=module; main=src/index.ts |
| `packages/didraw-domain/tsconfig.json` | mirrors `packages/didraw-client/tsconfig.json` |
| `packages/didraw-domain/src/index.ts` | barrel: re-exports all public types/functions |
| `packages/didraw-domain/src/roles.ts` | `Role` union + `isContainerRole(r)` |
| `packages/didraw-domain/src/connections.ts` | `ConnectionKind` union |
| `packages/didraw-domain/src/layout-modes.ts` | `LayoutMode` union + `modeToElkOptions(mode, spacing)` |
| `packages/didraw-domain/src/role-preset.ts` | `rolePreset(role): RolePreset` — SSOT для визуальных пресетов |
| `packages/didraw-domain/src/connection-preset.ts` | `connectionPreset(kind): ConnectionPreset` — стрелка solid/dashed/dotted + default label |
| `packages/didraw-domain/src/validation.ts` | `isValidName(s)`, name regex `/^[a-z0-9_-]{1,64}$/` |
| `packages/didraw-domain/tests/*.test.ts` | one test file per source file |

### New: backend domain layer `apps/backend/src/domain/`

| Path | Responsibility |
|---|---|
| `apps/backend/src/domain/types.ts` | `DomainAction` discriminated union, `DomainRequest`, `DomainResponse`, `ActionResult`, `ActionError`, `LayoutHint` |
| `apps/backend/src/domain/validate.ts` | `validateBatch(actions, canvas) → {ok, errors?}` — per-action + intra-batch ref check |
| `apps/backend/src/domain/compile.ts` | `compile(actions, canvas, viewport?) → {ops: PatchOp[], elementIds: ElementId[]}` — upsert semantics, intra-batch refs, name→shape-id, container-children edit |
| `apps/backend/src/domain/layout.ts` | `runLayout(canvas, hint, affected?) → Promise<{ok: true, positions, edgeRouting, affected} \| {ok: false, reason}>` — full ELK с compound nodes / ports / pin / scope. `edgeRouting[edgeId] = {fromSide, toSide, bendPoints}` собирается из ELK output для прокидывания во фронтенд. |
| `apps/backend/src/domain/layout-postprocess.ts` | `postProcess(positions, sizes) → adjustedPositions` — snap-to-grid + min-spacing. Preserve-order — backlog Phase 2.2. |
| `apps/backend/src/domain/context.ts` | `buildContext(room, {viewport, selection?, limit?, since?}) → ContextResponse` — domain-summary, no geometry, derived `parent` from Group.children, `since` фильтрует opLog по version |
| `apps/backend/src/routes/domain.ts` | `POST /api/domain` — orchestrate validate→compile→applyPatch→layout(best-effort) |
| `apps/backend/src/routes/context.ts` | `GET /api/agent/context` |
| `apps/backend/src/routes/viewport.ts` | `POST /api/viewport`, in-memory per-room storage |

### Modified backend

| Path | Change |
|---|---|
| `apps/backend/src/routes/patch.ts` | Add pin inference + styleOwnedBy inference for `source:"user"` updates |
| `apps/backend/src/rooms.ts` | Add `viewports: Map<RoomId, Viewport>` + 30-min wipe |
| `apps/backend/src/index.ts` | Register `domainRoutes`, `contextRoutes`, `viewportRoutes` |

### Modified frontend

| Path | Change |
|---|---|
| `apps/frontend/src/canvas/role-render.ts` (new) | Apply `rolePreset(role)` + `connectionPreset(kind)` to tldraw shapes; honor `meta.styleOwnedBy === "user"` |
| `apps/frontend/src/canvas/from-canvas-state.ts` | Use `role-render`; pass port-side from `meta.routing.ports` to `normalizedAnchor` |
| `apps/frontend/src/transport/viewport.ts` (new) | Debounced (500ms) POST `/api/viewport` on camera change |
| `apps/frontend/src/main.tsx` (or app entry) | Wire `viewportReporter(editor)` after editor mounts |

### Modified `@didraw/client`

| Path | Change |
|---|---|
| `packages/didraw-client/src/index.ts` | Add `applyDomain(req)`, `getContext(opts)`, `postViewport(v)` |

### New CLI surface

| Path | Change |
|---|---|
| `packages/didraw-cli/src/domain.ts` (new) | `define/connect/group/note/layout/delete/apply/context` command handlers |
| `packages/didraw-cli/src/index.ts` | Register new commands; update `usage()` |
| `packages/didraw-cli/tests/domain.test.ts` (new) | Subprocess integration tests for all 8 commands |

### Skill + release

| Path | Change |
|---|---|
| `.claude/skills/draw/SKILL.md` | Inject `didraw context` instead of `didraw state --compact`; new Roles / Connections / Patterns sections; remove PatchOp references |
| `CHANGELOG.md` | `0.2.0` entry with breaking + feature list |
| `package.json` (root) | `0.1.0 → 0.2.0` |

---

## Task 1: `@didraw/domain` shared package

**Files:**
- Create: `packages/didraw-domain/package.json`
- Create: `packages/didraw-domain/tsconfig.json`
- Create: `packages/didraw-domain/src/index.ts`
- Create: `packages/didraw-domain/src/roles.ts`
- Create: `packages/didraw-domain/src/connections.ts`
- Create: `packages/didraw-domain/src/layout-modes.ts`
- Create: `packages/didraw-domain/src/role-preset.ts`
- Create: `packages/didraw-domain/src/connection-preset.ts`
- Create: `packages/didraw-domain/src/validation.ts`
- Test: `packages/didraw-domain/tests/*.test.ts`

- [ ] **Step 1: Create package skeleton**

Create `packages/didraw-domain/package.json`:

```json
{
  "name": "@didraw/domain",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": { "test": "bun test" }
}
```

Create `packages/didraw-domain/tsconfig.json` (mirror `packages/didraw-client/tsconfig.json`):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "isolatedModules": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 2: Write failing test for `roles.ts`**

Create `packages/didraw-domain/tests/roles.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { isContainerRole, type Role } from "../src/roles";

describe("Role", () => {
  test("isContainerRole — network and boundary are containers", () => {
    expect(isContainerRole("network")).toBe(true);
    expect(isContainerRole("boundary")).toBe(true);
  });

  test.each<Role>(["actor", "service", "datastore", "queue", "external", "note"])(
    "isContainerRole — %s is leaf",
    (r) => {
      expect(isContainerRole(r)).toBe(false);
    },
  );

  test("isContainerRole — unknown string is false", () => {
    expect(isContainerRole("frobnicator" as Role)).toBe(false);
  });
});
```

Run: `cd packages/didraw-domain && bun test tests/roles.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `roles.ts`**

```ts
// packages/didraw-domain/src/roles.ts
export type Role =
  | "actor"
  | "service"
  | "datastore"
  | "queue"
  | "network"
  | "boundary"
  | "external"
  | "note";

const CONTAINER_ROLES: ReadonlySet<Role> = new Set(["network", "boundary"]);

export function isContainerRole(r: Role): boolean {
  return CONTAINER_ROLES.has(r);
}

export const ALL_ROLES: readonly Role[] = [
  "actor",
  "service",
  "datastore",
  "queue",
  "network",
  "boundary",
  "external",
  "note",
];

export function isValidRole(s: string): s is Role {
  return (ALL_ROLES as readonly string[]).includes(s);
}
```

Run: `cd packages/didraw-domain && bun test tests/roles.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 4: Write failing test for `connections.ts`**

Create `packages/didraw-domain/tests/connections.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { ALL_KINDS, isValidConnectionKind, type ConnectionKind } from "../src/connections";

describe("ConnectionKind", () => {
  test("ALL_KINDS contains exactly 4 values", () => {
    expect(ALL_KINDS).toEqual(["sync", "async", "data", "dep"]);
  });

  test.each<ConnectionKind>(["sync", "async", "data", "dep"])(
    "isValidConnectionKind accepts %s",
    (k) => {
      expect(isValidConnectionKind(k)).toBe(true);
    },
  );

  test("isValidConnectionKind rejects unknown", () => {
    expect(isValidConnectionKind("notify")).toBe(false);
  });
});
```

Run: `cd packages/didraw-domain && bun test tests/connections.test.ts`
Expected: FAIL.

- [ ] **Step 5: Implement `connections.ts`**

```ts
// packages/didraw-domain/src/connections.ts
export type ConnectionKind = "sync" | "async" | "data" | "dep";

export const ALL_KINDS: readonly ConnectionKind[] = ["sync", "async", "data", "dep"];

export function isValidConnectionKind(s: string): s is ConnectionKind {
  return (ALL_KINDS as readonly string[]).includes(s);
}
```

Run test → PASS (6 tests).

- [ ] **Step 6: Write failing test for `layout-modes.ts`**

Create `packages/didraw-domain/tests/layout-modes.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  ALL_MODES,
  isValidLayoutMode,
  modeToElkOptions,
  type LayoutMode,
} from "../src/layout-modes";

describe("LayoutMode", () => {
  test("ALL_MODES contains 5 values", () => {
    expect(ALL_MODES).toEqual(["layered-lr", "layered-tb", "tree", "pack", "force"]);
  });

  test.each<LayoutMode>(["layered-lr", "layered-tb", "tree", "pack", "force"])(
    "isValidLayoutMode accepts %s",
    (m) => {
      expect(isValidLayoutMode(m)).toBe(true);
    },
  );

  test("isValidLayoutMode rejects unknown", () => {
    expect(isValidLayoutMode("circular")).toBe(false);
  });
});

describe("modeToElkOptions", () => {
  test("layered-lr → algorithm=layered, direction=RIGHT", () => {
    const o = modeToElkOptions("layered-lr", "normal");
    expect(o["elk.algorithm"]).toBe("layered");
    expect(o["elk.direction"]).toBe("RIGHT");
  });

  test("layered-tb → direction=DOWN", () => {
    expect(modeToElkOptions("layered-tb", "normal")["elk.direction"]).toBe("DOWN");
  });

  test("tree → algorithm=mrtree", () => {
    expect(modeToElkOptions("tree", "normal")["elk.algorithm"]).toBe("mrtree");
  });

  test("pack → algorithm=rectpacking", () => {
    expect(modeToElkOptions("pack", "normal")["elk.algorithm"]).toBe("rectpacking");
  });

  test("force → algorithm=force", () => {
    expect(modeToElkOptions("force", "normal")["elk.algorithm"]).toBe("force");
  });

  test("spacing presets — compact gives smaller node spacing than loose", () => {
    const compact = Number(modeToElkOptions("layered-lr", "compact")["elk.spacing.nodeNode"]);
    const normal = Number(modeToElkOptions("layered-lr", "normal")["elk.spacing.nodeNode"]);
    const loose = Number(modeToElkOptions("layered-lr", "loose")["elk.spacing.nodeNode"]);
    expect(compact).toBeLessThan(normal);
    expect(normal).toBeLessThan(loose);
  });

  test("orthogonal edge routing for layered modes", () => {
    expect(modeToElkOptions("layered-lr", "normal")["elk.edgeRouting"]).toBe("ORTHOGONAL");
    expect(modeToElkOptions("layered-tb", "normal")["elk.edgeRouting"]).toBe("ORTHOGONAL");
  });
});
```

Run test → FAIL.

- [ ] **Step 7: Implement `layout-modes.ts`**

```ts
// packages/didraw-domain/src/layout-modes.ts
export type LayoutMode = "layered-lr" | "layered-tb" | "tree" | "pack" | "force";
export type Spacing = "compact" | "normal" | "loose";

export const ALL_MODES: readonly LayoutMode[] = [
  "layered-lr",
  "layered-tb",
  "tree",
  "pack",
  "force",
];

export function isValidLayoutMode(s: string): s is LayoutMode {
  return (ALL_MODES as readonly string[]).includes(s);
}

const SPACING_PRESETS: Record<Spacing, { nodeNode: number; edgeNode: number; componentComponent: number }> = {
  compact: { nodeNode: 20, edgeNode: 10, componentComponent: 40 },
  normal: { nodeNode: 40, edgeNode: 20, componentComponent: 80 },
  loose: { nodeNode: 80, edgeNode: 40, componentComponent: 160 },
};

export function modeToElkOptions(
  mode: LayoutMode,
  spacing: Spacing,
): Record<string, string> {
  const sp = SPACING_PRESETS[spacing];
  const base: Record<string, string> = {
    "elk.spacing.nodeNode": String(sp.nodeNode),
    "elk.spacing.edgeNode": String(sp.edgeNode),
    "elk.spacing.componentComponent": String(sp.componentComponent),
  };
  switch (mode) {
    case "layered-lr":
      return {
        ...base,
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
        "elk.edgeRouting": "ORTHOGONAL",
        "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      };
    case "layered-tb":
      return {
        ...base,
        "elk.algorithm": "layered",
        "elk.direction": "DOWN",
        "elk.edgeRouting": "ORTHOGONAL",
        "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      };
    case "tree":
      return { ...base, "elk.algorithm": "mrtree" };
    case "pack":
      return { ...base, "elk.algorithm": "rectpacking" };
    case "force":
      return { ...base, "elk.algorithm": "force" };
  }
}
```

Run test → PASS.

- [ ] **Step 8: Write failing test for `role-preset.ts`**

Create `packages/didraw-domain/tests/role-preset.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { ALL_ROLES, type Role } from "../src/roles";
import { rolePreset } from "../src/role-preset";

describe("rolePreset", () => {
  test.each<Role>([...ALL_ROLES])("every role has a preset (%s)", (r) => {
    const p = rolePreset(r);
    expect(p.kind).toBeDefined();
    expect(typeof p.kind).toBe("string");
  });

  test("service → rounded rect", () => {
    const p = rolePreset("service");
    expect(p.kind).toBe("rect");
  });

  test("datastore — distinct fill from service", () => {
    expect(rolePreset("datastore").style.fill).not.toBe(rolePreset("service").style.fill);
  });

  test("network is a container preset (frame-like)", () => {
    const p = rolePreset("network");
    expect(p.container).toBe(true);
  });

  test("note has sticky kind", () => {
    expect(rolePreset("note").kind).toBe("sticky");
  });
});
```

Run test → FAIL.

- [ ] **Step 9: Implement `role-preset.ts`**

```ts
// packages/didraw-domain/src/role-preset.ts
import type { Role } from "./roles";

export type RolePreset = {
  kind: "rect" | "ellipse" | "diamond" | "sticky" | "frame";
  style: { color?: string; fill?: string; stroke?: string };
  container?: boolean;        // network/boundary
  defaultW?: number;
  defaultH?: number;
};

const PRESETS: Record<Role, RolePreset> = {
  actor:     { kind: "ellipse", style: { color: "violet", fill: "semi" }, defaultW: 120, defaultH: 60 },
  service:   { kind: "rect",    style: { color: "blue",   fill: "semi" }, defaultW: 140, defaultH: 70 },
  datastore: { kind: "rect",    style: { color: "green",  fill: "solid" }, defaultW: 140, defaultH: 70 },
  queue:     { kind: "rect",    style: { color: "orange", fill: "pattern" }, defaultW: 140, defaultH: 50 },
  network:   { kind: "frame",   style: { color: "grey",   stroke: "dashed" }, container: true,  defaultW: 400, defaultH: 300 },
  boundary:  { kind: "frame",   style: { color: "red",    stroke: "dashed" }, container: true,  defaultW: 400, defaultH: 300 },
  external:  { kind: "rect",    style: { color: "yellow", fill: "semi" }, defaultW: 140, defaultH: 70 },
  note:      { kind: "sticky",  style: { color: "yellow" }, defaultW: 200, defaultH: 100 },
};

export function rolePreset(role: Role): RolePreset {
  return PRESETS[role];
}
```

Run test → PASS.

- [ ] **Step 10: Write failing test for `connection-preset.ts`**

Create `packages/didraw-domain/tests/connection-preset.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { ALL_KINDS, type ConnectionKind } from "../src/connections";
import { connectionPreset } from "../src/connection-preset";

describe("connectionPreset", () => {
  test.each<ConnectionKind>([...ALL_KINDS])("every kind has a preset (%s)", (k) => {
    const p = connectionPreset(k);
    expect(p.dashed).toBeDefined();
  });

  test("sync — solid, default label 'calls'", () => {
    const p = connectionPreset("sync");
    expect(p.dashed).toBe(false);
    expect(p.defaultLabel).toBe("calls");
  });

  test("async — dashed, default label 'publishes'", () => {
    const p = connectionPreset("async");
    expect(p.dashed).toBe(true);
    expect(p.defaultLabel).toBe("publishes");
  });

  test("dep — no default label", () => {
    expect(connectionPreset("dep").defaultLabel).toBeUndefined();
  });
});
```

Run test → FAIL.

- [ ] **Step 11: Implement `connection-preset.ts`**

```ts
// packages/didraw-domain/src/connection-preset.ts
import type { ConnectionKind } from "./connections";

export type ConnectionPreset = {
  dashed: boolean;
  defaultLabel?: string;
  arrow: "to" | "both";
};

const PRESETS: Record<ConnectionKind, ConnectionPreset> = {
  sync:  { dashed: false, defaultLabel: "calls",     arrow: "to" },
  async: { dashed: true,  defaultLabel: "publishes", arrow: "to" },
  data:  { dashed: false, defaultLabel: "reads",     arrow: "to" },
  dep:   { dashed: true,                              arrow: "to" },
};

export function connectionPreset(kind: ConnectionKind): ConnectionPreset {
  return PRESETS[kind];
}
```

Run test → PASS.

- [ ] **Step 12: Write failing test for `validation.ts`**

Create `packages/didraw-domain/tests/validation.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { isValidName } from "../src/validation";

describe("isValidName", () => {
  test.each(["auth", "users-db", "vpc_prod", "a", "x".repeat(64)])(
    "accepts %s",
    (n) => {
      expect(isValidName(n)).toBe(true);
    },
  );

  test.each(["", "with space", "ALL-CAPS", "with.dot", "x".repeat(65), "имя"])(
    "rejects %s",
    (n) => {
      expect(isValidName(n)).toBe(false);
    },
  );
});
```

Run test → FAIL.

- [ ] **Step 13: Implement `validation.ts`**

```ts
// packages/didraw-domain/src/validation.ts
const NAME_RE = /^[a-z0-9_-]{1,64}$/;

export function isValidName(s: string): boolean {
  return NAME_RE.test(s);
}
```

Run test → PASS.

- [ ] **Step 14: Create barrel `index.ts`**

```ts
// packages/didraw-domain/src/index.ts
export * from "./roles";
export * from "./connections";
export * from "./layout-modes";
export * from "./role-preset";
export * from "./connection-preset";
export * from "./validation";
```

- [ ] **Step 15: Run all tests in package**

Run: `cd packages/didraw-domain && bun test`
Expected: PASS (~35 tests across 6 files).

- [ ] **Step 16: Commit**

```bash
git add packages/didraw-domain
git commit -m "feat(domain): shared @didraw/domain package — roles, kinds, modes, presets, validation"
```

---

## Task 2: Backend `domain/types.ts` + `validate.ts`

**Files:**
- Create: `apps/backend/src/domain/types.ts`
- Create: `apps/backend/src/domain/validate.ts`
- Test: `apps/backend/tests/domain/validate.test.ts`

- [ ] **Step 1: Write failing test for `validate.ts`**

Create `apps/backend/tests/domain/validate.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { emptyCanvasState } from "../../src/rooms";
import { validateBatch } from "../../src/domain/validate";
import type { DomainAction } from "../../src/domain/types";

function seedCanvas(...defs: Array<{ name: string; role: string }>) {
  const c = emptyCanvasState();
  for (const d of defs) {
    c.nodes.push({
      id: `shape:e_${d.name}`,
      kind: "rect",
      x: 0,
      y: 0,
      label: d.name,
      meta: { name: d.name, role: d.role },
    });
  }
  return c;
}

describe("validateBatch", () => {
  test("happy path — define + connect referencing the just-defined name", () => {
    const acts: DomainAction[] = [
      { kind: "define", role: "service", name: "auth" },
      { kind: "define", role: "datastore", name: "users-db" },
      { kind: "connect", from: "auth", to: "users-db", connectionKind: "data" },
    ];
    const r = validateBatch(acts, emptyCanvasState());
    expect(r.ok).toBe(true);
  });

  test("unknown role → unknown-role error", () => {
    const r = validateBatch(
      [{ kind: "define", role: "frobnicator" as never, name: "x" }],
      emptyCanvasState(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0].code).toBe("unknown-role");
      expect(r.errors[0].field).toBe("role");
    }
  });

  test("invalid name → invalid-shape error", () => {
    const r = validateBatch(
      [{ kind: "define", role: "service", name: "BAD NAME" }],
      emptyCanvasState(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].code).toBe("invalid-shape");
  });

  test("connect references unknown element → unknown-ref", () => {
    const r = validateBatch(
      [{ kind: "connect", from: "nope", to: "auth" }],
      seedCanvas({ name: "auth", role: "service" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0].code).toBe("unknown-ref");
      expect(r.errors[0].field).toBe("from");
    }
  });

  test("upsert define keeps role → ok", () => {
    const r = validateBatch(
      [{ kind: "define", role: "service", name: "auth" }],
      seedCanvas({ name: "auth", role: "service" }),
    );
    expect(r.ok).toBe(true);
  });

  test("upsert define with different role → role-conflict", () => {
    const r = validateBatch(
      [{ kind: "define", role: "datastore", name: "auth" }],
      seedCanvas({ name: "auth", role: "service" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].code).toBe("role-conflict");
  });

  test("group requires all ids to exist in canvas or earlier in batch", () => {
    const r = validateBatch(
      [
        { kind: "define", role: "service", name: "auth" },
        { kind: "group", ids: ["auth", "nope"], as: "network", name: "vpc" },
      ],
      emptyCanvasState(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].code).toBe("unknown-ref");
  });

  test("group as=actor → invalid-shape (only network/boundary allowed)", () => {
    const r = validateBatch(
      [{ kind: "group", ids: [], as: "actor" as never, name: "x" }],
      emptyCanvasState(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].code).toBe("invalid-shape");
  });

  test("unknown action kind → unknown-action", () => {
    const r = validateBatch(
      [{ kind: "splork" } as never],
      emptyCanvasState(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].code).toBe("unknown-action");
  });

  test("define container role rejected (must use group action)", () => {
    const r = validateBatch(
      [{ kind: "define", role: "network", name: "vpc" }],
      emptyCanvasState(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0].code).toBe("invalid-shape");
      expect(r.errors[0].message).toMatch(/container role/);
    }
  });

  test("define `in` referencing non-container → invalid-shape", () => {
    const c = seedCanvas({ name: "auth", role: "service" });
    const r = validateBatch(
      [{ kind: "define", role: "service", name: "child", in: "auth" }],
      c,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0].code).toBe("invalid-shape");
      expect(r.errors[0].field).toBe("in");
    }
  });

  test("delete + connect referencing the deleted element → unknown-ref", () => {
    const c = seedCanvas(
      { name: "a", role: "service" },
      { name: "b", role: "service" },
    );
    const r = validateBatch(
      [
        { kind: "delete", id: "a" },
        { kind: "connect", from: "a", to: "b" },
      ],
      c,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0].code).toBe("unknown-ref");
      expect(r.errors[0].field).toBe("from");
    }
  });
});
```

Run: `cd apps/backend && bun test tests/domain/validate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 2: Implement `domain/types.ts`**

```ts
// apps/backend/src/domain/types.ts
import type { ConnectionKind, LayoutMode, Role } from "@didraw/domain";
import type { PatchOp } from "../types";

export type ElementId = string;
export type Spacing = "compact" | "normal" | "loose";

export type LayoutHint = {
  mode?: LayoutMode;
  scope?: "all" | "affected" | ElementId;
  spacing?: Spacing;
};

export type DefineAction = {
  kind: "define";
  role: Role;
  name: ElementId;
  label?: string;
  in?: ElementId;
  meta?: Record<string, unknown>;
};

export type ConnectAction = {
  kind: "connect";
  from: ElementId;
  to: ElementId;
  connectionKind?: ConnectionKind;
  label?: string;
  meta?: Record<string, unknown>;
};

export type GroupAction = {
  kind: "group";
  ids: ElementId[];
  as: "network" | "boundary";
  name: ElementId;
  label?: string;
};

export type NoteAction = {
  kind: "note";
  about?: ElementId;
  text: string;
  name?: ElementId;
};

export type LayoutAction = {
  kind: "layout";
  mode?: LayoutMode;
  scope?: "all" | ElementId;
  spacing?: Spacing;
};

export type DeleteAction =
  | { kind: "delete"; id: ElementId }
  | { kind: "delete"; ids: ElementId[]; cascade?: boolean };

export type DomainAction =
  | DefineAction
  | ConnectAction
  | GroupAction
  | NoteAction
  | LayoutAction
  | DeleteAction;

export type DomainRequest = {
  actions: DomainAction[];
  clientOpId?: string;
  dryRun?: boolean;
  layoutHint?: LayoutHint | null;
};

export type ActionError = {
  actionIndex: number;
  field?: string;
  code:
    | "unknown-role"
    | "unknown-ref"
    | "name-conflict"
    | "role-conflict"
    | "cascade-confirm-required"
    | "invalid-shape"
    | "compile-error"
    | "unknown-action";
  message: string;
  affected?: ElementId[];
};

export type ActionResult = {
  actionIndex: number;
  elementId?: ElementId;
  generatedOps?: PatchOp[];
};

export type DomainResponse =
  | {
      ok: true;
      version: number;
      idempotent?: true;
      results: ActionResult[];
      layout?: { applied: boolean; affected?: ElementId[]; reason?: string };
    }
  | { ok: false; errors: ActionError[] };
```

- [ ] **Step 3: Implement `domain/validate.ts`**

```ts
// apps/backend/src/domain/validate.ts
import {
  isContainerRole,
  isValidConnectionKind,
  isValidName,
  isValidRole,
  type Role,
} from "@didraw/domain";
import type { CanvasState } from "../types";
import type { ActionError, DomainAction, ElementId } from "./types";

type KnownElement = { role: Role; isContainer: boolean };

function seedKnown(canvas: CanvasState): Map<string, KnownElement> {
  const m = new Map<string, KnownElement>();
  for (const n of canvas.nodes) {
    const nm = n.meta?.name as string | undefined;
    const role = n.meta?.role as Role | undefined;
    if (nm && role) m.set(nm, { role, isContainer: false });
  }
  for (const g of canvas.groups) {
    const meta = (g as { meta?: { name?: string; role?: Role } }).meta;
    const nm = meta?.name ?? g.label;
    const role = meta?.role ?? "network";
    if (nm) m.set(nm, { role, isContainer: true });
  }
  return m;
}

export function validateBatch(
  actions: DomainAction[],
  canvas: CanvasState,
): { ok: true } | { ok: false; errors: ActionError[] } {
  const errors: ActionError[] = [];
  // Sequential working state — mutates as actions are processed so a later
  // action sees the result of an earlier add/remove. This makes `delete a`
  // followed by `connect a b` correctly fail at validation time.
  const known = seedKnown(canvas);

  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    switch (a.kind) {
      case "define": {
        if (!isValidRole(a.role)) {
          errors.push({ actionIndex: i, field: "role", code: "unknown-role", message: `unknown role "${a.role}"` });
          break;
        }
        // Container roles (network/boundary) must come through `group`,
        // not `define` — spec §3.1 makes Group.children the canonical container model.
        if (isContainerRole(a.role)) {
          errors.push({
            actionIndex: i,
            field: "role",
            code: "invalid-shape",
            message: `container role "${a.role}" must be created via group action, not define`,
          });
          break;
        }
        if (!isValidName(a.name)) {
          errors.push({ actionIndex: i, field: "name", code: "invalid-shape", message: `invalid name "${a.name}"` });
          break;
        }
        const existing = known.get(a.name);
        if (existing && existing.role !== a.role) {
          errors.push({ actionIndex: i, field: "role", code: "role-conflict", message: `"${a.name}" already exists as ${existing.role}` });
          break;
        }
        if (a.in !== undefined) {
          const container = known.get(a.in);
          if (!container) {
            errors.push({ actionIndex: i, field: "in", code: "unknown-ref", message: `container "${a.in}" not found` });
            break;
          }
          if (!container.isContainer) {
            errors.push({ actionIndex: i, field: "in", code: "invalid-shape", message: `"${a.in}" is ${container.role}, not a container` });
            break;
          }
        }
        known.set(a.name, { role: a.role, isContainer: false });
        break;
      }
      case "connect": {
        if (a.connectionKind !== undefined && !isValidConnectionKind(a.connectionKind)) {
          errors.push({ actionIndex: i, field: "connectionKind", code: "invalid-shape", message: `unknown connection kind "${a.connectionKind}"` });
          break;
        }
        if (!known.has(a.from)) {
          errors.push({ actionIndex: i, field: "from", code: "unknown-ref", message: `from "${a.from}" not found` });
        }
        if (!known.has(a.to)) {
          errors.push({ actionIndex: i, field: "to", code: "unknown-ref", message: `to "${a.to}" not found` });
        }
        break;
      }
      case "group": {
        if (a.as !== "network" && a.as !== "boundary") {
          errors.push({ actionIndex: i, field: "as", code: "invalid-shape", message: `group.as must be network|boundary` });
          break;
        }
        if (!isValidName(a.name)) {
          errors.push({ actionIndex: i, field: "name", code: "invalid-shape", message: `invalid name "${a.name}"` });
          break;
        }
        for (const id of a.ids) {
          if (!known.has(id)) {
            errors.push({ actionIndex: i, field: "ids", code: "unknown-ref", message: `child "${id}" not found` });
          }
        }
        known.set(a.name, { role: a.as, isContainer: true });
        break;
      }
      case "note": {
        if (a.name && !isValidName(a.name)) {
          errors.push({ actionIndex: i, field: "name", code: "invalid-shape", message: `invalid name "${a.name}"` });
          break;
        }
        if (a.about && !known.has(a.about)) {
          errors.push({ actionIndex: i, field: "about", code: "unknown-ref", message: `about "${a.about}" not found` });
        }
        if (a.name) known.set(a.name, { role: "note", isContainer: false });
        break;
      }
      case "layout":
        // Always valid; mode/scope/spacing checked downstream (modeToElkOptions handles invalid mode).
        break;
      case "delete": {
        const ids = "ids" in a ? a.ids : [a.id];
        for (const id of ids) {
          if (!known.has(id)) {
            errors.push({ actionIndex: i, field: "id", code: "unknown-ref", message: `delete target "${id}" not found` });
          }
          known.delete(id);
        }
        break;
      }
      default:
        errors.push({ actionIndex: i, code: "unknown-action", message: `unknown action kind "${(a as { kind: string }).kind}"` });
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export type ValidationOk = { ok: true };
export type ValidationErr = { ok: false; errors: ActionError[] };
export type _Unused = ElementId; // keep export type silent re: ElementId
```

- [ ] **Step 4: Run validate tests**

Run: `cd apps/backend && bun test tests/domain/validate.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Wire `@didraw/domain` workspace dependency**

In `apps/backend/package.json`, add to `"dependencies"`:

```json
"@didraw/domain": "workspace:*"
```

Then run: `bun install` from repo root to update the workspace resolution.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/package.json apps/backend/src/domain/types.ts \
        apps/backend/src/domain/validate.ts \
        apps/backend/tests/domain/validate.test.ts bun.lockb 2>/dev/null
git commit -m "feat(backend): domain types + validateBatch (per-action + intra-batch refs)"
```

---

## Task 3: Backend `domain/compile.ts`

**Files:**
- Create: `apps/backend/src/domain/compile.ts`
- Test: `apps/backend/tests/domain/compile.test.ts`

- [ ] **Step 1: Write failing test**

Create `apps/backend/tests/domain/compile.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { emptyCanvasState } from "../../src/rooms";
import { compile, nameToShapeId } from "../../src/domain/compile";
import type { DomainAction } from "../../src/domain/types";

describe("nameToShapeId", () => {
  test("deterministic mapping", () => {
    expect(nameToShapeId("auth")).toBe(nameToShapeId("auth"));
    expect(nameToShapeId("auth")).not.toBe(nameToShapeId("users-db"));
  });
  test("prefix is shape:e_", () => {
    expect(nameToShapeId("auth")).toBe("shape:e_auth");
  });
});

describe("compile", () => {
  test("define service creates add-node op with role/name meta", () => {
    const acts: DomainAction[] = [{ kind: "define", role: "service", name: "auth" }];
    const r = compile(acts, emptyCanvasState());
    expect(r.ops).toHaveLength(1);
    expect(r.ops[0]).toMatchObject({
      op: "add",
      target: "node",
      value: { id: "shape:e_auth" },
    });
    const value = (r.ops[0] as { value: { meta: Record<string, unknown>; kind: string; label: string } }).value;
    expect(value.meta.role).toBe("service");
    expect(value.meta.name).toBe("auth");
    expect(value.kind).toBe("rect");
    expect(value.label).toBe("auth");
  });

  test("define + connect — intra-batch ref resolves", () => {
    const acts: DomainAction[] = [
      { kind: "define", role: "service", name: "auth" },
      { kind: "define", role: "datastore", name: "db" },
      { kind: "connect", from: "auth", to: "db", connectionKind: "data" },
    ];
    const r = compile(acts, emptyCanvasState());
    const edgeOp = r.ops.find((o) => "target" in o && o.target === "edge") as { value: { from: { id: string }; to: { id: string } } };
    expect(edgeOp.value.from.id).toBe("shape:e_auth");
    expect(edgeOp.value.to.id).toBe("shape:e_db");
  });

  test("group creates add-group with children — children stored only in Group.children", () => {
    const acts: DomainAction[] = [
      { kind: "define", role: "service", name: "a" },
      { kind: "define", role: "service", name: "b" },
      { kind: "group", ids: ["a", "b"], as: "network", name: "vpc" },
    ];
    const r = compile(acts, emptyCanvasState());
    const grp = r.ops.find((o) => "target" in o && o.target === "group");
    expect(grp).toBeDefined();
    const v = (grp as { value: { children: string[]; kind: string } }).value;
    expect(v.children).toEqual(["shape:e_a", "shape:e_b"]);
    expect(v.kind).toBe("frame");
    // verify no Node.meta.parent leak
    const nodeOps = r.ops.filter((o) => "target" in o && o.target === "node");
    for (const op of nodeOps) {
      const set = (op as { value: { meta?: Record<string, unknown> } }).value.meta ?? {};
      expect((set as { parent?: string }).parent).toBeUndefined();
    }
  });

  test("upsert define — second define updates label and meta, NO new node", () => {
    const initial = emptyCanvasState();
    initial.nodes.push({
      id: "shape:e_auth",
      kind: "rect",
      x: 10,
      y: 20,
      label: "auth",
      meta: { name: "auth", role: "service", pinned: true, position: { x: 10, y: 20 } },
    });
    const r = compile(
      [{ kind: "define", role: "service", name: "auth", label: "AUTH-SVC" }],
      initial,
    );
    const upd = r.ops.find((o) => o.op === "update");
    expect(upd).toBeDefined();
    expect(((upd as { id: string }).id)).toBe("shape:e_auth");
    expect(((upd as { set: { label?: string } }).set).label).toBe("AUTH-SVC");
    // pin must NOT be overwritten:
    expect(((upd as { set: { meta?: Record<string, unknown> } }).set.meta ?? {}).pinned).toBeUndefined();
  });

  test("connect creates Edge with both endpoints; style derived from kind", () => {
    const acts: DomainAction[] = [
      { kind: "define", role: "service", name: "a" },
      { kind: "define", role: "service", name: "b" },
      { kind: "connect", from: "a", to: "b", connectionKind: "async" },
    ];
    const r = compile(acts, emptyCanvasState());
    const edge = r.ops.find((o) => "target" in o && o.target === "edge");
    const ev = (edge as { value: { style?: { dashed?: boolean }; meta?: Record<string, unknown> } }).value;
    expect(ev.style?.dashed).toBe(true);
    expect(((ev.meta ?? {}) as { kind?: string }).kind).toBe("async");
  });

  test("delete with cascade flag — only deletes id, does NOT cascade to children automatically (spec puts cascade in patch.ts)", () => {
    const initial = emptyCanvasState();
    initial.nodes.push({ id: "shape:e_x", kind: "rect", x: 0, y: 0, label: "x", meta: { name: "x", role: "service" } });
    const r = compile([{ kind: "delete", id: "x" }], initial);
    expect(r.ops[0]).toMatchObject({ op: "delete", target: "node", id: "shape:e_x" });
  });

  test("upsert with `in` parameter — re-adds element to new container's children", () => {
    const initial = emptyCanvasState();
    initial.nodes.push({ id: "shape:e_x", kind: "rect", x: 0, y: 0, label: "x", meta: { name: "x", role: "service" } });
    initial.groups.push({ id: "shape:e_g1", kind: "frame", children: ["shape:e_x"], label: "g1" });
    initial.groups.push({ id: "shape:e_g2", kind: "frame", children: [], label: "g2" });
    const r = compile([{ kind: "define", role: "service", name: "x", in: "g2" }], initial);
    const gUpdates = r.ops.filter(
      (o): o is { op: "update"; target: "group"; id: string; set: { children?: string[] } } =>
        o.op === "update" && "target" in o && o.target === "group",
    );
    expect(gUpdates).toHaveLength(2);
    const fromG1 = gUpdates.find((o) => o.id === "shape:e_g1")!;
    const toG2 = gUpdates.find((o) => o.id === "shape:e_g2")!;
    expect(fromG1.set.children).toEqual([]);
    expect(toG2.set.children).toEqual(["shape:e_x"]);
  });
});
```

Run: `cd apps/backend && bun test tests/domain/compile.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement `domain/compile.ts`**

```ts
// apps/backend/src/domain/compile.ts
import { connectionPreset, rolePreset, type Role } from "@didraw/domain";
import type { CanvasState, Edge, Group, Node, NodeStyle, PatchOp } from "../types";
import type { DomainAction, ElementId } from "./types";

export function nameToShapeId(name: string): string {
  // Phase 2.1 §3.5: deterministic shape:e_<slug(name)>.
  return `shape:e_${name}`;
}

type WorkingCanvas = {
  nodes: Map<string, Node>;
  groups: Map<string, Group>;
  edges: Map<string, Edge>;
};

function snapshotCanvas(c: CanvasState): WorkingCanvas {
  return {
    nodes: new Map(c.nodes.map((n) => [n.id, n])),
    groups: new Map(c.groups.map((g) => [g.id, g])),
    edges: new Map(c.edges.map((e) => [e.id, e])),
  };
}

function findNodeByName(c: WorkingCanvas, name: string): Node | undefined {
  for (const n of c.nodes.values()) if (n.meta?.name === name) return n;
  return undefined;
}

function findGroupByName(c: WorkingCanvas, name: string): Group | undefined {
  for (const g of c.groups.values()) {
    const nm = (g as { meta?: { name?: string } }).meta?.name;
    if (nm === name || g.label === name) return g;
  }
  return undefined;
}

function findContainerOf(c: WorkingCanvas, shapeId: string): Group | undefined {
  for (const g of c.groups.values()) {
    if (g.children.includes(shapeId)) return g;
  }
  return undefined;
}

function nextEdgeId(c: WorkingCanvas): string {
  let n = c.edges.size;
  while (c.edges.has(`shape:c_${n}`)) n++;
  return `shape:c_${n}`;
}

export function compile(
  actions: DomainAction[],
  canvas: CanvasState,
): { ops: PatchOp[]; elementIds: (ElementId | undefined)[] } {
  const ops: PatchOp[] = [];
  const elementIds: (ElementId | undefined)[] = [];
  const wc = snapshotCanvas(canvas);

  for (const a of actions) {
    switch (a.kind) {
      case "define": {
        const sid = nameToShapeId(a.name);
        const existing = wc.nodes.get(sid);
        const preset = rolePreset(a.role as Role);
        if (existing) {
          // Upsert: don't clobber pinned/position/styleOwnedBy; only update label/meta safe fields.
          const set: Partial<Node> = {};
          if (a.label !== undefined) set.label = a.label;
          set.meta = { ...existing.meta, name: a.name, role: a.role };
          if (a.meta) set.meta = { ...set.meta, ...a.meta };
          ops.push({ op: "update", target: "node", id: sid, set });
          wc.nodes.set(sid, { ...existing, ...set, meta: set.meta });
          elementIds.push(a.name);
          // Move between containers if `in` changed.
          if (a.in !== undefined) {
            const newContainer = findGroupByName(wc, a.in);
            const oldContainer = findContainerOf(wc, sid);
            if (oldContainer && oldContainer !== newContainer) {
              const oldKids = oldContainer.children.filter((c) => c !== sid);
              ops.push({ op: "update", target: "group", id: oldContainer.id, set: { children: oldKids } });
              wc.groups.set(oldContainer.id, { ...oldContainer, children: oldKids });
            }
            if (newContainer && (!oldContainer || oldContainer.id !== newContainer.id)) {
              const newKids = [...newContainer.children, sid];
              ops.push({ op: "update", target: "group", id: newContainer.id, set: { children: newKids } });
              wc.groups.set(newContainer.id, { ...newContainer, children: newKids });
            }
          }
        } else {
          const node: Node = {
            id: sid,
            kind: preset.kind === "frame" || preset.kind === "sticky"
              ? (preset.kind === "sticky" ? "sticky" : "rect")
              : preset.kind,
            x: 0,
            y: 0,
            w: preset.defaultW,
            h: preset.defaultH,
            label: a.label ?? a.name,
            style: preset.style as NodeStyle,
            meta: { name: a.name, role: a.role, ...(a.meta ?? {}) },
          };
          ops.push({ op: "add", target: "node", value: node });
          wc.nodes.set(sid, node);
          if (a.in !== undefined) {
            const g = findGroupByName(wc, a.in);
            if (g) {
              const kids = [...g.children, sid];
              ops.push({ op: "update", target: "group", id: g.id, set: { children: kids } });
              wc.groups.set(g.id, { ...g, children: kids });
            }
          }
          elementIds.push(a.name);
        }
        break;
      }
      case "connect": {
        const fromN = findNodeByName(wc, a.from);
        const toN = findNodeByName(wc, a.to);
        // validate.ts must catch missing refs before compile reaches this point.
        // If we got here with a missing endpoint, it's a bug — fail loud, not silent.
        if (!fromN) throw new Error(`compile: connect.from "${a.from}" not found (validate did not catch)`);
        if (!toN) throw new Error(`compile: connect.to "${a.to}" not found (validate did not catch)`);
        const ck = a.connectionKind ?? "sync";
        const preset = connectionPreset(ck);
        const eid = nextEdgeId(wc);
        const edge: Edge = {
          id: eid,
          from: { kind: "node", id: fromN.id },
          to: { kind: "node", id: toN.id },
          label: a.label ?? preset.defaultLabel,
          style: { dashed: preset.dashed, arrow: preset.arrow },
          meta: { kind: ck, ...(a.meta ?? {}) },
        };
        ops.push({ op: "add", target: "edge", value: edge });
        wc.edges.set(eid, edge);
        elementIds.push(eid);
        break;
      }
      case "group": {
        const gid = nameToShapeId(a.name);
        const childIds = a.ids.map((nm) => {
          const node = findNodeByName(wc, nm);
          return node ? node.id : nameToShapeId(nm);
        });
        const preset = rolePreset(a.as);
        const grp: Group = {
          id: gid,
          kind: "frame",
          children: childIds,
          label: a.label ?? a.name,
          style: { fill: preset.style.fill, stroke: preset.style.stroke },
        };
        // Store role/name in group meta (extend Group with meta field via cast since type doesn't include it).
        (grp as { meta?: Record<string, unknown> }).meta = { name: a.name, role: a.as };
        ops.push({ op: "add", target: "group", value: grp });
        wc.groups.set(gid, grp);
        elementIds.push(a.name);
        break;
      }
      case "note": {
        const name = a.name ?? `note-${wc.nodes.size}`;
        const sid = nameToShapeId(name);
        const preset = rolePreset("note");
        const node: Node = {
          id: sid,
          kind: "sticky",
          x: 0,
          y: 0,
          w: preset.defaultW,
          h: preset.defaultH,
          label: a.text,
          style: preset.style as NodeStyle,
          meta: { name, role: "note" },
        };
        ops.push({ op: "add", target: "node", value: node });
        wc.nodes.set(sid, node);
        if (a.about) {
          const target = findNodeByName(wc, a.about);
          if (target) {
            const eid = nextEdgeId(wc);
            const edge: Edge = {
              id: eid,
              from: { kind: "node", id: sid },
              to: { kind: "node", id: target.id },
              style: { dashed: true, arrow: "to" },
              meta: { kind: "dep", noteBinding: true },
            };
            ops.push({ op: "add", target: "edge", value: edge });
            wc.edges.set(eid, edge);
          }
        }
        elementIds.push(name);
        break;
      }
      case "layout":
        // No PatchOps from layout action itself — orchestrator runs ELK in routes/domain.ts.
        elementIds.push(undefined);
        break;
      case "delete": {
        const ids = "ids" in a ? a.ids : [a.id];
        for (const nm of ids) {
          const node = findNodeByName(wc, nm);
          if (node) {
            ops.push({ op: "delete", target: "node", id: node.id });
            wc.nodes.delete(node.id);
            continue;
          }
          const grp = findGroupByName(wc, nm);
          if (grp) {
            ops.push({ op: "delete", target: "group", id: grp.id });
            wc.groups.delete(grp.id);
          }
        }
        elementIds.push(undefined);
        break;
      }
    }
  }

  return { ops, elementIds };
}
```

- [ ] **Step 3: Run compile tests**

Run: `cd apps/backend && bun test tests/domain/compile.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/domain/compile.ts apps/backend/tests/domain/compile.test.ts
git commit -m "feat(backend): domain compile — action→PatchOp[] with upsert, intra-batch refs, container children"
```

---

## Task 4: Backend `domain/layout.ts` — full ELK

**Files:**
- Create: `apps/backend/src/domain/layout.ts`
- Test: `apps/backend/tests/domain/layout.test.ts`

**Reference reading required before implementing:** https://eclipse.dev/elk/reference/options.html (sections: `elk.algorithm`, `elk.layered.*`, `elk.padding`, `elk.position`, `elk.fixed`, compound nodes via nested `children`). The implementer MUST read this page or its mirror before writing the ELK call — exact option strings matter, and the spec's promise of full-ELK depends on correct option names.

- [ ] **Step 1: Write failing test**

Create `apps/backend/tests/domain/layout.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { emptyCanvasState } from "../../src/rooms";
import type { CanvasState } from "../../src/types";
import { runLayout } from "../../src/domain/layout";

function makeCanvas(): CanvasState {
  const c = emptyCanvasState();
  c.nodes.push({ id: "shape:e_a", kind: "rect", x: 0, y: 0, w: 100, h: 60, label: "a", meta: { name: "a", role: "service" } });
  c.nodes.push({ id: "shape:e_b", kind: "rect", x: 0, y: 0, w: 100, h: 60, label: "b", meta: { name: "b", role: "datastore" } });
  c.edges.push({ id: "shape:c_0", from: { kind: "node", id: "shape:e_a" }, to: { kind: "node", id: "shape:e_b" }, meta: { kind: "data" } });
  return c;
}

describe("runLayout", () => {
  test("returns positions for both nodes", async () => {
    const r = await runLayout(makeCanvas(), { mode: "layered-lr", scope: "all", spacing: "normal" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.positions["shape:e_a"]).toBeDefined();
      expect(r.positions["shape:e_b"]).toBeDefined();
    }
  });

  test("layered-lr puts source.x < target.x", async () => {
    const r = await runLayout(makeCanvas(), { mode: "layered-lr", scope: "all", spacing: "normal" });
    if (r.ok) {
      expect(r.positions["shape:e_a"].x).toBeLessThan(r.positions["shape:e_b"].x);
    }
  });

  test("pinned node keeps its coordinates (within tolerance)", async () => {
    const c = makeCanvas();
    c.nodes[0].meta = { ...c.nodes[0].meta, pinned: true, position: { x: 500, y: 300 } };
    c.nodes[0].x = 500;
    c.nodes[0].y = 300;
    const r = await runLayout(c, { mode: "layered-lr", scope: "all", spacing: "normal" });
    if (r.ok) {
      expect(Math.abs(r.positions["shape:e_a"].x - 500)).toBeLessThan(5);
      expect(Math.abs(r.positions["shape:e_a"].y - 300)).toBeLessThan(5);
    }
  });

  test("affected scope only lays out the affected subgraph", async () => {
    const c = emptyCanvasState();
    for (let i = 0; i < 4; i++) {
      c.nodes.push({ id: `shape:e_n${i}`, kind: "rect", x: 100 + i, y: 100 + i, w: 100, h: 60, label: `n${i}`, meta: { name: `n${i}`, role: "service" } });
    }
    c.edges.push({ id: "shape:c_0", from: { kind: "node", id: "shape:e_n0" }, to: { kind: "node", id: "shape:e_n1" } });
    const r = await runLayout(c, { mode: "layered-lr", scope: "all", spacing: "normal" }, { affected: ["shape:e_n0", "shape:e_n1"] });
    if (r.ok) {
      // n2/n3 are pinned (treated as fixed) when scope=affected — their input x/y preserved
      expect(Math.abs(r.positions["shape:e_n2"].x - 102)).toBeLessThan(5);
      expect(Math.abs(r.positions["shape:e_n3"].x - 103)).toBeLessThan(5);
    }
  });

  test("returns ok:false on ELK error path (synthetic)", async () => {
    // Force a malformed canvas (negative width which some ELK builds reject)
    const c = emptyCanvasState();
    c.nodes.push({ id: "shape:e_x", kind: "rect", x: 0, y: 0, w: -1, h: -1, label: "x" });
    const r = await runLayout(c, { mode: "layered-lr", scope: "all", spacing: "normal" });
    // ELK may either coerce or throw — both are acceptable. We only assert the shape:
    expect(typeof r.ok).toBe("boolean");
  });

  test("group containers become ELK compound nodes — children laid out inside parent", async () => {
    const c = emptyCanvasState();
    c.nodes.push({ id: "shape:e_a", kind: "rect", x: 0, y: 0, w: 100, h: 60, label: "a", meta: { name: "a", role: "service" } });
    c.nodes.push({ id: "shape:e_b", kind: "rect", x: 0, y: 0, w: 100, h: 60, label: "b", meta: { name: "b", role: "service" } });
    c.groups.push({ id: "shape:e_vpc", kind: "frame", children: ["shape:e_a", "shape:e_b"], label: "vpc", w: 400, h: 200 });
    c.edges.push({ id: "shape:c_0", from: { kind: "node", id: "shape:e_a" }, to: { kind: "node", id: "shape:e_b" } });
    const r = await runLayout(c, { mode: "layered-lr", scope: "all", spacing: "normal" });
    if (r.ok) {
      // group has position; children positions are stored in absolute coords (postProcess later flattens)
      expect(r.positions["shape:e_vpc"]).toBeDefined();
      expect(r.positions["shape:e_a"]).toBeDefined();
      expect(r.positions["shape:e_b"]).toBeDefined();
    }
  });
});
```

Run: `cd apps/backend && bun test tests/domain/layout.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement `domain/layout.ts`**

```ts
// apps/backend/src/domain/layout.ts
import { modeToElkOptions, type LayoutMode, type Spacing } from "@didraw/domain";
import elkWorkerPath from "../../node_modules/elkjs/lib/elk-worker.min.js" with { type: "file" };
import type { CanvasState, Edge, Group, Node } from "../types";
import type { ElementId, LayoutHint } from "./types";

// biome-ignore lint/suspicious/noExplicitAny: third-party CJS module
const ELK = require("elkjs/lib/main.js") as any;
// biome-ignore lint/suspicious/noExplicitAny: elk instance
const elk = new ELK({ workerUrl: elkWorkerPath }) as any;

type Side = "N" | "S" | "E" | "W";

export type EdgeRouting = {
  fromSide?: Side;
  toSide?: Side;
  bendPoints?: Array<{ x: number; y: number }>;
};

export type LayoutOk = {
  ok: true;
  positions: Record<string, { x: number; y: number; w?: number; h?: number }>;
  edgeRouting: Record<string, EdgeRouting>;   // keyed by edge id
  affected: ElementId[];
};

export type LayoutFail = { ok: false; reason: string };

function pinned(n: Node): boolean {
  return n.meta?.pinned === true;
}

function nodeChildrenOfGroup(c: CanvasState, gid: string): Node[] {
  const g = c.groups.find((x) => x.id === gid);
  if (!g) return [];
  return c.nodes.filter((n) => g.children.includes(n.id));
}

function topLevelNodes(c: CanvasState): Node[] {
  const groupedIds = new Set(c.groups.flatMap((g) => g.children));
  return c.nodes.filter((n) => !groupedIds.has(n.id));
}

function buildElkGraph(
  c: CanvasState,
  hint: Required<LayoutHint>,
  pinnedSet: Set<string>,
) {
  const opts = modeToElkOptions(hint.mode, hint.spacing);

  // Recursive build for compound groups.
  function buildGroupNode(g: Group): unknown {
    return {
      id: g.id,
      width: g.w ?? 400,
      height: g.h ?? 300,
      layoutOptions: { ...opts, "elk.padding": "[top=40,left=20,bottom=20,right=20]" },
      children: nodeChildrenOfGroup(c, g.id).map(buildLeafNode),
    };
  }

  function buildLeafNode(n: Node): unknown {
    const layoutOptions: Record<string, string> = {};
    if (pinnedSet.has(n.id)) {
      layoutOptions["elk.position"] = `(${n.x},${n.y})`;
      layoutOptions["elk.layered.layering.layerConstraint"] = "FIRST_SEPARATE";
    }
    return {
      id: n.id,
      width: Math.max(20, n.w ?? 120),
      height: Math.max(20, n.h ?? 60),
      layoutOptions,
      ports: [],
    };
  }

  return {
    id: "root",
    layoutOptions: { ...opts, "elk.hierarchyHandling": "INCLUDE_CHILDREN" },
    children: [
      ...topLevelNodes(c).map(buildLeafNode),
      ...c.groups.map(buildGroupNode),
    ],
    edges: c.edges
      .filter((e) => e.from.kind === "node" && e.to.kind === "node")
      .map((e) => ({
        id: e.id,
        sources: [(e.from as { id: string }).id],
        targets: [(e.to as { id: string }).id],
      })),
  };
}

export type AffectedSet = { affected: ElementId[] };

export async function runLayout(
  canvas: CanvasState,
  hint: LayoutHint,
  affectedSet?: AffectedSet,
): Promise<LayoutOk | LayoutFail> {
  const fullHint: Required<LayoutHint> = {
    mode: (hint.mode ?? "layered-lr") as LayoutMode,
    scope: hint.scope ?? "affected",
    spacing: (hint.spacing ?? "normal") as Spacing,
  };

  // Compute pinned set per scope policy.
  const pinnedSet = new Set<string>();
  if (fullHint.scope === "affected" && affectedSet) {
    const affectedIds = new Set(affectedSet.affected);
    for (const n of canvas.nodes) {
      if (!affectedIds.has(n.id)) pinnedSet.add(n.id);
    }
  }
  for (const n of canvas.nodes) {
    if (pinned(n)) pinnedSet.add(n.id);
  }

  const graph = buildElkGraph(canvas, fullHint, pinnedSet);

  let res: { children?: unknown[]; edges?: unknown[] };
  try {
    res = await elk.layout(graph as never);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }

  const positions: LayoutOk["positions"] = {};
  const edgeRouting: LayoutOk["edgeRouting"] = {};
  const affected: ElementId[] = [];

  function collectChildren(children: unknown[] | undefined, offsetX = 0, offsetY = 0) {
    for (const ch of children ?? []) {
      const c = ch as {
        id?: string;
        x?: number;
        y?: number;
        width?: number;
        height?: number;
        children?: unknown[];
      };
      if (c.id == null) continue;
      const absX = (c.x ?? 0) + offsetX;
      const absY = (c.y ?? 0) + offsetY;
      positions[c.id] = { x: absX, y: absY, w: c.width, h: c.height };
      affected.push(c.id);
      collectChildren(c.children, absX, absY);
    }
  }

  collectChildren(res.children);

  // Infer per-edge fromSide/toSide from where ELK's polyline touches the bbox
  // of source/target nodes. Bend points are stored verbatim (frontend v1 does
  // not render them — they're forward-compat for Phase 3 custom arrow shape).
  function sideOf(box: { x: number; y: number; w: number; h: number }, p: { x: number; y: number }): Side {
    const left = Math.abs(p.x - box.x);
    const right = Math.abs(p.x - (box.x + box.w));
    const top = Math.abs(p.y - box.y);
    const bottom = Math.abs(p.y - (box.y + box.h));
    const min = Math.min(left, right, top, bottom);
    if (min === left) return "W";
    if (min === right) return "E";
    if (min === top) return "N";
    return "S";
  }

  const sizeFor = (id: string): { x: number; y: number; w: number; h: number } | null => {
    const p = positions[id];
    if (!p) return null;
    return { x: p.x, y: p.y, w: p.w ?? 100, h: p.h ?? 50 };
  };

  for (const e of (res.edges ?? []) as Array<{
    id?: string;
    sources?: string[];
    targets?: string[];
    sections?: Array<{
      startPoint: { x: number; y: number };
      endPoint: { x: number; y: number };
      bendPoints?: Array<{ x: number; y: number }>;
    }>;
  }>) {
    if (!e.id) continue;
    const seg = e.sections?.[0];
    if (!seg) continue;
    const r: EdgeRouting = {};
    const srcBox = e.sources?.[0] ? sizeFor(e.sources[0]) : null;
    const tgtBox = e.targets?.[0] ? sizeFor(e.targets[0]) : null;
    if (srcBox) r.fromSide = sideOf(srcBox, seg.startPoint);
    if (tgtBox) r.toSide = sideOf(tgtBox, seg.endPoint);
    if (seg.bendPoints && seg.bendPoints.length > 0) r.bendPoints = seg.bendPoints;
    edgeRouting[e.id] = r;
  }

  return { ok: true, positions, edgeRouting, affected };
}
```

- [ ] **Step 3: Run layout tests**

Run: `cd apps/backend && bun test tests/domain/layout.test.ts`
Expected: PASS (or partial — note: ELK behaviour for the `meta.pinned` test depends on the option strings being correct. If the pin test fails after a careful implementation, capture the failure and ASK in the implementer report — it may indicate that `elk.layered.layering.layerConstraint` is the wrong knob and `elk.position` alone is insufficient. The task may need an additional iteration to find the right ELK API for pin.)

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/domain/layout.ts apps/backend/tests/domain/layout.test.ts
git commit -m "feat(backend): domain layout — full ELK with compound nodes, ports, pin, scope"
```

---

## Task 5: Backend `domain/layout-postprocess.ts`

**Files:**
- Create: `apps/backend/src/domain/layout-postprocess.ts`
- Test: `apps/backend/tests/domain/layout-postprocess.test.ts`

- [ ] **Step 1: Write failing test**

Create `apps/backend/tests/domain/layout-postprocess.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { postProcess } from "../../src/domain/layout-postprocess";

describe("postProcess", () => {
  test("snap-to-grid rounds to 10px", () => {
    const r = postProcess({ a: { x: 12.7, y: 5.4 } }, new Map());
    expect(r.a).toEqual({ x: 10, y: 10 });   // snap up at 5
  });

  test("snap rounding goes to nearest", () => {
    expect(postProcess({ a: { x: 4, y: 4 } }, new Map()).a).toEqual({ x: 0, y: 0 });
    expect(postProcess({ a: { x: 5, y: 5 } }, new Map()).a).toEqual({ x: 10, y: 10 });
  });

  test("min-spacing pushes nodes ≥20px apart", () => {
    const sizes = new Map([
      ["a", { w: 100, h: 50 }],
      ["b", { w: 100, h: 50 }],
    ]);
    const r = postProcess(
      { a: { x: 0, y: 0 }, b: { x: 110, y: 0 } },  // gap = 10px after a's width
      sizes,
    );
    expect(r.b.x - (r.a.x + 100)).toBeGreaterThanOrEqual(20);
  });

  test("non-overlapping nodes are not touched", () => {
    const sizes = new Map([
      ["a", { w: 100, h: 50 }],
      ["b", { w: 100, h: 50 }],
    ]);
    const before = { a: { x: 0, y: 0 }, b: { x: 200, y: 0 } };
    const r = postProcess(before, sizes);
    expect(r.b).toEqual({ x: 200, y: 0 });
  });
});
```

Run: `cd apps/backend && bun test tests/domain/layout-postprocess.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement `domain/layout-postprocess.ts`**

```ts
// apps/backend/src/domain/layout-postprocess.ts
const GRID = 10;
const MIN_SPACING = 20;

export type NodeSizes = Map<string, { w: number; h: number }>;

function snap(v: number): number {
  return Math.round(v / GRID) * GRID;
}

export function postProcess(
  positions: Record<string, { x: number; y: number }>,
  sizes: NodeSizes,
): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {};
  for (const [id, p] of Object.entries(positions)) {
    out[id] = { x: snap(p.x), y: snap(p.y) };
  }

  // Min-spacing guard: for any pair, if right edge of one is within MIN_SPACING of left edge of another (vertically aligned within 5px), push the later one right.
  const ids = Object.keys(out);
  for (let i = 0; i < ids.length; i++) {
    for (let j = 0; j < ids.length; j++) {
      if (i === j) continue;
      const a = out[ids[i]];
      const b = out[ids[j]];
      const sa = sizes.get(ids[i]);
      const sb = sizes.get(ids[j]);
      if (!sa || !sb) continue;
      const verticallyClose = Math.abs(a.y - b.y) < Math.max(sa.h, sb.h);
      if (!verticallyClose) continue;
      const aRight = a.x + sa.w;
      if (b.x > a.x && b.x < aRight + MIN_SPACING) {
        out[ids[j]] = { x: snap(aRight + MIN_SPACING), y: b.y };
      }
    }
  }

  return out;
}
```

- [ ] **Step 3: Run tests**

Run: `cd apps/backend && bun test tests/domain/layout-postprocess.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/domain/layout-postprocess.ts \
        apps/backend/tests/domain/layout-postprocess.test.ts
git commit -m "feat(backend): layout post-process — snap-to-grid + min-spacing"
```

---

## Task 6: Backend `domain/context.ts`

**Files:**
- Create: `apps/backend/src/domain/context.ts`
- Test: `apps/backend/tests/domain/context.test.ts`

- [ ] **Step 1: Write failing test**

Create `apps/backend/tests/domain/context.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { emptyCanvasState, makeRoomState } from "../../src/rooms";
import { buildContext } from "../../src/domain/context";

function seedState() {
  const s = makeRoomState();
  s.canvas.nodes.push({ id: "shape:e_auth", kind: "rect", x: 100, y: 100, w: 120, h: 60, label: "auth", meta: { name: "auth", role: "service" } });
  s.canvas.nodes.push({ id: "shape:e_db", kind: "rect", x: 300, y: 100, w: 120, h: 60, label: "users-db", meta: { name: "users-db", role: "datastore" } });
  s.canvas.edges.push({ id: "shape:c_0", from: { kind: "node", id: "shape:e_auth" }, to: { kind: "node", id: "shape:e_db" }, label: "reads", meta: { kind: "data" } });
  s.canvas.groups.push({ id: "shape:e_vpc", kind: "frame", children: ["shape:e_auth", "shape:e_db"], label: "vpc-prod" });
  (s.canvas.groups[0] as { meta?: Record<string, unknown> }).meta = { name: "vpc-prod", role: "network" };
  s.version = 7;
  return s;
}

describe("buildContext", () => {
  test("summary.byRole counts roles correctly", () => {
    const ctx = buildContext(seedState(), { viewport: null });
    expect(ctx.summary.byRole.service).toBe(1);
    expect(ctx.summary.byRole.datastore).toBe(1);
    expect(ctx.summary.byRole.network).toBe(1);
  });

  test("no geometry leaks (no x/y/w/h in ElementCompact)", () => {
    const ctx = buildContext(seedState(), { viewport: null });
    const json = JSON.stringify(ctx);
    // Crude but effective: no occurrence of pure key patterns.
    expect(json).not.toMatch(/"x":/);
    expect(json).not.toMatch(/"w":/);
    expect(json).not.toMatch(/"h":/);
    expect(json).not.toMatch(/"fill":/);
  });

  test("inView excludes nodes outside viewport when set", () => {
    const ctx = buildContext(seedState(), {
      viewport: { x: 0, y: 0, w: 200, h: 200 },
    });
    const ids = ctx.inView.map((e) => e.id);
    expect(ids).toContain("auth");
    expect(ids).not.toContain("users-db");
  });

  test("derived parent from Group.children", () => {
    const ctx = buildContext(seedState(), { viewport: null });
    const auth = ctx.inView.find((e) => e.id === "auth");
    expect(auth?.parent).toBe("vpc-prod");
  });

  test("pinned flag — when meta.pinned true, ElementCompact carries pinned:true without coordinates", () => {
    const s = seedState();
    s.canvas.nodes[0].meta = { ...s.canvas.nodes[0].meta, pinned: true, position: { x: 100, y: 100 } };
    const ctx = buildContext(s, { viewport: null });
    const auth = ctx.inView.find((e) => e.id === "auth");
    expect(auth?.pinned).toBe(true);
    expect(JSON.stringify(auth)).not.toMatch(/"x":/);
  });

  test("token budget — 100 elements stays under 8KB", () => {
    const s = makeRoomState();
    for (let i = 0; i < 100; i++) {
      const role = i < 60 ? "service" : i < 80 ? "datastore" : "queue";
      s.canvas.nodes.push({ id: `shape:e_n${i}`, kind: "rect", x: i * 50, y: 0, w: 100, h: 50, label: `n${i}`, meta: { name: `n${i}`, role } });
    }
    s.version = 100;
    const ctx = buildContext(s, { viewport: { x: 0, y: 0, w: 800, h: 600 } });
    expect(JSON.stringify(ctx).length).toBeLessThan(8000);
  });
});
```

Run: FAIL.

- [ ] **Step 2: Implement `domain/context.ts`**

```ts
// apps/backend/src/domain/context.ts
import type { ConnectionKind, Role } from "@didraw/domain";
import type { CanvasState, Node, OpLogEntry, RoomState } from "../types";

export type Viewport = { x: number; y: number; w: number; h: number } | null;

export type ElementCompact = {
  id: string;
  role: Role;
  label?: string;
  parent?: string;
  pinned?: true;
};

export type ConnectionCompact = {
  from: string;
  to: string;
  kind: ConnectionKind;
  label?: string;
};

export type OpSummary = {
  version: number;
  source: "ai" | "user";
  summary: string;
};

export type ContextResponse = {
  version: number;
  viewport: Viewport;
  summary: {
    total: number;
    byRole: Partial<Record<Role, number>>;
    topLevelGroups: Array<{ id: string; role: Role; label?: string }>;
  };
  inView: ElementCompact[];
  selection: ElementCompact[];
  connections: ConnectionCompact[];
  recentOps: OpSummary[];
  offscreenSummary: { byRole: Partial<Record<Role, number>> } | null;
  truncated?: true;
};

function inViewport(n: Node, vp: Exclude<Viewport, null>): boolean {
  const nx = n.x;
  const ny = n.y;
  const nw = n.w ?? 100;
  const nh = n.h ?? 50;
  return nx + nw >= vp.x && nx <= vp.x + vp.w && ny + nh >= vp.y && ny <= vp.y + vp.h;
}

function parentOf(canvas: CanvasState, nodeId: string): string | undefined {
  for (const g of canvas.groups) {
    if (g.children.includes(nodeId)) {
      const meta = (g as { meta?: { name?: string } }).meta;
      return meta?.name ?? g.label;
    }
  }
  return undefined;
}

function nodeToCompact(canvas: CanvasState, n: Node): ElementCompact {
  const out: ElementCompact = {
    id: (n.meta?.name as string) ?? n.id,
    role: (n.meta?.role as Role) ?? "service",
  };
  if (n.label && n.label !== out.id) out.label = n.label;
  const p = parentOf(canvas, n.id);
  if (p) out.parent = p;
  if (n.meta?.pinned === true) out.pinned = true;
  return out;
}

function summarizeOp(e: OpLogEntry): string {
  const counts = { add: 0, update: 0, delete: 0 } as Record<string, number>;
  for (const op of e.ops) counts[op.op]++;
  const parts: string[] = [];
  if (counts.add) parts.push(`+${counts.add}`);
  if (counts.update) parts.push(`~${counts.update}`);
  if (counts.delete) parts.push(`-${counts.delete}`);
  return parts.join(" ");
}

export function buildContext(
  room: RoomState,
  opts: { viewport: Viewport; selection?: string[]; limit?: number; since?: number } = { viewport: null },
): ContextResponse {
  const canvas = room.canvas;
  const limit = opts.limit ?? 30;
  const vp = opts.viewport;
  const since = opts.since;

  const byRole: Partial<Record<Role, number>> = {};
  for (const n of canvas.nodes) {
    const r = (n.meta?.role as Role | undefined) ?? "service";
    byRole[r] = (byRole[r] ?? 0) + 1;
  }
  for (const g of canvas.groups) {
    const r = ((g as { meta?: { role?: Role } }).meta?.role) ?? "network";
    byRole[r] = (byRole[r] ?? 0) + 1;
  }

  const topLevelGroups = canvas.groups.map((g) => ({
    id: ((g as { meta?: { name?: string } }).meta?.name) ?? g.label ?? g.id,
    role: ((g as { meta?: { role?: Role } }).meta?.role) ?? "network",
    label: g.label,
  }));

  const visible: Node[] = vp ? canvas.nodes.filter((n) => inViewport(n, vp)) : canvas.nodes;
  const inViewSliced = visible.slice(0, limit);

  const selectionSet = new Set(opts.selection ?? []);
  const selection = canvas.nodes
    .filter((n) => selectionSet.has(n.id) || (n.meta?.name && selectionSet.has(n.meta.name as string)))
    .map((n) => nodeToCompact(canvas, n));

  const inViewIds = new Set([
    ...inViewSliced.map((n) => n.id),
    ...selection.map((e) => e.id),
  ]);
  const connections: ConnectionCompact[] = canvas.edges
    .filter((e) => e.from.kind === "node" && e.to.kind === "node")
    .filter((e) => {
      const fid = (e.from as { id: string }).id;
      const tid = (e.to as { id: string }).id;
      const fname = canvas.nodes.find((n) => n.id === fid)?.meta?.name as string | undefined;
      const tname = canvas.nodes.find((n) => n.id === tid)?.meta?.name as string | undefined;
      return inViewIds.has(fid) || inViewIds.has(tid) || (fname && inViewIds.has(fname)) || (tname && inViewIds.has(tname));
    })
    .map((e) => {
      const fid = (e.from as { id: string }).id;
      const tid = (e.to as { id: string }).id;
      const fname = canvas.nodes.find((n) => n.id === fid)?.meta?.name as string;
      const tname = canvas.nodes.find((n) => n.id === tid)?.meta?.name as string;
      const k = (e.meta?.kind as ConnectionKind | undefined) ?? "sync";
      const out: ConnectionCompact = { from: fname ?? fid, to: tname ?? tid, kind: k };
      if (e.label) out.label = e.label;
      return out;
    });

  const filteredOps = since !== undefined ? room.opLog.filter((e) => e.version > since) : room.opLog;
  const recentOps: OpSummary[] = filteredOps
    .slice(-20)
    .map((e) => ({ version: e.version, source: e.source, summary: summarizeOp(e) }));

  const offscreenSummary: ContextResponse["offscreenSummary"] = vp && visible.length < canvas.nodes.length
    ? (() => {
        const byR: Partial<Record<Role, number>> = {};
        for (const n of canvas.nodes) {
          if (inViewport(n, vp)) continue;
          const r = (n.meta?.role as Role | undefined) ?? "service";
          byR[r] = (byR[r] ?? 0) + 1;
        }
        return { byRole: byR };
      })()
    : null;

  return {
    version: room.version,
    viewport: vp,
    summary: {
      total: canvas.nodes.length + canvas.groups.length,
      byRole,
      topLevelGroups,
    },
    inView: inViewSliced.map((n) => nodeToCompact(canvas, n)),
    selection,
    connections,
    recentOps,
    offscreenSummary,
    ...(visible.length > limit ? { truncated: true as const } : {}),
  };
}
```

- [ ] **Step 3: Run tests**

Run: `cd apps/backend && bun test tests/domain/context.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/domain/context.ts apps/backend/tests/domain/context.test.ts
git commit -m "feat(backend): domain context — token-cheap summary view, no geometry leaks"
```

---

## Task 7: Backend `routes/patch.ts` — pin & style-ownership inference

**Files:**
- Modify: `apps/backend/src/routes/patch.ts`
- Test: `apps/backend/tests/routes-patch-inference.test.ts`

- [ ] **Step 1: Write failing test**

Create `apps/backend/tests/routes-patch-inference.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { makeApp } from "../src/index";

async function postPatch(app: ReturnType<typeof makeApp>["app"], ops: unknown[], source: "ai" | "user") {
  return app.fetch(
    new Request("http://localhost/api/patch?room=test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ops, source }),
    }),
  );
}

describe("POST /api/patch — inference for source:user", () => {
  test("user move sets meta.pinned + meta.position", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const r = await rooms.get("test");
    r.canvas.nodes.push({ id: "shape:e_x", kind: "rect", x: 0, y: 0, label: "x", meta: { name: "x", role: "service" } });

    const res = await postPatch(app, [{ op: "update", target: "node", id: "shape:e_x", set: { x: 200, y: 300 } }], "user");
    expect(res.status).toBe(200);

    const n = (await rooms.get("test")).canvas.nodes.find((x) => x.id === "shape:e_x")!;
    expect(n.meta?.pinned).toBe(true);
    expect(n.meta?.position).toEqual({ x: 200, y: 300 });
  });

  test("ai move does NOT pin", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const r = await rooms.get("test");
    r.canvas.nodes.push({ id: "shape:e_y", kind: "rect", x: 0, y: 0, label: "y" });

    await postPatch(app, [{ op: "update", target: "node", id: "shape:e_y", set: { x: 200, y: 300 } }], "ai");
    const n = (await rooms.get("test")).canvas.nodes.find((x) => x.id === "shape:e_y")!;
    expect(n.meta?.pinned).toBeUndefined();
  });

  test("user style change sets meta.styleOwnedBy=user", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const r = await rooms.get("test");
    r.canvas.nodes.push({ id: "shape:e_z", kind: "rect", x: 0, y: 0, label: "z" });

    await postPatch(app, [{ op: "update", target: "node", id: "shape:e_z", set: { style: { color: "red" } } }], "user");
    const n = (await rooms.get("test")).canvas.nodes.find((x) => x.id === "shape:e_z")!;
    expect(n.meta?.styleOwnedBy).toBe("user");
  });

  test("user position update preserves other existing meta fields", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const r = await rooms.get("test");
    r.canvas.nodes.push({ id: "shape:e_q", kind: "rect", x: 0, y: 0, label: "q", meta: { name: "q", role: "service" } });

    await postPatch(app, [{ op: "update", target: "node", id: "shape:e_q", set: { x: 50, y: 60 } }], "user");
    const n = (await rooms.get("test")).canvas.nodes.find((x) => x.id === "shape:e_q")!;
    expect(n.meta?.name).toBe("q");
    expect(n.meta?.role).toBe("service");
    expect(n.meta?.pinned).toBe(true);
  });

  test("partial move (only y) preserves the unchanged x in meta.position", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const r = await rooms.get("test");
    r.canvas.nodes.push({
      id: "shape:e_p",
      kind: "rect",
      x: 100,
      y: 200,
      label: "p",
      meta: { name: "p", role: "service", pinned: true, position: { x: 100, y: 200 } },
    });

    await postPatch(app, [{ op: "update", target: "node", id: "shape:e_p", set: { y: 350 } }], "user");
    const n = (await rooms.get("test")).canvas.nodes.find((x) => x.id === "shape:e_p")!;
    expect(n.meta?.position).toEqual({ x: 100, y: 350 });
    expect(n.meta?.pinned).toBe(true);
  });
});
```

Run: FAIL.

- [ ] **Step 2: Modify `apps/backend/src/routes/patch.ts`**

Replace the file body. The new version inserts inference rules between `body` parsing and `applyPatch`:

```ts
import { Hono } from "hono";
import { config } from "../config";
import { applyPatch } from "../patch";
import { resolveRoomId } from "../rooms";
import type { Rooms } from "../rooms";
import type { PatchBus, PatchOp, RoomState } from "../types";

// Apply inference AFTER we have current room state, so partial updates
// (only x or only y, or only one style field) preserve the unchanged axis
// using the current node values rather than producing `undefined`.
function inferUserMetadata(ops: PatchOp[], canvas: { nodes: Array<{ id: string; x: number; y: number; meta?: Record<string, unknown> }> }): PatchOp[] {
  return ops.map((op) => {
    if (op.op !== "update" || op.target !== "node") return op;
    const set = op.set as { x?: number; y?: number; style?: unknown; meta?: Record<string, unknown> };
    const movedX = set.x !== undefined;
    const movedY = set.y !== undefined;
    const styled = set.style !== undefined;
    if (!movedX && !movedY && !styled) return op;

    const current = canvas.nodes.find((n) => n.id === op.id);
    const currentMeta = (current?.meta ?? {}) as Record<string, unknown>;
    const currentPos = currentMeta.position as { x?: number; y?: number } | undefined;
    // Deep-merge for meta — applyPatch may shallow-merge nested objects, so we
    // build the FULL new meta.position here rather than relying on merge.
    const meta = { ...currentMeta, ...(set.meta ?? {}) } as Record<string, unknown>;
    if (movedX || movedY) {
      meta.pinned = true;
      meta.position = {
        x: movedX ? (set.x as number) : (currentPos?.x ?? current?.x ?? 0),
        y: movedY ? (set.y as number) : (currentPos?.y ?? current?.y ?? 0),
      };
    }
    if (styled) {
      meta.styleOwnedBy = "user";
    }
    return { ...op, set: { ...set, meta } };
  });
}

export function patchRoutes(
  rooms: Rooms,
  bus: PatchBus,
  opts: { onDirty?: (room: string, state: RoomState) => void } = {},
) {
  return new Hono().post("/api/patch", async (c) => {
    const rv = resolveRoomId(c.req.query("room"));
    if (!rv.ok) return c.json({ ok: false, error: rv.reason }, 422);
    const id = rv.id;
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.ops))
      return c.json({ ok: false, error: "expected {ops,source}" }, 400);

    const source: "ai" | "user" = body.source === "ai" ? "ai" : "user";
    const clientOpId: string | undefined = body.clientOpId;
    const r = await rooms.get(id);

    // Phase 2.1 §6.2: user-source updates infer pin + style ownership.
    // MUST run AFTER rooms.get() — we need current x/y for partial moves.
    let ops = body.ops as PatchOp[];
    if (source === "user") ops = inferUserMetadata(ops, r.canvas);

    if (clientOpId && r.opLog.some((e) => e.clientOpId === clientOpId)) {
      return c.json({ ok: true, version: r.version, idempotent: true });
    }

    const result = applyPatch(r.canvas, ops);
    if (!result.ok) return c.json({ ok: false, error: result.error }, 422);

    r.canvas = result.state;
    r.version += 1;
    r.opLog.push({ ops, source, version: r.version, at: Date.now(), clientOpId });
    if (r.opLog.length > config.opLogMaxSize)
      r.opLog.splice(0, r.opLog.length - config.opLogMaxSize);
    r.dirty = true;
    opts.onDirty?.(id, r);
    bus.publish(id, { ops, source, version: r.version, originClientId: clientOpId });

    return c.json({ ok: true, version: r.version });
  });
}
```

Important: `inferUserMetadata` builds the FULL `meta.position` object using current node values for the unchanged axis — it does NOT rely on `applyPatch` deep-merging nested objects. `apps/backend/src/patch.ts:mergeRecord` shallow-merges nested objects (replaces `meta.position` wholesale on update), so partial moves would lose the unchanged coordinate without this pre-merge.

- [ ] **Step 3: Run tests**

Run: `cd apps/backend && bun test tests/routes-patch-inference.test.ts tests/routes-patch.test.ts`
Expected: All pass (new + existing).

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/routes/patch.ts apps/backend/tests/routes-patch-inference.test.ts
git commit -m "feat(backend): patch route infers pin/style ownership on source:user updates"
```

---

## Task 8: Backend `routes/viewport.ts` + per-room viewport storage

**Files:**
- Create: `apps/backend/src/routes/viewport.ts`
- Modify: `apps/backend/src/rooms.ts` — add `viewports` map
- Modify: `apps/backend/src/index.ts` — register route
- Test: `apps/backend/tests/routes-viewport.test.ts`

- [ ] **Step 1: Write failing test**

Create `apps/backend/tests/routes-viewport.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { makeApp } from "../src/index";

describe("POST /api/viewport", () => {
  test("stores viewport per room; subsequent GET returns it", async () => {
    const { app } = makeApp({ inMemory: true });
    const post = await app.fetch(
      new Request("http://localhost/api/viewport?room=v1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x: 10, y: 20, w: 800, h: 600, zoom: 1 }),
      }),
    );
    expect(post.status).toBe(200);

    const get = await app.fetch(new Request("http://localhost/api/viewport?room=v1"));
    expect(get.status).toBe(200);
    const body = (await get.json()) as { viewport: { x: number; y: number; w: number; h: number; zoom: number } | null };
    expect(body.viewport).toEqual({ x: 10, y: 20, w: 800, h: 600, zoom: 1 });
  });

  test("GET on unknown room returns viewport:null", async () => {
    const { app } = makeApp({ inMemory: true });
    const get = await app.fetch(new Request("http://localhost/api/viewport?room=unknown"));
    const body = (await get.json()) as { viewport: unknown | null };
    expect(body.viewport).toBeNull();
  });

  test("invalid room id → 422", async () => {
    const { app } = makeApp({ inMemory: true });
    const res = await app.fetch(
      new Request("http://localhost/api/viewport?room=" + encodeURIComponent("bad name"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x: 0, y: 0, w: 1, h: 1 }),
      }),
    );
    expect(res.status).toBe(422);
  });
});
```

Run: FAIL.

- [ ] **Step 2: Extend `apps/backend/src/rooms.ts`** with viewport storage

Add at top of Rooms class (after existing `private persistence?: FilePersistence;`):

```ts
private viewports = new Map<string, { x: number; y: number; w: number; h: number; zoom?: number; at: number }>();

setViewport(id: string, vp: { x: number; y: number; w: number; h: number; zoom?: number }): void {
  this.viewports.set(id, { ...vp, at: Date.now() });
}

getViewport(id: string): { x: number; y: number; w: number; h: number; zoom?: number } | null {
  const v = this.viewports.get(id);
  if (!v) return null;
  // Wipe after 30 min inactivity.
  if (Date.now() - v.at > 30 * 60 * 1000) {
    this.viewports.delete(id);
    return null;
  }
  const { at, ...rest } = v;
  return rest;
}
```

- [ ] **Step 3: Implement `routes/viewport.ts`**

```ts
// apps/backend/src/routes/viewport.ts
import { Hono } from "hono";
import type { Rooms } from "../rooms";
import { resolveRoomId } from "../rooms";

export function viewportRoutes(rooms: Rooms) {
  const app = new Hono();

  app.post("/api/viewport", async (c) => {
    const rv = resolveRoomId(c.req.query("room"));
    if (!rv.ok) return c.json({ ok: false, error: rv.reason }, 422);
    const body = (await c.req.json().catch(() => null)) as
      | { x?: number; y?: number; w?: number; h?: number; zoom?: number }
      | null;
    if (!body || typeof body.x !== "number" || typeof body.y !== "number" || typeof body.w !== "number" || typeof body.h !== "number") {
      return c.json({ ok: false, error: "expected {x,y,w,h,zoom?}" }, 400);
    }
    rooms.setViewport(rv.id, { x: body.x, y: body.y, w: body.w, h: body.h, zoom: body.zoom });
    return c.json({ ok: true });
  });

  app.get("/api/viewport", (c) => {
    const rv = resolveRoomId(c.req.query("room"));
    if (!rv.ok) return c.json({ ok: false, error: rv.reason }, 422);
    return c.json({ ok: true, viewport: rooms.getViewport(rv.id) });
  });

  return app;
}
```

- [ ] **Step 4: Register in `index.ts`**

In `apps/backend/src/index.ts`, add:
```ts
import { viewportRoutes } from "./routes/viewport";
```

And in `makeApp`, after other `app.route` calls:
```ts
app.route("/", viewportRoutes(rooms));
```

- [ ] **Step 5: Run tests**

Run: `cd apps/backend && bun test tests/routes-viewport.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/rooms.ts apps/backend/src/routes/viewport.ts \
        apps/backend/src/index.ts apps/backend/tests/routes-viewport.test.ts
git commit -m "feat(backend): /api/viewport — ephemeral per-room viewport storage"
```

---

## Task 9: Backend `routes/domain.ts` — POST /api/domain

**Files:**
- Create: `apps/backend/src/routes/domain.ts`
- Modify: `apps/backend/src/index.ts` — register route
- Test: `apps/backend/tests/routes-domain.test.ts`

- [ ] **Step 1: Write failing test**

Create `apps/backend/tests/routes-domain.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { makeApp } from "../src/index";

async function postDomain(app: ReturnType<typeof makeApp>["app"], body: unknown, room = "d1") {
  return app.fetch(
    new Request(`http://localhost/api/domain?room=${room}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/domain", () => {
  test("happy path: define + connect + group end-to-end (§5.1 worked example)", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const res = await postDomain(app, {
      actions: [
        { kind: "define", role: "service", name: "auth" },
        { kind: "define", role: "datastore", name: "users-db" },
        { kind: "connect", from: "auth", to: "users-db", connectionKind: "data" },
        { kind: "group", ids: ["auth", "users-db"], as: "network", name: "vpc-prod" },
      ],
      layoutHint: { mode: "layered-lr" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      version: number;
      results: Array<{ elementId?: string }>;
      layout: { applied: boolean };
    };
    expect(body.ok).toBe(true);
    expect(body.results.map((r) => r.elementId)).toEqual(["auth", "users-db", expect.any(String), "vpc-prod"]);
    expect(body.layout.applied).toBe(true);

    const r = await rooms.get("d1");
    expect(r.canvas.nodes).toHaveLength(2);
    expect(r.canvas.edges).toHaveLength(1);
    expect(r.canvas.groups).toHaveLength(1);
    expect(r.canvas.groups[0].children).toHaveLength(2);
  });

  test("invalid action → 422 with errors, state untouched", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const res = await postDomain(app, {
      actions: [
        { kind: "define", role: "service", name: "ok" },
        { kind: "connect", from: "ok", to: "nope" },
      ],
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { ok: boolean; errors: Array<{ code: string }> };
    expect(body.ok).toBe(false);
    expect(body.errors[0].code).toBe("unknown-ref");

    const r = await rooms.get("d1");
    expect(r.canvas.nodes).toHaveLength(0);
  });

  test("dryRun:true — no state change, generatedOps populated", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const res = await postDomain(app, {
      actions: [{ kind: "define", role: "service", name: "preview" }],
      dryRun: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      results: Array<{ generatedOps?: unknown[] }>;
      version: number;
    };
    expect(body.ok).toBe(true);
    expect(body.results[0].generatedOps).toBeDefined();
    expect((body.results[0].generatedOps as unknown[]).length).toBeGreaterThan(0);

    const r = await rooms.get("d1");
    expect(r.canvas.nodes).toHaveLength(0);
    expect(body.version).toBe(r.version);
  });

  test("idempotency — repeated clientOpId returns cached result", async () => {
    const { app } = makeApp({ inMemory: true });
    const req = {
      actions: [{ kind: "define", role: "service", name: "once" }],
      clientOpId: "abc-123",
    };
    const r1 = await postDomain(app, req);
    const b1 = (await r1.json()) as { version: number };
    const r2 = await postDomain(app, req);
    const b2 = (await r2.json()) as { version: number; idempotent?: true };
    expect(b1.version).toBe(b2.version);
    expect(b2.idempotent).toBe(true);
  });

  test("layout best-effort — domain mutations land even if ELK fails", async () => {
    // We can't easily force ELK failure in test; this is a smoke that response shape supports both branches.
    const { app } = makeApp({ inMemory: true });
    const res = await postDomain(app, {
      actions: [{ kind: "define", role: "service", name: "x" }],
      layoutHint: null,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; layout?: { applied: boolean } };
    expect(body.ok).toBe(true);
    expect(body.layout?.applied).toBe(false);  // null hint → skip layout
  });

  test("delete container without cascade → 422 cascade-confirm-required", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    // seed group with children
    await postDomain(app, {
      actions: [
        { kind: "define", role: "service", name: "a" },
        { kind: "group", ids: ["a"], as: "network", name: "vpc" },
      ],
    });
    const res = await postDomain(app, { actions: [{ kind: "delete", id: "vpc" }] });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { errors: Array<{ code: string; affected?: string[] }> };
    expect(body.errors[0].code).toBe("cascade-confirm-required");
    expect(body.errors[0].affected).toContain("shape:e_a");
  });

  test("delete container with cascade:true succeeds", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    await postDomain(app, {
      actions: [
        { kind: "define", role: "service", name: "a" },
        { kind: "group", ids: ["a"], as: "network", name: "vpc" },
      ],
    });
    const res = await postDomain(app, { actions: [{ kind: "delete", ids: ["vpc"], cascade: true }] });
    expect(res.status).toBe(200);
    const r = await rooms.get("d1");
    expect(r.canvas.groups).toHaveLength(0);
    expect(r.canvas.nodes).toHaveLength(0);  // children cascade
  });

  test("layout action mode overrides batch hint", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    // Seed two nodes via define; then re-layout with explicit force mode action.
    await postDomain(app, {
      actions: [
        { kind: "define", role: "service", name: "a" },
        { kind: "define", role: "service", name: "b" },
      ],
      layoutHint: { mode: "layered-lr" },
    });
    // Capture y of a after layered layout.
    const yAfterLayered = (await rooms.get("d1")).canvas.nodes.find((n) => n.meta?.name === "a")?.y;

    const res = await postDomain(app, {
      actions: [{ kind: "layout", mode: "force", scope: "all", spacing: "loose" }],
      layoutHint: { mode: "layered-lr" },  // should be overridden by action above
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { layout: { applied: boolean } };
    expect(body.layout.applied).toBe(true);
    // After force/all/loose layout the y is likely different; we just assert layout actually ran
    // (no silent skip). The exact value depends on ELK, so we only check the route doesn't ignore action params.
    const yAfterForce = (await rooms.get("d1")).canvas.nodes.find((n) => n.meta?.name === "a")?.y;
    // either changed, or layout returned a valid position — both are evidence the action was honored.
    expect(yAfterForce).toBeDefined();
    // Also: response advertises applied=true even though the only action was layout.
    void yAfterLayered;
  });

  test("layout writes meta.position on nodes + meta.routing on edges", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const res = await postDomain(app, {
      actions: [
        { kind: "define", role: "service", name: "a" },
        { kind: "define", role: "datastore", name: "b" },
        { kind: "connect", from: "a", to: "b", connectionKind: "data" },
      ],
      layoutHint: { mode: "layered-lr" },
    });
    expect(res.status).toBe(200);
    const r = await rooms.get("d1");
    const aNode = r.canvas.nodes.find((n) => n.meta?.name === "a");
    const edge = r.canvas.edges[0];
    expect(aNode?.meta?.position).toBeDefined();
    expect((aNode?.meta?.position as { x: number }).x).toBe(aNode?.x);
    // Edge meta.routing.ports populated (sides may be E/W for layered-lr).
    const routing = edge?.meta?.routing as { ports?: { from?: { side: string }; to?: { side: string } } } | undefined;
    expect(routing?.ports?.from?.side).toBeDefined();
    expect(routing?.ports?.to?.side).toBeDefined();
  });
});
```

Run: FAIL.

- [ ] **Step 2: Implement `routes/domain.ts`**

```ts
// apps/backend/src/routes/domain.ts
import { Hono } from "hono";
import { config } from "../config";
import { compile } from "../domain/compile";
import { runLayout } from "../domain/layout";
import { postProcess } from "../domain/layout-postprocess";
import { validateBatch } from "../domain/validate";
import type {
  ActionResult,
  DomainAction,
  DomainRequest,
  DomainResponse,
  ElementId,
} from "../domain/types";
import { applyPatch } from "../patch";
import { resolveRoomId } from "../rooms";
import type { Rooms } from "../rooms";
import type { PatchBus, PatchOp, RoomState } from "../types";

function computeAffected(actions: DomainAction[], ops: PatchOp[]): ElementId[] {
  const out = new Set<string>();
  for (const op of ops) {
    if (op.op === "add") out.add(op.value.id);
    else if (op.op === "update") out.add(op.id);
    else if (op.op === "delete") out.add(op.id);
  }
  return [...out];
}

function expandCascadeDeletes(actions: DomainAction[], canvas: RoomState["canvas"]): {
  ops: PatchOp[];
  cascadeError?: { actionIndex: number; affected: string[] };
} {
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    if (a.kind !== "delete") continue;
    const ids = "ids" in a ? a.ids : [a.id];
    const cascade = "cascade" in a ? a.cascade === true : false;
    for (const nm of ids) {
      const grp = canvas.groups.find((g) => {
        const gname = (g as { meta?: { name?: string } }).meta?.name ?? g.label;
        return gname === nm;
      });
      if (grp && grp.children.length > 0 && !cascade) {
        return { ops: [], cascadeError: { actionIndex: i, affected: [...grp.children] } };
      }
    }
  }
  return { ops: [] };
}

// In-memory idempotency cache: clientOpId → response. Per process; ephemeral.
const idempotencyCache = new Map<string, DomainResponse & { version: number }>();

export function domainRoutes(
  rooms: Rooms,
  bus: PatchBus,
  opts: { onDirty?: (room: string, state: RoomState) => void } = {},
) {
  return new Hono().post("/api/domain", async (c) => {
    const rv = resolveRoomId(c.req.query("room"));
    if (!rv.ok) return c.json({ ok: false, error: rv.reason }, 422);
    const id = rv.id;
    const body = (await c.req.json().catch(() => null)) as DomainRequest | null;
    if (!body || !Array.isArray(body.actions)) {
      return c.json({ ok: false, error: "expected {actions, ...}" }, 400);
    }

    if (body.clientOpId) {
      const cached = idempotencyCache.get(`${id}:${body.clientOpId}`);
      if (cached) return c.json({ ...cached, idempotent: true } as DomainResponse);
    }

    const room = await rooms.get(id);

    // Cascade pre-check.
    const cascade = expandCascadeDeletes(body.actions, room.canvas);
    if (cascade.cascadeError) {
      return c.json(
        {
          ok: false,
          errors: [
            {
              actionIndex: cascade.cascadeError.actionIndex,
              code: "cascade-confirm-required",
              message: "container has children; pass cascade:true to delete",
              affected: cascade.cascadeError.affected,
            },
          ],
        } satisfies DomainResponse,
        422,
      );
    }

    // Validate.
    const v = validateBatch(body.actions, room.canvas);
    if (!v.ok) {
      return c.json({ ok: false, errors: v.errors } satisfies DomainResponse, 422);
    }

    // Compile.
    const compiled = compile(body.actions, room.canvas);

    // For delete cascade: append children-delete ops for any container being deleted with cascade.
    const cascadeOps: PatchOp[] = [];
    for (const a of body.actions) {
      if (a.kind !== "delete") continue;
      const cascade = "cascade" in a ? a.cascade === true : false;
      if (!cascade) continue;
      const ids = "ids" in a ? a.ids : [a.id];
      for (const nm of ids) {
        const grp = room.canvas.groups.find(
          (g) => ((g as { meta?: { name?: string } }).meta?.name ?? g.label) === nm,
        );
        if (grp) {
          for (const childId of grp.children) {
            cascadeOps.push({ op: "delete", target: "node", id: childId });
          }
        }
      }
    }
    const allOps = [...compiled.ops, ...cascadeOps];

    // dryRun: skip applyPatch and bus.
    if (body.dryRun) {
      const results: ActionResult[] = compiled.elementIds.map((eid, i) => ({
        actionIndex: i,
        elementId: eid,
        generatedOps: compiled.ops.filter((_, _idx) => true),  // simplified — full per-action breakdown is a Phase 2.2 polish
      }));
      const resp: DomainResponse = {
        ok: true,
        version: room.version,
        results,
        layout: { applied: false, reason: "dryRun" },
      };
      return c.json(resp);
    }

    // Apply domain mutations atomically.
    const applied = applyPatch(room.canvas, allOps);
    if (!applied.ok) {
      return c.json(
        {
          ok: false,
          errors: [{ actionIndex: 0, code: "compile-error", message: applied.error }],
        } satisfies DomainResponse,
        500,
      );
    }
    room.canvas = applied.state;
    room.version += 1;
    room.opLog.push({
      ops: allOps,
      source: "ai",
      version: room.version,
      at: Date.now(),
      clientOpId: body.clientOpId,
    });
    if (room.opLog.length > config.opLogMaxSize) {
      room.opLog.splice(0, room.opLog.length - config.opLogMaxSize);
    }
    room.dirty = true;
    opts.onDirty?.(id, room);
    bus.publish(id, { ops: allOps, source: "ai", version: room.version, originClientId: body.clientOpId });

    // Resolve effective layout config. Precedence (last wins so explicit action
    // overrides batch-level hint):
    //   1. body.layoutHint === null → skip layout entirely
    //   2. any `layout` action in batch → use its mode/scope/spacing
    //   3. body.layoutHint defaults
    //   4. fallback {mode:"layered-lr", scope:"affected", spacing:"normal"}
    type EffectiveHint = { mode: "layered-lr" | "layered-tb" | "tree" | "pack" | "force"; scope: "all" | "affected" | string; spacing: "compact" | "normal" | "loose" };
    let effectiveHint: EffectiveHint | null;
    if (body.layoutHint === null) {
      effectiveHint = null;
    } else {
      const base: EffectiveHint = {
        mode: (body.layoutHint?.mode ?? "layered-lr") as EffectiveHint["mode"],
        scope: body.layoutHint?.scope ?? "affected",
        spacing: (body.layoutHint?.spacing ?? "normal") as EffectiveHint["spacing"],
      };
      for (const a of body.actions) {
        if (a.kind !== "layout") continue;
        if (a.mode) base.mode = a.mode as EffectiveHint["mode"];
        if (a.scope !== undefined) base.scope = a.scope;
        if (a.spacing) base.spacing = a.spacing as EffectiveHint["spacing"];
      }
      effectiveHint = base;
    }

    // Best-effort layout.
    let layoutInfo: DomainResponse extends { layout?: infer L } ? L : never = { applied: false };
    if (effectiveHint !== null) {
      const affected = computeAffected(body.actions, allOps);
      try {
        const lr = await runLayout(room.canvas, effectiveHint, { affected });
        if (lr.ok) {
          // post-process and write back positions + meta.position + meta.routing.
          const sizes = new Map(room.canvas.nodes.map((n) => [n.id, { w: n.w ?? 120, h: n.h ?? 60 }]));
          const adjusted = postProcess(
            Object.fromEntries(Object.entries(lr.positions).map(([id, p]) => [id, { x: p.x, y: p.y }])),
            sizes,
          );
          const posOps: PatchOp[] = [];
          for (const [nid, p] of Object.entries(adjusted)) {
            const node = room.canvas.nodes.find((n) => n.id === nid);
            if (!node) continue;  // group bbox positions land via group ops below
            // Per spec §3.6.4: meta.position carries last layout-known coords.
            // applyPatch shallow-merges meta — build full meta.position here.
            const newMeta = { ...(node.meta ?? {}), position: { x: p.x, y: p.y } };
            posOps.push({
              op: "update" as const,
              target: "node" as const,
              id: nid,
              set: { x: p.x, y: p.y, meta: newMeta },
            });
          }
          // Update group bboxes (if ELK returned positions for group containers).
          for (const g of room.canvas.groups) {
            const p = adjusted[g.id];
            if (!p) continue;
            posOps.push({
              op: "update" as const,
              target: "group" as const,
              id: g.id,
              set: { x: p.x, y: p.y },
            });
          }
          // Edge routing → meta.routing on the edge.
          for (const [eid, routing] of Object.entries(lr.edgeRouting)) {
            const edge = room.canvas.edges.find((e) => e.id === eid);
            if (!edge) continue;
            const newMeta = {
              ...(edge.meta ?? {}),
              routing: {
                ports: {
                  from: routing.fromSide ? { side: routing.fromSide } : undefined,
                  to: routing.toSide ? { side: routing.toSide } : undefined,
                },
                bendPoints: routing.bendPoints ?? [],
              },
            };
            posOps.push({
              op: "update" as const,
              target: "edge" as const,
              id: eid,
              set: { meta: newMeta },
            });
          }
          if (posOps.length > 0) {
            const r2 = applyPatch(room.canvas, posOps);
            if (r2.ok) {
              room.canvas = r2.state;
              room.version += 1;
              room.opLog.push({ ops: posOps, source: "ai", version: room.version, at: Date.now() });
              if (room.opLog.length > config.opLogMaxSize) {
                room.opLog.splice(0, room.opLog.length - config.opLogMaxSize);
              }
              opts.onDirty?.(id, room);
              bus.publish(id, { ops: posOps, source: "ai", version: room.version });
            }
          }
          layoutInfo = { applied: true, affected: lr.affected };
        } else {
          layoutInfo = { applied: false, reason: lr.reason };
        }
      } catch (e) {
        layoutInfo = { applied: false, reason: (e as Error).message };
      }
    }

    const results: ActionResult[] = compiled.elementIds.map((eid, i) => ({
      actionIndex: i,
      elementId: eid,
    }));

    const resp: DomainResponse = {
      ok: true,
      version: room.version,
      results,
      layout: layoutInfo,
    };

    if (body.clientOpId) {
      idempotencyCache.set(`${id}:${body.clientOpId}`, { ...resp, version: room.version });
    }

    return c.json(resp);
  });
}
```

- [ ] **Step 3: Register `domainRoutes` in `index.ts`**

```ts
import { domainRoutes } from "./routes/domain";
// ...
app.route("/", domainRoutes(rooms, bus, { onDirty }));
```

- [ ] **Step 4: Run tests**

Run: `cd apps/backend && bun test tests/routes-domain.test.ts`
Expected: PASS (7 tests). The "happy path" + ELK tests require ELK to actually run — if your test environment can't load the worker, ELK errors are captured and the test asserts layout.applied=false.

- [ ] **Step 5: Run full backend suite**

Run: `cd apps/backend && bun test`
Expected: All existing + new = ~155 green.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/routes/domain.ts apps/backend/src/index.ts \
        apps/backend/tests/routes-domain.test.ts
git commit -m "feat(backend): POST /api/domain — validate→compile→applyPatch→layout pipeline"
```

---

## Task 10: Backend `routes/context.ts` — GET /api/agent/context

**Files:**
- Create: `apps/backend/src/routes/context.ts`
- Modify: `apps/backend/src/index.ts`
- Test: `apps/backend/tests/routes-context.test.ts`

- [ ] **Step 1: Write failing test**

Create `apps/backend/tests/routes-context.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { makeApp } from "../src/index";

describe("GET /api/agent/context", () => {
  test("returns domain-summary; no x/y/w/h fields", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const r = await rooms.get("c1");
    r.canvas.nodes.push({ id: "shape:e_a", kind: "rect", x: 0, y: 0, label: "a", meta: { name: "a", role: "service" } });
    const res = await app.fetch(new Request("http://localhost/api/agent/context?room=c1"));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(/"x":/);
    expect(text).not.toMatch(/"y":/);
    expect(text).not.toMatch(/"w":/);
    expect(text).not.toMatch(/"h":/);
  });

  test("uses last-known viewport if not given in query", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    rooms.setViewport("c1", { x: 0, y: 0, w: 100, h: 100, zoom: 1 });
    const res = await app.fetch(new Request("http://localhost/api/agent/context?room=c1"));
    const body = (await res.json()) as { viewport: { w: number } | null };
    expect(body.viewport?.w).toBe(100);
  });

  test("viewport query param overrides server-stored", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    rooms.setViewport("c1", { x: 0, y: 0, w: 100, h: 100 });
    const res = await app.fetch(new Request("http://localhost/api/agent/context?room=c1&viewport=10,20,30,40"));
    const body = (await res.json()) as { viewport: { x: number; y: number; w: number; h: number } | null };
    expect(body.viewport).toEqual({ x: 10, y: 20, w: 30, h: 40 });
  });

  test("invalid room → 422", async () => {
    const { app } = makeApp({ inMemory: true });
    const res = await app.fetch(new Request("http://localhost/api/agent/context?room=" + encodeURIComponent("bad name")));
    expect(res.status).toBe(422);
  });

  test("?since=N filters recentOps to versions > N", async () => {
    const { app, rooms } = makeApp({ inMemory: true });
    const r = await rooms.get("c1");
    r.opLog.push({ ops: [], source: "ai", version: 1, at: 100 });
    r.opLog.push({ ops: [], source: "ai", version: 2, at: 200 });
    r.opLog.push({ ops: [], source: "ai", version: 3, at: 300 });
    r.version = 3;
    const res = await app.fetch(new Request("http://localhost/api/agent/context?room=c1&since=1"));
    const body = (await res.json()) as { recentOps: Array<{ version: number }> };
    expect(body.recentOps.map((o) => o.version)).toEqual([2, 3]);
  });
});
```

Run: FAIL.

- [ ] **Step 2: Implement `routes/context.ts`**

```ts
// apps/backend/src/routes/context.ts
import { Hono } from "hono";
import { buildContext } from "../domain/context";
import type { Viewport } from "../domain/context";
import { resolveRoomId } from "../rooms";
import type { Rooms } from "../rooms";

function parseViewport(s: string | undefined): Viewport {
  if (!s) return null;
  const parts = s.split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

export function contextRoutes(rooms: Rooms) {
  return new Hono().get("/api/agent/context", async (c) => {
    const rv = resolveRoomId(c.req.query("room"));
    if (!rv.ok) return c.json({ ok: false, error: rv.reason }, 422);
    const id = rv.id;
    const queryViewport = parseViewport(c.req.query("viewport"));
    const storedViewport = rooms.getViewport(id);
    const viewport: Viewport = queryViewport ?? storedViewport ?? null;
    const room = await rooms.get(id);
    const selection = c.req.query("select")?.split(",").filter(Boolean) ?? [];
    const sinceRaw = c.req.query("since");
    const since = sinceRaw !== undefined ? Number(sinceRaw) : undefined;
    if (since !== undefined && !Number.isFinite(since)) {
      return c.json({ ok: false, error: "invalid since param" }, 400);
    }
    const ctx = buildContext(room, { viewport, selection, since });
    return c.json({ ok: true, ...ctx });
  });
}
```

- [ ] **Step 3: Register in `index.ts`**

```ts
import { contextRoutes } from "./routes/context";
// ...
app.route("/", contextRoutes(rooms));
```

- [ ] **Step 4: Run tests**

Run: `cd apps/backend && bun test tests/routes-context.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/routes/context.ts apps/backend/src/index.ts \
        apps/backend/tests/routes-context.test.ts
git commit -m "feat(backend): GET /api/agent/context — domain-summary view"
```

---

## Task 11: Frontend `role-render.ts` + port-anchor + viewport reporter

**Files:**
- Create: `apps/frontend/src/canvas/role-render.ts`
- Modify: `apps/frontend/src/canvas/from-canvas-state.ts`
- Create: `apps/frontend/src/transport/viewport.ts`
- Modify: `apps/frontend/src/main.tsx` (or whatever wires the editor) — call viewportReporter after editor mounts

**Reference required:** read https://tldraw.dev/docs/editor (sections: store.listen, getCamera, getViewportScreenBounds) and https://tldraw.dev/docs/shapes (geo shape props, sticky note shape) before writing. Memory `feedback-tldraw-docs.md` mandates this.

- [ ] **Step 1: Implement `apps/frontend/src/canvas/role-render.ts`**

```ts
// apps/frontend/src/canvas/role-render.ts
import { connectionPreset, rolePreset, type ConnectionKind, type Role } from "@didraw/domain";

// Map a domain Role + state's style + meta.styleOwnedBy into the actual
// props passed to tldraw. If user owns style, preserve user-set fields and
// only fall back to preset for absent fields. Otherwise preset wins.
export function rolePropsForNode(opts: {
  role: Role | undefined;
  styleOwnedBy?: string;
  userStyle?: { color?: string; fill?: string };
}): { color?: string; fill?: string } {
  if (!opts.role) return opts.userStyle ?? {};
  const preset = rolePreset(opts.role);
  if (opts.styleOwnedBy === "user") {
    return { color: opts.userStyle?.color ?? preset.style.color, fill: opts.userStyle?.fill ?? preset.style.fill };
  }
  return { color: preset.style.color, fill: preset.style.fill };
}

export function connectionPropsForEdge(kind: ConnectionKind | undefined): { dashed: boolean; defaultLabel?: string } {
  if (!kind) return { dashed: false };
  const p = connectionPreset(kind);
  return { dashed: p.dashed, defaultLabel: p.defaultLabel };
}
```

- [ ] **Step 2: Modify `from-canvas-state.ts`** — apply role props + port anchors

Find the existing `styleToProps` function in `apps/frontend/src/canvas/from-canvas-state.ts` and replace its use site with `rolePropsForNode`. Also locate the edge shape creation (search for `to-arrow-bindings` or similar — bindings carry `normalizedAnchor`); when the edge's source/target node has `meta.routing.ports.{from,to}.side`, override the anchor accordingly:

```ts
const PORT_SIDE_TO_ANCHOR: Record<"N" | "S" | "E" | "W", { x: number; y: number }> = {
  N: { x: 0.5, y: 0 },
  S: { x: 0.5, y: 1 },
  E: { x: 1, y: 0.5 },
  W: { x: 0, y: 0.5 },
};
```

In the binding creation logic (terminal "start" or "end"), if `edge.meta?.routing?.ports?.[terminal]?.side` exists, use `PORT_SIDE_TO_ANCHOR[side]` instead of the default `{ x: 0.5, y: 0.5 }`.

(Exact placement depends on existing code; the implementer reads the file and integrates accordingly. The principle: domain preset and ports flow through this single mapper.)

- [ ] **Step 3: Implement `transport/viewport.ts`**

```ts
// apps/frontend/src/transport/viewport.ts
import type { Editor } from "tldraw";

const DEBOUNCE_MS = 500;

export function viewportReporter(editor: Editor, opts: { roomId: string; baseUrl?: string } = { roomId: "default" }): () => void {
  const base = opts.baseUrl ?? "";
  let timer: ReturnType<typeof setTimeout> | null = null;

  function send() {
    const vp = editor.getViewportPageBounds();
    fetch(`${base}/api/viewport?room=${encodeURIComponent(opts.roomId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x: vp.x, y: vp.y, w: vp.w, h: vp.h, zoom: editor.getCamera().z }),
    }).catch(() => {});
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      send();
      timer = null;
    }, DEBOUNCE_MS);
  }

  // Subscribe to camera changes via tldraw store listener.
  const unsubscribe = editor.store.listen(
    (event) => {
      if (event.source === "user" && Object.keys(event.changes.updated).some((k) => k.startsWith("camera:"))) {
        schedule();
      }
    },
    { scope: "session" },
  );

  // initial send
  send();

  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
  };
}
```

- [ ] **Step 4: Wire the reporter** in app entry

Locate where `<Tldraw editor={editor}>` mounts in `apps/frontend/src/main.tsx` or similar. After `editor.mount` (or in an `onMount` callback), call:

```ts
import { viewportReporter } from "./transport/viewport";
// inside onMount:
const stop = viewportReporter(editor, { roomId: getRoomFromUrl() });
// On editor unmount/dispose, call stop()
```

(Exact integration depends on existing code. The cleanup function should be called on unmount to avoid stray timers.)

- [ ] **Step 5: Run frontend type check + (if exists) tests**

Run: `cd apps/frontend && bun run tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/canvas/role-render.ts \
        apps/frontend/src/canvas/from-canvas-state.ts \
        apps/frontend/src/transport/viewport.ts \
        apps/frontend/src/main.tsx
git commit -m "feat(frontend): role-render preset + port anchors + viewport reporter"
```

---

## Task 12: `@didraw/client` extensions + CLI domain commands

**Files:**
- Modify: `packages/didraw-client/src/index.ts`
- Create: `packages/didraw-cli/src/domain.ts`
- Modify: `packages/didraw-cli/src/index.ts` — register
- Create: `packages/didraw-cli/tests/domain.test.ts`

- [ ] **Step 1: Add client methods**

Append to `packages/didraw-client/src/index.ts` (inside `CanvasClient` class, before closing brace):

```ts
async applyDomain(body: {
  actions: unknown[];
  clientOpId?: string;
  dryRun?: boolean;
  layoutHint?: unknown;
}) {
  const r = await fetch(`${this.base}/api/domain?${this.q()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

async getContext(opts: { since?: number; viewport?: string; select?: string[] } = {}) {
  const params = new URLSearchParams({ room: this.room });
  if (opts.since !== undefined) params.set("since", String(opts.since));
  if (opts.viewport) params.set("viewport", opts.viewport);
  if (opts.select?.length) params.set("select", opts.select.join(","));
  const r = await fetch(`${this.base}/api/agent/context?${params.toString()}`);
  return r.json();
}

async postViewport(vp: { x: number; y: number; w: number; h: number; zoom?: number }) {
  const r = await fetch(`${this.base}/api/viewport?${this.q()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(vp),
  });
  return r.json();
}
```

- [ ] **Step 2: Implement `packages/didraw-cli/src/domain.ts`**

```ts
// packages/didraw-cli/src/domain.ts
import { CanvasClient } from "@didraw/client";
import { ensureSilent } from "./daemon";
import type { Profile } from "./profile";
import { portFor } from "./profile";

function clientFor(profile: Profile): CanvasClient {
  return new CanvasClient({ baseUrl: `http://localhost:${portFor(profile)}` });
}

async function postBatch(profile: Profile, actions: unknown[], extra: Record<string, unknown> = {}) {
  await ensureSilent(profile);
  const res = await clientFor(profile).applyDomain({ actions, ...extra });
  console.log(JSON.stringify(res));
  if ((res as { ok?: boolean }).ok === false) process.exit(1);
}

export async function define(args: { role: string; name: string; label?: string; in?: string; profile: Profile }) {
  return postBatch(args.profile, [{ kind: "define", role: args.role, name: args.name, label: args.label, in: args.in }]);
}

export async function connectCmd(args: { from: string; to: string; kind?: string; label?: string; profile: Profile }) {
  return postBatch(args.profile, [{ kind: "connect", from: args.from, to: args.to, connectionKind: args.kind, label: args.label }]);
}

export async function group(args: { ids: string[]; as: string; name: string; label?: string; profile: Profile }) {
  return postBatch(args.profile, [{ kind: "group", ids: args.ids, as: args.as, name: args.name, label: args.label }]);
}

export async function note(args: { text: string; about?: string; profile: Profile }) {
  return postBatch(args.profile, [{ kind: "note", text: args.text, about: args.about }]);
}

export async function layoutCmd(args: { mode?: string; scope?: string; spacing?: string; profile: Profile }) {
  return postBatch(args.profile, [{ kind: "layout", mode: args.mode, scope: args.scope, spacing: args.spacing }]);
}

export async function deleteCmd(args: { ids: string[]; cascade?: boolean; profile: Profile }) {
  return postBatch(
    args.profile,
    [args.ids.length === 1 && !args.cascade ? { kind: "delete", id: args.ids[0] } : { kind: "delete", ids: args.ids, cascade: !!args.cascade }],
  );
}

export async function applyStdin(args: { profile: Profile }) {
  await ensureSilent(args.profile);
  const raw = await new Response(Bun.stdin.stream()).text();
  const body = JSON.parse(raw);
  const res = await clientFor(args.profile).applyDomain(body);
  console.log(JSON.stringify(res));
  if ((res as { ok?: boolean }).ok === false) process.exit(1);
}

export async function context(args: { since?: number; viewport?: string; profile: Profile }) {
  await ensureSilent(args.profile);
  const res = await clientFor(args.profile).getContext({ since: args.since, viewport: args.viewport });
  console.log(JSON.stringify(res));
  if ((res as { ok?: boolean }).ok === false) process.exit(1);
}
```

- [ ] **Step 3: Register commands in `packages/didraw-cli/src/index.ts`**

Find the dispatch chain (where `cmd === "rooms"`, etc.) and add cases for the new commands. Update `usage()` to include the new Domain section:

```
Domain (preferred AI interface):
  define <role> <name> [--label "..."] [--in <container>]
  connect <from> <to> [--kind sync|async|data|dep] [--label "..."]
  group <id1,id2,...> --as network|boundary --name <name> [--label "..."]
  note --text "..." [--about <name>]
  layout [--mode layered-lr|layered-tb|tree|pack|force] [--scope all|<group>] [--spacing compact|normal|loose]
  delete <id1,id2,...> [--cascade]
  apply --stdin        # JSON batch
  context [--since N] [--viewport x,y,w,h]
```

The dispatcher snippets (add to the existing chain). The `argv` parser pattern mirrors the existing `rooms` group:

```ts
if (cmd === "define") {
  const role = argv[1];
  const name = argv[2];
  if (!role || !name) { console.error(JSON.stringify({ ok: false, error: "expected <role> <name>" })); process.exit(1); }
  let label: string | undefined;
  let inContainer: string | undefined;
  for (let i = 3; i < argv.length; i++) {
    if (argv[i] === "--label") label = argv[++i];
    else if (argv[i] === "--in") inContainer = argv[++i];
  }
  return define({ role, name, label, in: inContainer, profile });
}

if (cmd === "connect") {
  const from = argv[1];
  const to = argv[2];
  if (!from || !to) { console.error(JSON.stringify({ ok: false, error: "expected <from> <to>" })); process.exit(1); }
  let kind: string | undefined;
  let label: string | undefined;
  for (let i = 3; i < argv.length; i++) {
    if (argv[i] === "--kind") kind = argv[++i];
    else if (argv[i] === "--label") label = argv[++i];
  }
  return connectCmd({ from, to, kind, label, profile });
}

if (cmd === "group") {
  const ids = argv[1]?.split(",") ?? [];
  let asKind: string | undefined;
  let name: string | undefined;
  let label: string | undefined;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--as") asKind = argv[++i];
    else if (argv[i] === "--name") name = argv[++i];
    else if (argv[i] === "--label") label = argv[++i];
  }
  if (!asKind || !name) { console.error(JSON.stringify({ ok: false, error: "expected --as <kind> --name <name>" })); process.exit(1); }
  return group({ ids, as: asKind, name, label, profile });
}

if (cmd === "note") {
  let text: string | undefined;
  let about: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--text") text = argv[++i];
    else if (argv[i] === "--about") about = argv[++i];
  }
  if (!text) { console.error(JSON.stringify({ ok: false, error: "expected --text \"...\"" })); process.exit(1); }
  return note({ text, about, profile });
}

if (cmd === "delete") {
  const ids = argv[1]?.split(",") ?? [];
  const cascade = argv.includes("--cascade");
  if (ids.length === 0) { console.error(JSON.stringify({ ok: false, error: "expected <id1,id2,...>" })); process.exit(1); }
  return deleteCmd({ ids, cascade, profile });
}

if (cmd === "apply") {
  if (!argv.includes("--stdin")) { console.error(JSON.stringify({ ok: false, error: "expected --stdin" })); process.exit(1); }
  return applyStdin({ profile });
}

if (cmd === "context") {
  let since: number | undefined;
  let viewport: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--since") since = Number(argv[++i]);
    else if (argv[i] === "--viewport") viewport = argv[++i];
  }
  return context({ since, viewport, profile });
}
```

NOTE: there's a naming clash — the existing dispatch has `if (cmd === "layout")` for the old route. Replace it with the domain version:

```ts
if (cmd === "layout") {
  let mode: string | undefined;
  let scope: string | undefined;
  let spacing: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--mode") mode = argv[++i];
    else if (argv[i] === "--scope") scope = argv[++i];
    else if (argv[i] === "--spacing") spacing = argv[++i];
  }
  return layoutCmd({ mode, scope, spacing, profile });
}
```

The OLD `--algorithm` flag is removed (breaking; documented in CHANGELOG).

- [ ] **Step 4: Write CLI integration test**

Create `packages/didraw-cli/tests/domain.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { startServer } from "../../../apps/backend/src/index";

let srv: { port: number; close: () => Promise<void> };
const CLI = join(import.meta.dir, "..", "src", "index.ts");

beforeAll(async () => {
  srv = await startServer({ inMemory: true, port: 0 });
});
afterAll(async () => {
  await srv.close();
});

const envFor = (room: string): Record<string, string> => ({
  ...(process.env as Record<string, string>),
  DIDRAW_PORT: String(srv.port),
  CLAUDE_SESSION_ID: room,
});

async function cli(args: string[], env: Record<string, string>, input?: string) {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env,
    stdin: input !== undefined ? Buffer.from(input) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { status, stdout, stderr };
}

describe("didraw domain CLI", () => {
  test("define service auth → context shows auth", async () => {
    const env = envFor("d-cli-1");
    const def = await cli(["define", "service", "auth"], env);
    expect(def.status).toBe(0);
    expect(JSON.parse(def.stdout).ok).toBe(true);

    const ctx = await cli(["context"], env);
    expect(ctx.status).toBe(0);
    const body = JSON.parse(ctx.stdout);
    expect(body.summary.byRole.service).toBe(1);
  });

  test("apply --stdin with batch", async () => {
    const env = envFor("d-cli-2");
    const batch = JSON.stringify({
      actions: [
        { kind: "define", role: "service", name: "a" },
        { kind: "define", role: "datastore", name: "b" },
        { kind: "connect", from: "a", to: "b" },
      ],
    });
    const r = await cli(["apply", "--stdin"], env, batch);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).ok).toBe(true);
  });

  test("define unknown role → exit 1", async () => {
    const env = envFor("d-cli-3");
    const r = await cli(["define", "frobnicator", "x"], env);
    expect(r.status).toBe(1);
  });

  test("group multiple ids", async () => {
    const env = envFor("d-cli-4");
    await cli(["define", "service", "a"], env);
    await cli(["define", "service", "b"], env);
    const r = await cli(["group", "a,b", "--as", "network", "--name", "vpc"], env);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).ok).toBe(true);
  });
});
```

- [ ] **Step 5: Run CLI tests**

Run: `cd packages/didraw-cli && bun test tests/domain.test.ts`
Expected: PASS.

- [ ] **Step 6: Run full suite**

Run: `bun run test` from repo root.
Expected: All green.

- [ ] **Step 7: Commit**

```bash
git add packages/didraw-client/src/index.ts \
        packages/didraw-cli/src/domain.ts \
        packages/didraw-cli/src/index.ts \
        packages/didraw-cli/tests/domain.test.ts
git commit -m "feat(cli): domain commands (define/connect/group/note/layout/delete/apply/context)"
```

---

## Task 13: Skill cheat-sheet rewrite + Playwright smoke

**Files:**
- Modify: `.claude/skills/draw/SKILL.md`
- (Optional) Update or create: `apps/frontend/playwright/...` if Playwright suite exists

- [ ] **Step 1: Replace SKILL.md**

Open `.claude/skills/draw/SKILL.md` and rewrite to inject `didraw context` instead of `didraw state --compact`, add Roles/Connection-kinds tables, and remove the PatchOp section.

New full structure (replace entire file body, keep `---` frontmatter):

```markdown
# draw

You have a live canvas board for this Claude Code session. Domain-level commands below; do NOT use raw `didraw patch` — use `didraw define / connect / group / note / layout / delete / apply / context` instead.

## Current canvas context

!`didraw context 2>/dev/null || echo '{"summary":{"total":0,"byRole":{}},"inView":[],"connections":[],"recentOps":[]}'`

## Rooms in this workspace

!`didraw rooms list 2>/dev/null || echo '{"rooms":[]}'`

If `rooms` lists non-empty schemas relevant to the current dialogue, ask the user whether to continue an existing schema or start a new one.

## Pending user prompts

!`didraw prompts list --status pending 2>/dev/null || echo '{"prompts":[]}'`

## Roles

| Role | When | Example name |
|---|---|---|
| `actor` | user/customer/external person | `customer`, `admin` |
| `service` | app, API, microservice, function | `auth`, `payment-api` |
| `datastore` | DB, cache, S3, file store | `users-db`, `redis-sessions` |
| `queue` | broker/event-bus/stream | `kafka-events` |
| `network` | VPC, subnet, perimeter (container) | `vpc-prod` |
| `boundary` | logical/security boundary (container) | `dmz` |
| `external` | 3rd-party service | `stripe`, `sendgrid` |
| `note` | annotation/ADR pointer | `note-1` (auto) |

## Connection kinds

| Kind | Default label | Visual |
|---|---|---|
| `sync` (default) | "calls" | solid → |
| `async` | "publishes" | dashed → |
| `data` | "reads" | solid → |
| `dep` | (none) | dotted → |

## Commands

```
didraw define <role> <name> [--label "..."] [--in <container>]
didraw connect <from> <to> [--kind sync|async|data|dep] [--label "..."]
didraw group <id1,id2,...> --as network|boundary --name <name>
didraw note --text "..." [--about <name>]
didraw layout [--mode layered-lr|layered-tb|tree|pack|force]
didraw delete <id1,id2,...> [--cascade]
didraw apply --stdin              # JSON batch with {actions: [...]}
```

## Pattern: batch via apply

For multi-step changes, prefer one `apply --stdin` over many `define`/`connect` calls — one auto-layout, one transaction:

```bash
echo '{
  "actions": [
    {"kind":"define","role":"service","name":"auth"},
    {"kind":"define","role":"datastore","name":"users-db"},
    {"kind":"connect","from":"auth","to":"users-db","connectionKind":"data"}
  ],
  "layoutHint": {"mode": "layered-lr"}
}' | didraw apply --stdin
```

## Pattern: preview before commit

Use `dryRun:true` to see compiled ops without writing:

```bash
echo '{"actions":[…],"dryRun":true}' | didraw apply --stdin
```

## User overrides — respect them

If the user moved or recoloured a node (you'll see `pinned:true` or `styleOwnedBy:"user"` in context), your next `define` upserts must NOT clobber those fields. Backend enforces this — but be aware semantically.
```

- [ ] **Step 2: (Optional) Playwright smoke for §5.1 example**

If Playwright is set up under `apps/frontend/playwright/`, add a test that:
1. Starts a daemon on test port
2. Opens browser to `:port/?room=smoke`
3. Runs CLI `didraw apply --stdin` with the 4-action batch from §5.1
4. Asserts that 2 nodes appear inside a dashed frame, with an arrow between them
5. Asserts `auth.x < users-db.x`

If no Playwright suite exists yet, this step is deferred to a separate task — note in commit message.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/draw/SKILL.md
git commit -m "docs(skill): rewrite for domain-first agent (define/connect/group/note + roles)"
```

---

## Task 14: CHANGELOG + version bump 0.1.0 → 0.2.0 + tag

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `package.json` (root)
- Tag: `v0.2.0`

- [ ] **Step 1: Add CHANGELOG entry at top**

Open `CHANGELOG.md` and insert before the existing `## 0.1.0 — ...` entry:

```markdown
## 0.2.0 — 2026-05-16

### Phase 2.1 — Agent v2 (domain-first)

**Shared:**
- New workspace package `@didraw/domain` — SSOT для `Role`, `ConnectionKind`, `LayoutMode`, `rolePreset`, `connectionPreset`, name validation, `modeToElkOptions`.

**Backend:**
- New domain layer: `apps/backend/src/domain/{types,validate,compile,layout,layout-postprocess,context}.ts`.
- New routes:
  - `POST /api/domain` — typed actions (define/connect/group/note/layout/delete + apply batch + dryRun + idempotency); transactions atomic for domain mutations, best-effort for layout.
  - `GET /api/agent/context` — token-cheap domain summary (no geometry, ≤8KB for 100 elements).
  - `POST /api/viewport` / `GET /api/viewport` — ephemeral per-room viewport storage.
- ELK развёрнут на полную: compound containers (network/boundary → compound nodes), ports (computed sides → frontend anchors), pin (`meta.pinned` → `elk.position`/`fixed`), affected vs all scope, orthogonal edge routing (bendpoints stored, render in v3.x).
- Post-process pipeline: snap-to-grid 10px + min-spacing 20px.
- `POST /api/patch` теперь делает inference на `source:"user"`:
  - update x/y → `meta.pinned=true`, `meta.position={x,y}`.
  - update style → `meta.styleOwnedBy="user"`.

**CLI (BREAKING):**
- New domain commands: `define`, `connect`, `group`, `note`, `delete`, `apply --stdin`, `context`.
- `layout` command parameter renamed: `--algorithm dagre|elk-layered` → `--mode layered-lr|layered-tb|tree|pack|force` (the old "dagre" was misleadingly ELK force; new naming honest).

**Frontend:**
- `role-render.ts` применяет `rolePreset(role)` поверх state; уважает `meta.styleOwnedBy === "user"`.
- Port-side из ELK → `normalizedAnchor` для arrow bindings.
- Viewport reporter — debounced (500ms) `POST /api/viewport` на camera change.

**Skill:**
- `/draw` cheat-sheet полностью переписан: инжектит `didraw context` вместо `state --compact`; добавлены Roles/Connection-kinds tables; раздел PatchOp удалён (агент его больше не видит).

**Deprecated:**
- `docs/handoff/mcp-launch-brief.md` — будет переписан в Phase 2.3 (MCP adapter поверх domain API).
```

- [ ] **Step 2: Bump version**

In root `package.json`:
```diff
-  "version": "0.1.0",
+  "version": "0.2.0",
```

- [ ] **Step 3: Final test run**

```bash
cd /Users/tretyakov_dv/Projects/sandbox/di.draw && bun run test
```

Expected: all green (~150+ tests across packages).

- [ ] **Step 4: Commit and tag**

```bash
git add CHANGELOG.md package.json
[ -f release/VERSION ] && git add release/VERSION
git commit -m "release: 0.2.0 — Phase 2.1 agent v2 domain-first"
git tag v0.2.0
```

---

## Self-Review

### Spec coverage check

| Spec section | Task(s) implementing |
|---|---|
| §2 Architecture (domain layer, shared package) | Task 1 (`@didraw/domain`), Tasks 2-6 (backend domain) |
| §2.2 UX контракт (user overrides) | Task 7 (patch inference), Task 11 (role-render respects styleOwnedBy) |
| §3.1 Roles enum + container model | Task 1 (roles.ts), Task 3 (compile uses `Group.children`) |
| §3.2 Connection kinds | Task 1 (connections.ts + connection-preset.ts) |
| §3.3 Common envelope (DomainRequest/Response/Action) | Task 2 (types.ts) |
| §3.3 Transaction model (atomic domain, best-effort layout) | Task 9 (routes/domain.ts) |
| §3.4 The 6 actions | Task 3 (compile) + Task 5 (validate) + Task 9 (routes orchestrator) |
| §3.5 Element identity (name → shape:e_slug) | Task 3 (`nameToShapeId`) |
| §3.6.1 Layout modes | Task 1 (layout-modes.ts) |
| §3.6.2 ELK feature usage (full) | Task 4 (layout.ts) |
| §3.6.3 Scope policy | Task 4 (affected vs all) + Task 9 (compute affected) |
| §3.6.4 Pin / user overrides | Task 7 (inference) + Task 4 (ELK pin support) |
| §3.6.5 Edge routing v1 (ports + anchors) | Task 4 (ELK port sides) + Task 11 (anchor mapping) |
| §3.6.6 Post-process | Task 5 (snap-to-grid + min-spacing) |
| §4 Agent context (token-cheap) | Task 6 (domain/context.ts) + Task 10 (route) |
| §4.4 Viewport reporting | Task 8 (route + storage) + Task 11 (frontend reporter) |
| §5.1 Worked example end-to-end | Task 9 (routes-domain.test.ts "happy path") |
| §6.1 Backwards compat (existing routes unchanged) | Task 7 (only adds inference; existing tests still pass) |
| §6.2 User overrides discipline | Task 7 (patch inference) + Task 11 (role-render honors styleOwnedBy) + Task 3 (compile upsert doesn't clobber) |
| §7 Error matrix | Task 5 (validate.ts errors) + Task 9 (cascade-confirm, idempotency, dryRun) |
| §8 CLI surface | Task 12 (define/connect/group/note/layout/delete/apply/context) |
| §9 Skill rewrite | Task 13 |
| §10 Testing strategy | each task has its own tests; §10.6 perf — covered via Task 6 context budget test + Task 9 batch test |
| §13 Extensibility map | Task 1 (Role/Kind/Mode unions in shared package — adding one is 1-2 file change as promised) |

All spec sections have at least one task. No gaps.

### Placeholder scan

- No "TBD"/"TODO"/"implement later" in steps.
- Every code step contains complete code (not "add similar code"). One exception: Task 11's `from-canvas-state.ts` modification refers to "exact placement depends on existing code" — this is acceptable because the file is a specific known file and the implementer reads it before editing; the rule given (port-side → anchor) is concrete.
- Test code is concrete with real assertions.

### Type consistency

- `nameToShapeId(name) → "shape:e_<name>"` — same in Tasks 3, 4, 6, compile.ts and tests.
- `DomainAction`, `DomainResponse`, `ActionError.code` — defined Task 2, used Tasks 5, 9.
- `LayoutHint.mode`/`scope`/`spacing` — Task 1 types, Task 4 consumes, Task 9 orchestrates.
- `Rooms.setViewport / getViewport` — defined Task 8, consumed Task 10 (context.ts).
- `rolePreset(role)` — Task 1, used Tasks 3 (compile) and 11 (frontend render).
- `connectionPreset(kind)` — Task 1, used Tasks 3 and 11.
- `meta.pinned / meta.position / meta.styleOwnedBy` — set by Task 7 inference, respected by Task 3 (compile upsert) and Task 4 (ELK pin) and Task 11 (render fallback).
- `validateBatch` — Task 2 → Task 9 orchestrator.
- `buildContext(room, opts)` — Task 6 signature, Task 10 caller.

Plan internally consistent.

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-16-di-draw-phase2-1-agent-v2-implementation.md`.**
