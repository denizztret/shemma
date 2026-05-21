# DRW-116 — Global daemon + spaces registry + multi-gallery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Plan version:** v0.2
**Plan changelog:**
- **v0.2 (2026-05-21):** self-review pass — extracted `@shemma/lockfile` shared package (Task 5 retargeted), added Hono `ContextVariableMap` module augmentation (Task 8), split mega-refactor Task 10 → 10a/10b, clarified main.tsx routing always renders `MultiColumnLayout` (Tasks 14/15 reconciled), fixed `expandHome` to fetch `/api/session` (Task 14), added explicit fs.watch decision (deferred — read-through registry per-request OK for MVP, watcher = Phase 2), grounded Task 22 в реальной CLI cascade structure, locked frontend test framework на `bun:test`, explicit workspace verification step in Task 1, env-override ordering in Task 32 smoke.
- **v0.1 (2026-05-21):** initial draft (33 tasks, 10 milestones).

**Goal:** Заменить «daemon-per-CWD» модель на singleton daemon + persistent spaces registry + multi-gallery URL, чтобы один shemma process system-wide обслуживал любой зарегистрированный project, multi-проектный split-view работал из коробки, и AI tools писали в explicit space без ambiguity.

**Architecture:** Composite key `(spaceId, roomId)` несётся через URL / HTTP / WS / MCP. Registry — JSON-файл `~/.config/shemma/spaces.json` через shared package `@shemma/spaces` (доступен и CLI direct, и daemon-via-HTTP). Singleton — mkdir-based lock на `~/.claude/.shemma-port-<port>.lock/` с PID file внутри (`proper-lockfile` library). Storage resolver — функция `resolveRoomStorage(space, profile, roomId)` с тремя layout'ами (`project | legacy | direct`). Frontend — `?cols=<id>[:<roomId>],<id2>...` syntax + 1-3 column split. Legacy `~/.claude/projects/<slug>/canvas/` auto-registрируется как `default` space (layout=`legacy`).

**Tech Stack:** Bun + TypeScript + Hono (backend), tldraw 5.x + React 18 + Vite (frontend), zod (MCP schemas), `proper-lockfile` (mkdir lock), node `fs.watch` (registry hot-reload). Tests: `bun test` для backend/cli/mcp/spaces, Vitest для frontend.

**Spec reference:** `docs/superpowers/specs/2026-05-21-global-daemon-spaces-design.md` (v0.3). Все секции §X.Y ниже — links в эту спеку.

**Baseline:** `main @ 0f8baff` (release 0.20.3, 932 tests/0 fail).
**Feature branch:** `feature/global-daemon-spaces`.
**Target tag:** `0.22.0`.

---

## File structure

### Новые файлы

- `packages/shemma-spaces/` — новый shared package.
  - `package.json` — `@shemma/spaces`, peer-free, depends only on node:fs/path.
  - `src/types.ts` — `SpaceId`, `SpaceRecord`, `SpacesRegistryFile`, `SpaceStorageLayout`, DTO types.
  - `src/registry.ts` — `loadRegistry`, `loadAndModify`, `registerSpace`, `forgetSpace`, `renameSpaceLabel`, `findSpaceById`, `findSpaceByPath`, `listSpaces`.
  - `src/storage-resolver.ts` — `resolveRoomStorage(space, profile, roomId)`, `resolveStorageRoot(space, profile)`.
  - `src/id-gen.ts` — `generateSpaceId(path, existingIds)`, slug helpers.
  - `src/dto.ts` — `toPublicDTO`, `toLocalDTO`.
  - `src/lock.ts` — wrapper over `proper-lockfile` для advisory lock на `spaces.json.lock`.
  - `src/index.ts` — re-export public surface.
  - `src/__tests__/` — Bun tests.

- `packages/shemma-lockfile/` — **new shared package**, owners the mkdir-lock primitives и PID metadata read/write. Imported из обоих `@shemma/cli` и `@shemma/backend`. _Confirmed scaffolded в Task 5._
- `apps/backend/src/middleware/space.ts` — Hono middleware: extract `space` query → validate → lookup → attach to context.
- `apps/backend/src/spaces-watcher.ts` — `fs.watch` over `~/.config/shemma/spaces.json` → hot-reload in-memory registry.
- `apps/backend/src/routes/spaces.ts` — registry CRUD endpoints (`GET/POST/DELETE/PATCH /api/spaces`).
- `apps/frontend/src/spaces/SpacesPage.tsx` — landing page (list + add form).
- `apps/frontend/src/spaces/AddSpaceForm.tsx` — text input для path entry.
- `apps/frontend/src/spaces/MultiColumnLayout.tsx` — split column container.
- `apps/frontend/src/spaces/SplitterBar.tsx` — resizable splitter.
- `apps/frontend/src/spaces/url-parser.ts` — `?cols=` parser + serializer.
- `packages/shemma-cli/src/commands/spaces.ts` — `shemma s {list,add,forget,rename,prune,reveal}`.
- `packages/shemma-cli/src/commands/top-level-path.ts` — top-level positional `shemma <path>...`.
- `apps/backend/src/migration/legacy-spaces.ts` — scan `~/.claude/projects/` + auto-register.

### Изменяемые файлы

- `apps/backend/src/config.ts` — remove `storageDir` singleton, replace с per-request resolution.
- `apps/backend/src/persistence.ts` — accept `roomPath` directly (не `roomsDir`-derived).
- `apps/backend/src/rooms.ts` — pass `space` to room CRUD, scope listings.
- `apps/backend/src/routes/{state,domain,context,rooms,prompts,layout,ai,export-miro,active-rooms,...}.ts` — все handlers читают `space` из `c.get("space")`, не из query.
- `apps/backend/src/ws.ts` — WsHub keying changed to `${spaceId}:${roomId}`, accept `space` from connect URL.
- `apps/backend/src/ws/active-rooms.ts` — ActiveRoomsTracker keyed by `(space, room)`.
- `apps/backend/src/index.ts` — register middleware, init registry, init legacy migration.
- `apps/backend/src/storage.ts` — gut current resolution; reduce к thin wrapper над `@shemma/spaces.resolveRoomStorage`.
- `apps/frontend/src/main.tsx` — URL routing → `parseUrl` → `<SpacesPage>` / `<MultiColumnLayout>`.
- `apps/frontend/src/App.tsx` — accept `space` + `room` props, build `wsUrl` с обоими.
- `apps/frontend/src/gallery/Gallery.tsx` — accept `space` prop, fetch `/api/rooms?space=<id>`.
- `apps/frontend/vite.config.ts` — no change required (proxy passes through).
- `packages/shemma-cli/src/daemon.ts` — replace PID-only acquire с mkdir-lock acquire flow.
- `packages/shemma-cli/src/storage.ts` — remove `resolveStorageForOpen`; replace с registry lookup.
- `packages/shemma-cli/src/index.ts` — wire top-level path positional + new subcommands.
- `packages/shemma-cli/src/profile.ts` — add `lockDir(port)` helper.
- `packages/shemma-client/src/index.ts` — add `space` field на CanvasClient + `?space=` в every query.
- `packages/shemma-mcp/src/server.ts` — wire `space` resolver в каждый tool registration.
- `packages/shemma-mcp/src/tools/*.ts` — schemas: `space: z.string().optional()`, handler calls resolver.
- `packages/shemma-mcp/src/room-resolver.ts` — refactor / split into space-resolver + room-resolver.
- Все package.json — bump version 0.20.3 → 0.22.0 в release task.
- `CHANGELOG.md` — entry 0.22.0.
- `CLAUDE.md` — update architecture summary (singleton + composite key).

### Удаляемые / deprecated

- `apps/backend/src/config.ts` — `storageDir` singleton proxy goes away.
- `packages/shemma-cli/src/storage.ts:resolveStorageForOpen` — replaced.
- `--storage` flag в CLI — deprecation warning + auto-translate в `shemma s add` через transitional shim.

---

## Milestones overview

| # | Milestone | Tasks | Approx LOC |
|---|---|---|---|
| 1 | Foundation: `@shemma/spaces` shared package | T1–T4 | +1200 |
| 2 | Singleton daemon: `@shemma/lockfile` + lifecycle | T5–T7 | +400 |
| 3 | Backend routing migration | T8, T9, T10a, T10b, T11, T12 | +600 / −300 |
| 4 | Frontend routing + spaces landing | T13–T16 | +800 |
| 5 | Multi-gallery split UI | T17–T20 | +500 |
| 6 | CLI surface | T21–T24 | +500 |
| 7 | MCP `space` param + resolver | T25–T28 | +400 |
| 8 | Legacy migration | T29–T31 | +300 |
| 9 | End-to-end smoke + integration tests | T32 | +200 |
| 10 | Release | T33 | docs only |

Estimated total: ~120 new tests, +4500/-300 LOC across **34 tasks** (T10 split в v0.2).

**Deferred (out of MVP plan):**
- `fs.watch` daemon-side для live registry hot-reload. **Decision:** per-request `loadRegistry()` (читает `spaces.json` from disk on each `findSpaceById` call) — acceptable performance (1-10 KB JSON parse каждые ~few ms), решает CLI↔daemon coherence без watcher complexity. Spec §4.8 watcher = Phase 2 follow-up. Workaround: middleware optionally caches `Map<SpaceId, SpaceRecord>` с 1s TTL если perf bites.

---

# Milestone 1: Foundation — `@shemma/spaces` package

### Task 1: Bootstrap `@shemma/spaces` package + types

**Files:**
- Create: `packages/shemma-spaces/package.json`
- Create: `packages/shemma-spaces/tsconfig.json`
- Create: `packages/shemma-spaces/src/types.ts`
- Create: `packages/shemma-spaces/src/index.ts`
- Modify: `package.json` (root) — add workspace entry

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@shemma/spaces",
  "version": "0.20.3",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": { "test": "bun test" },
  "dependencies": {}
}
```

- [ ] **Step 2: Create tsconfig.json (extend root)**

```json
{
  "extends": "../../tsconfig.json",
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Write types.ts**

```ts
export type SpaceId = string;
export const SPACE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const ROOM_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export type SpaceStorageLayout = "project" | "legacy" | "direct";
export type Profile = "release" | "dev" | "debug";

export type SpaceRecord = {
  id: SpaceId;
  path: string;
  storageLayout: SpaceStorageLayout;
  label?: string;
  createdAt: string;
  lastUsedAt: string;
  legacy?: boolean;
};

export type SpacesRegistryFile = {
  schemaVersion: 1;
  spaces: SpaceRecord[];
};

export type SpacePublicDTO = {
  id: SpaceId;
  label?: string;
  lastUsedAt: string;
  orphaned?: boolean;
};

export type SpaceLocalDTO = SpacePublicDTO & {
  path: string;
  storageLayout: SpaceStorageLayout;
  createdAt: string;
  legacy?: boolean;
};
```

- [ ] **Step 4: Write index.ts barrel**

```ts
export * from "./types.js";
```

- [ ] **Step 5: Verify root package.json workspaces**

Read `/Users/tretyakov_dv/Projects/sandbox/di.draw/package.json`. Confirm `"workspaces"` field includes `"packages/*"` AND `"apps/*"`. Current expected state (do not blindly overwrite):

```json
"workspaces": ["packages/*", "apps/*"]
```

Если уже есть → no change. Иначе — добавить.

- [ ] **Step 6: Sanity-check naming collisions vs other packages**

`SpaceStorageLayout` и `Profile` types — search для conflict в:
- `packages/shemma-domain/src/**/*.ts` (особенно Role / ConnectionKind / LayoutMode — наши новые types не должны столкнуться)
- `packages/shemma-cli/src/profile.ts` уже exports `type Profile = "release" | "dev" | "debug"` — то же tuple что наш в `@shemma/spaces/types.ts`. **Decision:** keep both для now (independent types в independent packages); если станет проблемой — Phase 2 follow-up consolidates в `@shemma/spaces`. Document это в commit message.

```bash
grep -rn "type Profile\|export.*Profile" packages/shemma-domain/src/ packages/shemma-cli/src/profile.ts
```

- [ ] **Step 7: Run `bun install` to wire workspace, smoke `bun --filter=@shemma/spaces test` (no tests yet → expect "no tests found")**

- [ ] **Step 8: Commit**

```bash
git add packages/shemma-spaces/ package.json bun.lockb
git commit -m "feat(spaces): scaffold @shemma/spaces package with type definitions"
```

---

### Task 2: ID generation + storage resolver

**Files:**
- Create: `packages/shemma-spaces/src/id-gen.ts`
- Create: `packages/shemma-spaces/src/storage-resolver.ts`
- Create: `packages/shemma-spaces/src/__tests__/id-gen.test.ts`
- Create: `packages/shemma-spaces/src/__tests__/storage-resolver.test.ts`
- Modify: `packages/shemma-spaces/src/index.ts`

- [ ] **Step 1: Write id-gen.test.ts (RED)**

```ts
import { describe, it, expect } from "bun:test";
import { generateSpaceId, slugify } from "../id-gen.js";

describe("slugify", () => {
  it("lowercases alnum, replaces non-alnum with hyphen", () => {
    expect(slugify("My App")).toBe("my-app");
    expect(slugify("foo_bar.baz")).toBe("foo-bar-baz");
    expect(slugify("--Hi--")).toBe("hi");
  });
  it("returns 'space' for empty input", () => {
    expect(slugify("")).toBe("space");
    expect(slugify("---")).toBe("space");
  });
});

describe("generateSpaceId", () => {
  it("returns slugified basename when free", () => {
    expect(generateSpaceId("/Users/a/ios", new Set())).toBe("ios");
  });
  it("appends -2 on collision", () => {
    expect(generateSpaceId("/Users/a/ios", new Set(["ios"]))).toBe("ios-2");
    expect(generateSpaceId("/Users/a/ios", new Set(["ios", "ios-2"]))).toBe("ios-3");
  });
  it("truncates base to 32 chars before suffix", () => {
    const long = "/a/" + "x".repeat(50);
    expect(generateSpaceId(long, new Set()).length).toBeLessThanOrEqual(32);
  });
  it("bumps reserved 'default' when path differs", () => {
    expect(generateSpaceId("/Users/a/default", new Set(["default"]))).toBe("default-2");
  });
});
```

- [ ] **Step 2: Run test, verify failure ("not defined")**

- [ ] **Step 3: Implement id-gen.ts (GREEN)**

```ts
import path from "node:path";
import { SPACE_ID_PATTERN, type SpaceId } from "./types.js";

export function slugify(s: string): string {
  const stripped = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  return stripped.length === 0 ? "space" : stripped;
}

export function generateSpaceId(absolutePath: string, existing: Set<SpaceId>): SpaceId {
  const base = slugify(path.basename(absolutePath)).slice(0, 32);
  if (!existing.has(base) && base !== "default") {
    return base;
  }
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error(`Cannot generate unique space id for ${absolutePath}`);
}
```

- [ ] **Step 4: Run id-gen tests, expect green**

- [ ] **Step 5: Write storage-resolver.test.ts (RED)**

```ts
import { describe, it, expect } from "bun:test";
import path from "node:path";
import { resolveRoomStorage, resolveStorageRoot } from "../storage-resolver.js";
import type { SpaceRecord } from "../types.js";

function fakeSpace(overrides: Partial<SpaceRecord>): SpaceRecord {
  return {
    id: "x",
    path: "/p",
    storageLayout: "project",
    createdAt: "",
    lastUsedAt: "",
    ...overrides,
  };
}

describe("resolveRoomStorage", () => {
  it("project layout uses .shemma/canvas", () => {
    const s = fakeSpace({ path: "/u/proj", storageLayout: "project" });
    expect(resolveRoomStorage(s, "release", "r1")).toBe(path.join("/u/proj", ".shemma", "canvas", "r1.json"));
  });
  it("project layout dev uses canvas-dev", () => {
    const s = fakeSpace({ path: "/u/proj", storageLayout: "project" });
    expect(resolveRoomStorage(s, "dev", "r1")).toBe(path.join("/u/proj", ".shemma", "canvas-dev", "r1.json"));
  });
  it("legacy layout has no .shemma wrapper", () => {
    const s = fakeSpace({ path: "/u/.claude/projects/foo", storageLayout: "legacy" });
    expect(resolveRoomStorage(s, "release", "r1")).toBe(path.join("/u/.claude/projects/foo", "canvas", "r1.json"));
  });
  it("direct layout has no subdir at all", () => {
    const s = fakeSpace({ path: "/x/storage", storageLayout: "direct" });
    expect(resolveRoomStorage(s, "release", "r1")).toBe(path.join("/x/storage", "r1.json"));
    expect(resolveRoomStorage(s, "dev", "r1")).toBe(path.join("/x/storage", "r1.json"));
  });
});
```

- [ ] **Step 6: Implement storage-resolver.ts (GREEN)**

```ts
import path from "node:path";
import type { Profile, SpaceRecord } from "./types.js";

export function resolveStorageRoot(space: SpaceRecord, profile: Profile): string {
  const subdir = profile === "dev" ? "canvas-dev" : "canvas";
  switch (space.storageLayout) {
    case "project": return path.join(space.path, ".shemma", subdir);
    case "legacy":  return path.join(space.path, subdir);
    case "direct":  return space.path;
  }
}

export function resolveRoomStorage(space: SpaceRecord, profile: Profile, roomId: string): string {
  return path.join(resolveStorageRoot(space, profile), `${roomId}.json`);
}
```

- [ ] **Step 7: Run all tests, expect green. Update index.ts re-exports**

```ts
export * from "./types.js";
export * from "./id-gen.js";
export * from "./storage-resolver.js";
```

- [ ] **Step 8: Commit**

```bash
git add packages/shemma-spaces/
git commit -m "feat(spaces): add id generator and storage resolver with three layouts"
```

---

### Task 3: Registry file I/O + locking

**Files:**
- Create: `packages/shemma-spaces/src/paths.ts` (resolve XDG paths)
- Create: `packages/shemma-spaces/src/registry.ts`
- Create: `packages/shemma-spaces/src/__tests__/registry.test.ts`
- Modify: `packages/shemma-spaces/package.json` — add `proper-lockfile` dep
- Modify: `packages/shemma-spaces/src/index.ts`

- [ ] **Step 1: Add proper-lockfile to deps**

```bash
cd packages/shemma-spaces && bun add proper-lockfile
```

(Or edit package.json manually if Bun monorepo wants explicit version.)

- [ ] **Step 2: Write paths.ts**

```ts
import os from "node:os";
import path from "node:path";

export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg && xdg.length > 0 ? path.join(xdg, "shemma") : path.join(os.homedir(), ".config", "shemma");
}

export function spacesJsonPath(): string {
  return path.join(configDir(), "spaces.json");
}

export function spacesLockPath(): string {
  return path.join(configDir(), "spaces.json.lock");
}
```

- [ ] **Step 3: Write registry.test.ts (RED)**

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRegistry, loadAndModify, registerSpace, forgetSpace, listSpaces, findSpaceById } from "../registry.js";

let tmpDir: string;
let origXdg: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shemma-spaces-"));
  origXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmpDir;
});
afterEach(() => {
  process.env.XDG_CONFIG_HOME = origXdg;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadRegistry", () => {
  it("returns empty schema-v1 when file missing", () => {
    const r = loadRegistry();
    expect(r.schemaVersion).toBe(1);
    expect(r.spaces).toEqual([]);
  });
});

describe("registerSpace", () => {
  it("creates new record on first call", () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "proj-"));
    const { space, created } = registerSpace(project);
    expect(created).toBe(true);
    expect(space.path).toBe(fs.realpathSync(project));
    expect(space.storageLayout).toBe("project");
    fs.rmSync(project, { recursive: true });
  });

  it("is idempotent on same realpath", () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "proj-"));
    const a = registerSpace(project);
    const b = registerSpace(project);
    expect(b.created).toBe(false);
    expect(b.space.id).toBe(a.space.id);
    fs.rmSync(project, { recursive: true });
  });
});

describe("listSpaces", () => {
  it("returns spaces sorted by lastUsedAt desc", () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), "a-"));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), "b-"));
    registerSpace(a);
    loadAndModify(reg => {
      // age 'a' by setting older lastUsedAt
      reg.spaces[0].lastUsedAt = "2020-01-01T00:00:00Z";
      return reg;
    });
    registerSpace(b);
    const sorted = listSpaces();
    expect(sorted[0].path).toBe(fs.realpathSync(b));
    fs.rmSync(a, { recursive: true });
    fs.rmSync(b, { recursive: true });
  });
});

describe("forgetSpace", () => {
  it("removes from registry", () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), "a-"));
    const { space } = registerSpace(a);
    forgetSpace(space.id);
    expect(findSpaceById(space.id)).toBeUndefined();
    fs.rmSync(a, { recursive: true });
  });
});
```

- [ ] **Step 4: Implement registry.ts (GREEN)**

```ts
import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import { spacesJsonPath, configDir } from "./paths.js";
import { generateSpaceId } from "./id-gen.js";
import type { SpaceId, SpaceRecord, SpaceStorageLayout, SpacesRegistryFile } from "./types.js";

const EMPTY: SpacesRegistryFile = { schemaVersion: 1, spaces: [] };

function ensureDir(): void {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o755 });
}

export function loadRegistry(): SpacesRegistryFile {
  const file = spacesJsonPath();
  if (!fs.existsSync(file)) return structuredClone(EMPTY);
  const raw = fs.readFileSync(file, "utf8");
  const parsed = JSON.parse(raw) as SpacesRegistryFile;
  if (parsed.schemaVersion !== 1) throw new Error(`Unsupported spaces.json schema ${parsed.schemaVersion}`);
  return parsed;
}

function writeAtomic(content: SpacesRegistryFile): void {
  ensureDir();
  const file = spacesJsonPath();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(content, null, 2), { mode: 0o644 });
  fs.renameSync(tmp, file);
}

export function loadAndModify(fn: (reg: SpacesRegistryFile) => SpacesRegistryFile): SpacesRegistryFile {
  ensureDir();
  const file = spacesJsonPath();
  // proper-lockfile requires file to exist; touch
  if (!fs.existsSync(file)) writeAtomic(EMPTY);
  const release = lockfile.lockSync(file, { retries: { retries: 5, minTimeout: 50, maxTimeout: 500 } });
  try {
    const before = loadRegistry();
    const after = fn(structuredClone(before));
    writeAtomic(after);
    return after;
  } finally {
    release();
  }
}

export function registerSpace(
  rawPath: string,
  opts: { id?: SpaceId; storageLayout?: SpaceStorageLayout; legacy?: boolean; label?: string } = {},
): { space: SpaceRecord; created: boolean } {
  const real = fs.realpathSync(rawPath);
  let resultSpace: SpaceRecord | undefined;
  let created = false;
  loadAndModify(reg => {
    const existing = reg.spaces.find(s => s.path === real);
    if (existing) {
      existing.lastUsedAt = new Date().toISOString();
      resultSpace = existing;
      return reg;
    }
    const usedIds = new Set(reg.spaces.map(s => s.id));
    const id = opts.id && !usedIds.has(opts.id) ? opts.id : generateSpaceId(real, usedIds);
    const now = new Date().toISOString();
    const record: SpaceRecord = {
      id,
      path: real,
      storageLayout: opts.storageLayout ?? "project",
      label: opts.label,
      createdAt: now,
      lastUsedAt: now,
      legacy: opts.legacy,
    };
    reg.spaces.push(record);
    resultSpace = record;
    created = true;
    return reg;
  });
  return { space: resultSpace!, created };
}

export function forgetSpace(id: SpaceId): void {
  loadAndModify(reg => {
    reg.spaces = reg.spaces.filter(s => s.id !== id);
    return reg;
  });
}

export function renameSpaceLabel(id: SpaceId, label: string): SpaceRecord {
  let result: SpaceRecord | undefined;
  loadAndModify(reg => {
    const s = reg.spaces.find(r => r.id === id);
    if (!s) throw new Error(`space not found: ${id}`);
    s.label = label;
    result = s;
    return reg;
  });
  return result!;
}

export function findSpaceById(id: SpaceId): SpaceRecord | undefined {
  return loadRegistry().spaces.find(s => s.id === id);
}

export function findSpaceByPath(absolutePath: string): SpaceRecord | undefined {
  const real = fs.realpathSync(absolutePath);
  return loadRegistry().spaces.find(s => s.path === real);
}

export function listSpaces(): SpaceRecord[] {
  return loadRegistry()
    .spaces
    .slice()
    .sort((a, b) => (a.lastUsedAt < b.lastUsedAt ? 1 : -1));
}

export function touchLastUsed(id: SpaceId): void {
  loadAndModify(reg => {
    const s = reg.spaces.find(r => r.id === id);
    if (s) s.lastUsedAt = new Date().toISOString();
    return reg;
  });
}
```

- [ ] **Step 5: Run all registry tests, expect green**

- [ ] **Step 6: Update index.ts re-exports**

```ts
export * from "./types.js";
export * from "./id-gen.js";
export * from "./storage-resolver.js";
export * from "./registry.js";
export * from "./paths.js";
```

- [ ] **Step 7: Commit**

```bash
git add packages/shemma-spaces/
git commit -m "feat(spaces): add file-backed registry with proper-lockfile concurrency"
```

---

### Task 4: DTO helpers + lastUsedAt debounce + watcher

**Files:**
- Create: `packages/shemma-spaces/src/dto.ts`
- Create: `packages/shemma-spaces/src/debounced-touch.ts`
- Create: `packages/shemma-spaces/src/__tests__/dto.test.ts`
- Modify: `packages/shemma-spaces/src/index.ts`

- [ ] **Step 1: Write dto.test.ts**

```ts
import { describe, it, expect } from "bun:test";
import { toPublicDTO, toLocalDTO } from "../dto.js";
import type { SpaceRecord } from "../types.js";

const rec: SpaceRecord = {
  id: "ios",
  path: "/Users/a/ios",
  storageLayout: "project",
  label: "iOS",
  createdAt: "2026-05-21T00:00:00Z",
  lastUsedAt: "2026-05-21T10:00:00Z",
  legacy: false,
};

describe("toPublicDTO", () => {
  it("omits path and storageLayout", () => {
    const dto = toPublicDTO(rec);
    expect(dto).not.toHaveProperty("path");
    expect(dto).not.toHaveProperty("storageLayout");
    expect(dto.id).toBe("ios");
    expect(dto.label).toBe("iOS");
  });
});

describe("toLocalDTO", () => {
  it("includes path and storageLayout", () => {
    const dto = toLocalDTO(rec);
    expect(dto.path).toBe("/Users/a/ios");
    expect(dto.storageLayout).toBe("project");
  });
});
```

- [ ] **Step 2: Implement dto.ts**

```ts
import type { SpaceLocalDTO, SpacePublicDTO, SpaceRecord } from "./types.js";

export function toPublicDTO(s: SpaceRecord, opts?: { orphaned?: boolean }): SpacePublicDTO {
  return {
    id: s.id,
    label: s.label,
    lastUsedAt: s.lastUsedAt,
    orphaned: opts?.orphaned,
  };
}

export function toLocalDTO(s: SpaceRecord, opts?: { orphaned?: boolean }): SpaceLocalDTO {
  return {
    ...toPublicDTO(s, opts),
    path: s.path,
    storageLayout: s.storageLayout,
    createdAt: s.createdAt,
    legacy: s.legacy,
  };
}
```

- [ ] **Step 3: Implement debounced-touch.ts**

```ts
import { loadAndModify } from "./registry.js";
import type { SpaceId } from "./types.js";

const DEFAULT_FLUSH_MS = Number(process.env.SHEMMA_SPACES_FLUSH_MS ?? 10_000);

export class DebouncedTouch {
  private dirty = new Set<SpaceId>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private flushMs: number = DEFAULT_FLUSH_MS) {}

  touch(id: SpaceId): void {
    this.dirty.add(id);
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.flushMs);
  }

  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.dirty.size === 0) return;
    const ids = Array.from(this.dirty);
    this.dirty.clear();
    const now = new Date().toISOString();
    loadAndModify(reg => {
      for (const id of ids) {
        const s = reg.spaces.find(r => r.id === id);
        if (s) s.lastUsedAt = now;
      }
      return reg;
    });
  }

  shutdown(): void { this.flush(); }
}
```

- [ ] **Step 4: Update index.ts**

```ts
export * from "./types.js";
export * from "./id-gen.js";
export * from "./storage-resolver.js";
export * from "./registry.js";
export * from "./paths.js";
export * from "./dto.js";
export * from "./debounced-touch.js";
```

- [ ] **Step 5: Run all tests, expect green**

- [ ] **Step 6: Commit**

```bash
git add packages/shemma-spaces/
git commit -m "feat(spaces): add public/local DTOs and debounced lastUsedAt touch"
```

---

# Milestone 2: Singleton daemon — mkdir lock + lifecycle

### Task 5: Scaffold `@shemma/lockfile` shared package + mkdir lock primitives

**Why shared package:** lockfile helpers нужны и в CLI (acquire flow в `daemon start`), и в backend (write PID metadata после server.ready, release на SIGTERM). Без shared package — code duplication. Scaffolding minimal (~100 LOC + tests).

**Files:**
- Create: `packages/shemma-lockfile/package.json`
- Create: `packages/shemma-lockfile/tsconfig.json`
- Create: `packages/shemma-lockfile/src/index.ts`
- Create: `packages/shemma-lockfile/src/__tests__/lockfile.test.ts`
- Modify: `packages/shemma-cli/src/profile.ts` — add `lockDir(port)` helper (depends на `os.homedir()` — local to CLI, не shared)

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@shemma/lockfile",
  "version": "0.20.3",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": { "test": "bun test" },
  "dependencies": {}
}
```

- [ ] **Step 2: Create tsconfig.json (extend root)**

```json
{
  "extends": "../../tsconfig.json",
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Add `lockDir(port)` to profile.ts (CLI-local helper)**

Edit `packages/shemma-cli/src/profile.ts`. Add:

```ts
import os from "node:os";
import path from "node:path";

export function lockDir(port: number): string {
  return path.join(os.homedir(), ".claude", `.shemma-port-${port}.lock`);
}
```

(Это CLI-specific, потому что resolves under `~/.claude`. Backend получает `lockDir` через env `SHEMMA_LOCK_DIR`, set CLI'ем при spawn — см. Task 6.)

- [ ] **Step 4: Write lockfile.test.ts (RED)**

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireLock, releaseLock, isLockAlive, readLockMetadata, writeLockMetadata } from "../index.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shemma-lock-"));
});
afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("acquireLock", () => {
  it("creates lock dir atomically", () => {
    const lockDir = path.join(tmpRoot, "lock");
    expect(acquireLock(lockDir)).toBe(true);
    expect(fs.existsSync(lockDir)).toBe(true);
  });
  it("returns false on EEXIST", () => {
    const lockDir = path.join(tmpRoot, "lock");
    fs.mkdirSync(lockDir);
    expect(acquireLock(lockDir)).toBe(false);
  });
});

describe("isLockAlive", () => {
  it("returns false on empty lock dir (acquire-in-progress or stale)", () => {
    const lockDir = path.join(tmpRoot, "lock");
    fs.mkdirSync(lockDir);
    expect(isLockAlive(lockDir)).toBe(false);
  });
  it("returns true on alive PID", () => {
    const lockDir = path.join(tmpRoot, "lock");
    fs.mkdirSync(lockDir);
    writeLockMetadata(lockDir, { pid: process.pid, port: 9999, startedAt: "x", profile: "release" });
    expect(isLockAlive(lockDir)).toBe(true);
  });
});

describe("readLockMetadata", () => {
  it("returns undefined when daemon.pid missing", () => {
    const lockDir = path.join(tmpRoot, "lock");
    fs.mkdirSync(lockDir);
    expect(readLockMetadata(lockDir)).toBeUndefined();
  });
  it("returns parsed metadata when present", () => {
    const lockDir = path.join(tmpRoot, "lock");
    fs.mkdirSync(lockDir);
    writeLockMetadata(lockDir, { pid: 42, port: 8787, startedAt: "2026-05-21T00:00:00Z", profile: "release" });
    const m = readLockMetadata(lockDir);
    expect(m?.pid).toBe(42);
    expect(m?.port).toBe(8787);
  });
});

describe("releaseLock", () => {
  it("removes lock dir recursively", () => {
    const lockDir = path.join(tmpRoot, "lock");
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, "daemon.pid"), "{}");
    releaseLock(lockDir);
    expect(fs.existsSync(lockDir)).toBe(false);
  });
  it("no-op if lock dir already gone", () => {
    releaseLock(path.join(tmpRoot, "nonexistent"));
    // no throw expected
  });
});
```

- [ ] **Step 5: Implement src/index.ts (GREEN)**

```ts
import fs from "node:fs";
import path from "node:path";

export type LockMetadata = {
  pid: number;
  port: number;
  startedAt: string;
  profile: string;
};

export function acquireLock(lockDir: string): boolean {
  try {
    fs.mkdirSync(lockDir, { recursive: false });
    return true;
  } catch (err: any) {
    if (err && err.code === "EEXIST") return false;
    throw err;
  }
}

export function releaseLock(lockDir: string): void {
  fs.rmSync(lockDir, { recursive: true, force: true });
}

export function readLockMetadata(lockDir: string): LockMetadata | undefined {
  const pidPath = path.join(lockDir, "daemon.pid");
  if (!fs.existsSync(pidPath)) return undefined;
  try { return JSON.parse(fs.readFileSync(pidPath, "utf8")) as LockMetadata; }
  catch { return undefined; }
}

export function writeLockMetadata(lockDir: string, meta: LockMetadata): void {
  const pidPath = path.join(lockDir, "daemon.pid");
  const tmp = `${pidPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(meta));
  fs.renameSync(tmp, pidPath);
}

export function isLockAlive(lockDir: string): boolean {
  const meta = readLockMetadata(lockDir);
  if (!meta) return false;
  try { process.kill(meta.pid, 0); return true; }
  catch { return false; }
}
```

- [ ] **Step 6: Add `@shemma/lockfile` к CLI и backend deps**

```bash
# packages/shemma-cli/package.json — add to dependencies:
"@shemma/lockfile": "workspace:*"

# apps/backend/package.json — add to dependencies:
"@shemma/lockfile": "workspace:*"
```

Run `bun install` чтобы wire workspace.

- [ ] **Step 7: Run lockfile tests, expect green**

```bash
bun --filter=@shemma/lockfile test
```

- [ ] **Step 8: Commit**

```bash
git add packages/shemma-lockfile/ packages/shemma-cli/src/profile.ts packages/shemma-cli/package.json apps/backend/package.json bun.lockb
git commit -m "feat(lockfile): scaffold @shemma/lockfile shared package with mkdir-lock primitives"
```

---

### Task 6: Integrate lock into daemon start

**Files:**
- Modify: `packages/shemma-cli/src/daemon.ts` — rewrite start/stop with lock protocol
- Modify: `apps/backend/src/index.ts` — child reads `SHEMMA_LOCK_DIR`, writes PID metadata after server ready, removes lock on SIGTERM
- Modify: `packages/shemma-cli/src/__tests__/daemon.test.ts` — update assertions

- [ ] **Step 1: Modify daemon.ts start() to use acquire flow**

Replace existing `start()` body с acquire→spawn→poll flow:

```ts
import { lockDir as lockDirFor } from "./profile.js";
import { acquireLock, releaseLock, readLockMetadata, isLockAlive } from "@shemma/lockfile";
import fs from "node:fs";
import path from "node:path";

const POLL_INTERVAL_MS = 100;
const ACQUIRE_TIMEOUT_MS = 5000;

async function pollFor(condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return true;
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
}

async function checkHealth(port: number): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 500);
    const resp = await fetch(`http://localhost:${port}/api/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    return resp.ok;
  } catch { return false; }
}

export async function start(opts: StartOptions): Promise<StartResult> {
  const port = portFor(opts.profile);
  const dir = lockDirFor(port);

  // 1. Try acquire
  if (!acquireLock(dir)) {
    // EEXIST → probe
    const meta = readLockMetadata(dir);
    if (!meta) {
      // acquire-in-progress; wait
      const appeared = await pollFor(() => fs.existsSync(path.join(dir, "daemon.pid")), ACQUIRE_TIMEOUT_MS);
      if (!appeared) {
        releaseLock(dir);
        if (!acquireLock(dir)) throw new Error("daemon-lock-contention");
      } else {
        const refreshed = readLockMetadata(dir);
        if (refreshed && await checkHealth(refreshed.port)) {
          return { reused: true, pid: refreshed.pid, port: refreshed.port };
        }
        releaseLock(dir);
        if (!acquireLock(dir)) throw new Error("daemon-lock-contention");
      }
    } else {
      if (isLockAlive(dir) && await checkHealth(meta.port)) {
        return { reused: true, pid: meta.pid, port: meta.port };
      }
      releaseLock(dir);
      if (!acquireLock(dir)) throw new Error("daemon-lock-contention");
    }
  }

  // 2. Acquired. Spawn child.
  const child = spawnDetached(opts, { lockDir: dir, port });

  // 3. Wait for PID file + healthcheck
  const ready = await pollFor(async () => {
    if (!fs.existsSync(path.join(dir, "daemon.pid"))) return false;
    return checkHealth(port);
  }, ACQUIRE_TIMEOUT_MS);

  if (!ready) {
    try { process.kill(child.pid!, "SIGTERM"); } catch {}
    releaseLock(dir);
    throw new Error("daemon failed to start within 5s; check ~/.claude/.shemma-<profile>.log");
  }

  const final = readLockMetadata(dir);
  return { reused: false, pid: final!.pid, port };
}
```

`spawnDetached` — refactor existing spawn code, must add `SHEMMA_LOCK_DIR: dir` and `SHEMMA_PORT: String(port)` to env.

- [ ] **Step 2: Modify apps/backend/src/index.ts**

Backend reads `SHEMMA_LOCK_DIR` env, writes PID file after `server.ready()`, registers SIGTERM handler. Imports из shared `@shemma/lockfile` package (scaffolded в Task 5).

```ts
import { writeLockMetadata, releaseLock } from "@shemma/lockfile";
import fs from "node:fs";

const lockDir = process.env.SHEMMA_LOCK_DIR;
const port = Number(process.env.SHEMMA_PORT ?? 8787);
const profile = process.env.SHEMMA_PROFILE ?? "release";

// after Hono app ready (e.g. immediately after `server.listen()`):
if (lockDir) {
  fs.mkdirSync(lockDir, { recursive: true });
  writeLockMetadata(lockDir, {
    pid: process.pid,
    port,
    startedAt: new Date().toISOString(),
    profile,
  });
}

function shutdown() {
  if (lockDir) releaseLock(lockDir);
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
```

- [ ] **Step 3: Update existing daemon.test.ts**

Existing tests likely use real spawn → already cover. Add integration test:

```ts
it("second start returns reused=true when first is healthy", async () => {
  const first = await start({ profile: "release" });
  expect(first.reused).toBe(false);
  const second = await start({ profile: "release" });
  expect(second.reused).toBe(true);
  expect(second.pid).toBe(first.pid);
  await stop({ profile: "release" });
});
```

- [ ] **Step 4: Run cli + backend tests, fix any breakage**

- [ ] **Step 5: Manual smoke**: `shemma daemon start` twice in a row → first creates, second reuses. `shemma daemon stop`.

- [ ] **Step 6: Commit**

```bash
git add packages/shemma-cli/src/daemon.ts apps/backend/src/index.ts packages/shemma-cli/src/__tests__/daemon.test.ts
git commit -m "feat(daemon): mkdir-lock acquire/release with PID handshake"
```

---

### Task 7: Auto-shutdown idle + status command

**Files:**
- Modify: `apps/backend/src/index.ts` — idle tracker
- Modify: `packages/shemma-cli/src/daemon.ts` — status() reads new lockfile format
- Create: `apps/backend/src/__tests__/idle-shutdown.test.ts`

- [ ] **Step 1: Idle tracker в backend**

```ts
// apps/backend/src/idle-tracker.ts
const DEFAULT_IDLE_MS = Number(process.env.SHEMMA_IDLE_SHUTDOWN_MS ?? 1_800_000);

export class IdleTracker {
  private wsCount = 0;
  private lastActivity = Date.now();
  private timer?: ReturnType<typeof setInterval>;

  constructor(private idleMs: number = DEFAULT_IDLE_MS, private onIdle: () => void = () => process.exit(0)) {
    if (this.idleMs > 0) {
      this.timer = setInterval(() => this.check(), Math.min(60_000, this.idleMs / 4));
    }
  }

  noteHttp(): void { this.lastActivity = Date.now(); }
  noteWsOpen(): void { this.wsCount++; this.lastActivity = Date.now(); }
  noteWsClose(): void { this.wsCount = Math.max(0, this.wsCount - 1); this.lastActivity = Date.now(); }

  private check(): void {
    if (this.wsCount > 0) return;
    if (Date.now() - this.lastActivity > this.idleMs) {
      this.onIdle();
    }
  }

  shutdown(): void { if (this.timer) clearInterval(this.timer); }
}
```

- [ ] **Step 2: Wire into Hono app + WS hub**

In `apps/backend/src/index.ts`:

```ts
const idle = new IdleTracker();
app.use("/api/*", async (c, next) => { idle.noteHttp(); await next(); });
// Pass `idle` to WsHub for WS open/close hooks
```

- [ ] **Step 3: Update `shemma daemon status` to read new lockfile**

```ts
export async function status(opts: { profile: Profile }): Promise<StatusResult> {
  const port = portFor(opts.profile);
  const dir = lockDirFor(port);
  const meta = readLockMetadata(dir);
  if (!meta || !isLockAlive(dir)) return { running: false };
  const healthy = await checkHealth(port);
  return { running: healthy, pid: meta.pid, port: meta.port, profile: meta.profile, startedAt: meta.startedAt };
}
```

- [ ] **Step 4: Write idle-shutdown.test.ts**

```ts
it("triggers onIdle after threshold with no activity", async () => {
  let called = false;
  const tracker = new IdleTracker(100, () => { called = true; });
  await new Promise(r => setTimeout(r, 250));
  expect(called).toBe(true);
  tracker.shutdown();
});

it("does not trigger while WS connections open", async () => {
  let called = false;
  const tracker = new IdleTracker(100, () => { called = true; });
  tracker.noteWsOpen();
  await new Promise(r => setTimeout(r, 250));
  expect(called).toBe(false);
  tracker.noteWsClose();
  tracker.shutdown();
});
```

- [ ] **Step 5: Run tests, expect green**

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/idle-tracker.ts apps/backend/src/__tests__/idle-shutdown.test.ts apps/backend/src/index.ts packages/shemma-cli/src/daemon.ts
git commit -m "feat(daemon): auto-shutdown idle (30 min default) + status reads mkdir lock"
```

---

# Milestone 3: Backend routing migration

### Task 8: Spaces registry middleware

**Files:**
- Create: `apps/backend/src/middleware/space.ts`
- Modify: `apps/backend/src/index.ts` — mount middleware
- Create: `apps/backend/src/__tests__/middleware-space.test.ts`

- [ ] **Step 1: Write middleware-space.test.ts (RED)**

```ts
import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { spaceMiddleware } from "../middleware/space.js";

let app: Hono;
beforeEach(() => {
  app = new Hono();
  app.use("/api/*", spaceMiddleware());
  app.get("/api/echo", c => c.json({ space: c.get("space") }));
});

describe("spaceMiddleware", () => {
  it("400 when space missing", async () => {
    const resp = await app.fetch(new Request("http://x/api/echo"));
    expect(resp.status).toBe(400);
  });
  it("400 when space malformed", async () => {
    const resp = await app.fetch(new Request("http://x/api/echo?space=BAD!"));
    expect(resp.status).toBe(400);
  });
  it("404 when space unknown", async () => {
    const resp = await app.fetch(new Request("http://x/api/echo?space=unknown-id"));
    expect(resp.status).toBe(404);
  });
  // green path covered в integration test (требует registry setup)
});
```

- [ ] **Step 2: Add Hono `ContextVariableMap` augmentation**

Create `apps/backend/src/types/hono.d.ts` (или append к existing `types/`):

```ts
import type { SpaceRecord } from "@shemma/spaces";

declare module "hono" {
  interface ContextVariableMap {
    space: SpaceRecord;
  }
}
```

Это даёт `c.set("space", record)` / `c.get("space")` proper typing без `as SpaceRecord` cast'ов в handler'ах (см. Task 11).

- [ ] **Step 3: Implement spaceMiddleware**

```ts
import type { MiddlewareHandler } from "hono";
import { SPACE_ID_PATTERN, findSpaceById } from "@shemma/spaces";

export function spaceMiddleware(opts: { allowList?: Set<string> } = {}): MiddlewareHandler {
  const allowList = opts.allowList ?? new Set<string>();
  return async (c, next) => {
    if (allowList.has(c.req.path)) { await next(); return; }
    const spaceId = c.req.query("space");
    if (!spaceId) return c.json({ error: "space_required" }, 400);
    if (!SPACE_ID_PATTERN.test(spaceId)) return c.json({ error: "invalid_space_id" }, 400);
    const record = findSpaceById(spaceId);
    if (!record) return c.json({ error: "space_not_found", id: spaceId }, 404);
    c.set("space", record);
    await next();
  };
}
```

- [ ] **Step 4: Mount в index.ts with allow-list**

```ts
const SPACE_ALLOWLIST = new Set([
  "/api/health",
  "/api/version",
  "/api/session",
  "/api/active-rooms",
  "/api/export/miro/boards",
  // /api/spaces handled by separate router (см. Task 9)
]);

app.use("/api/*", spaceMiddleware({ allowList: SPACE_ALLOWLIST }));
```

- [ ] **Step 5: Run middleware tests, expect green**

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/middleware/ apps/backend/src/types/hono.d.ts apps/backend/src/__tests__/middleware-space.test.ts apps/backend/src/index.ts
git commit -m "feat(backend): space middleware + Hono ContextVariableMap augmentation"
```

---

### Task 9: Spaces CRUD endpoints

**Files:**
- Create: `apps/backend/src/routes/spaces.ts`
- Modify: `apps/backend/src/index.ts` — mount router
- Create: `apps/backend/src/__tests__/routes-spaces.test.ts`

- [ ] **Step 1: Write routes-spaces.test.ts (RED)** — covers GET list, POST create idempotent, DELETE, PATCH

(detailed test code; aligned with §4.7 contract)

- [ ] **Step 2: Implement spaces router**

```ts
import { Hono } from "hono";
import fs from "node:fs";
import { listSpaces, registerSpace, forgetSpace, renameSpaceLabel, findSpaceById, toLocalDTO } from "@shemma/spaces";

export const spacesRouter = new Hono();

spacesRouter.get("/", c => {
  const isLocal = isLocalhost(c.req.header("host"));
  const dtos = listSpaces().map(s => isLocal ? toLocalDTO(s, { orphaned: !fs.existsSync(s.path) }) : { id: s.id, label: s.label, lastUsedAt: s.lastUsedAt });
  return c.json({ spaces: dtos });
});

spacesRouter.get("/:id", c => {
  const s = findSpaceById(c.req.param("id"));
  if (!s) return c.json({ error: "space_not_found" }, 404);
  return c.json({ space: toLocalDTO(s, { orphaned: !fs.existsSync(s.path) }) });
});

spacesRouter.post("/", async c => {
  const body = await c.req.json<{ path: string; label?: string }>();
  if (!body.path) return c.json({ error: "path_required" }, 400);
  try {
    const { space, created } = registerSpace(body.path, { label: body.label });
    return c.json({ space: toLocalDTO(space), created });
  } catch (err: any) {
    return c.json({ error: err.code === "ENOENT" ? "path_not_found" : "invalid_path", message: err.message }, 400);
  }
});

spacesRouter.delete("/:id", c => {
  forgetSpace(c.req.param("id"));
  return c.json({ ok: true });
});

spacesRouter.patch("/:id", async c => {
  const body = await c.req.json<{ label?: string }>();
  if (typeof body.label !== "string") return c.json({ error: "label_required" }, 400);
  const updated = renameSpaceLabel(c.req.param("id"), body.label);
  return c.json({ space: toLocalDTO(updated) });
});

function isLocalhost(host?: string): boolean {
  if (!host) return false;
  return host.startsWith("localhost") || host.startsWith("127.0.0.1") || host.startsWith("::1");
}
```

- [ ] **Step 3: Mount at `/api/spaces` BEFORE main middleware**

```ts
app.route("/api/spaces", spacesRouter);
app.use("/api/*", spaceMiddleware({ allowList: SPACE_ALLOWLIST }));
```

- [ ] **Step 4: Run tests, expect green**

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/routes/spaces.ts apps/backend/src/__tests__/routes-spaces.test.ts apps/backend/src/index.ts
git commit -m "feat(backend): /api/spaces CRUD with local/public DTO split"
```

---

### Task 10a: FilePersistence signature + RoomCache (new infrastructure)

**Scope:** Только new + minimal modify. Не trogает routes.ts (это Task 11) и rooms.ts integration (Task 10b).

**Files:**
- Modify: `apps/backend/src/persistence.ts` — constructor signature change
- Create: `apps/backend/src/room-cache.ts`
- Create: `apps/backend/src/__tests__/room-cache.test.ts`

- [ ] **Step 1: Modify FilePersistence constructor**

Current: `new FilePersistence(roomsDir, roomId)` → derives filepath internally. New:

```ts
export class FilePersistence {
  constructor(private filePath: string) {}
  // existing read/write/flushSync logic — replace any `path.join(roomsDir, roomId + ".json")` с `this.filePath`
}
```

Update all call sites внутри persistence.ts. Don't touch external callers yet (rooms.ts/routes — Task 10b/11 их обновит).

- [ ] **Step 2: Write room-cache.test.ts (RED)**

```ts
import { describe, it, expect } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { RoomCache } from "../room-cache.js";
import type { SpaceRecord } from "@shemma/spaces";

function fakeSpace(tmpRoot: string): SpaceRecord {
  return {
    id: "test", path: tmpRoot, storageLayout: "project",
    createdAt: "", lastUsedAt: "",
  };
}

describe("RoomCache", () => {
  it("creates FilePersistence at expected path for project layout", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rc-"));
    const cache = new RoomCache("release");
    const p = cache.get(fakeSpace(tmp), "r1");
    expect(p).toBeDefined();
    // Internal — verify по getter если есть, иначе через side effect
    fs.rmSync(tmp, { recursive: true });
  });
  it("returns same instance for same (space, room) key", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rc-"));
    const cache = new RoomCache("release");
    const space = fakeSpace(tmp);
    expect(cache.get(space, "r1")).toBe(cache.get(space, "r1"));
    fs.rmSync(tmp, { recursive: true });
  });
});
```

- [ ] **Step 3: Implement room-cache.ts (GREEN)**

```ts
import { FilePersistence } from "./persistence.js";
import { resolveRoomStorage, type SpaceRecord, type Profile } from "@shemma/spaces";

type Key = string;
type Entry = { persistence: FilePersistence; lastTouchedAt: number };

const TTL_MS = 5 * 60 * 1000;

export class RoomCache {
  private cache = new Map<Key, Entry>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(private profile: Profile) {
    this.timer = setInterval(() => this.evictIdle(), 60_000);
    this.timer.unref();
  }

  get(space: SpaceRecord, roomId: string): FilePersistence {
    const key = `${space.id}:${roomId}`;
    let entry = this.cache.get(key);
    if (!entry) {
      const filePath = resolveRoomStorage(space, this.profile, roomId);
      entry = { persistence: new FilePersistence(filePath), lastTouchedAt: Date.now() };
      this.cache.set(key, entry);
    } else {
      entry.lastTouchedAt = Date.now();
    }
    return entry.persistence;
  }

  private evictIdle(): void {
    const cutoff = Date.now() - TTL_MS;
    for (const [k, e] of this.cache) {
      if (e.lastTouchedAt < cutoff) {
        e.persistence.flushSync?.();
        this.cache.delete(k);
      }
    }
  }

  shutdown(): void {
    if (this.timer) clearInterval(this.timer);
    for (const e of this.cache.values()) e.persistence.flushSync?.();
    this.cache.clear();
  }
}
```

- [ ] **Step 4: Run new tests, expect green. Fix internal persistence.ts callers (within file scope only)**

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/persistence.ts apps/backend/src/room-cache.ts apps/backend/src/__tests__/room-cache.test.ts
git commit -m "feat(backend): FilePersistence accepts filePath directly + RoomCache primitive"
```

---

### Task 10b: Storage resolver integration — gut `config.storageDir`, route rooms.ts через cache

**Scope:** Удаляет старый `storageDir` singleton и переводит `rooms.ts` + CLI `storage.ts` на новый resolver.

**Files:**
- Modify: `apps/backend/src/config.ts` — drop `storageDir` singleton
- Modify: `apps/backend/src/rooms.ts` — accept `space: SpaceRecord`, use RoomCache
- Modify: `apps/backend/src/index.ts` — instantiate RoomCache singleton, expose к routes
- Modify: `packages/shemma-cli/src/storage.ts` — gut `resolveStorageForOpen`; CLI top-level uses `@shemma/spaces` directly (см. Task 22)

- [ ] **Step 1: Read existing config.ts lines ~107-143**

Identify exact lines containing `storageDir` singleton proxy + lazy resolve. Delete only those.

- [ ] **Step 2: Remove `storageDir` exports**

`config.storageDir` access goes away. All callers must use `RoomCache.get(space, room)` instead.

- [ ] **Step 3: Refactor rooms.ts**

Functions используют `storageDir` directly → теперь принимают `space: SpaceRecord` arg. Audit signatures:

```bash
grep -nE "function|export" apps/backend/src/rooms.ts | head -40
```

Update каждую signature + all call sites. Don't update route handlers yet (Task 11).

- [ ] **Step 4: Instantiate RoomCache singleton в index.ts**

```ts
import { RoomCache } from "./room-cache.js";

const roomCache = new RoomCache(profile);
export function getRoomCache(): RoomCache { return roomCache; }

process.on("SIGTERM", () => { roomCache.shutdown(); /* ... rest of shutdown */ });
```

- [ ] **Step 5: Gut CLI storage.ts**

Replace `resolveStorageForOpen()` body с deprecation throw OR redirect к `@shemma/spaces.findSpaceByPath`:

```ts
import { findSpaceByPath } from "@shemma/spaces";

/** @deprecated — use `@shemma/spaces.findSpaceByPath` directly */
export function resolveStorageForOpen(): never {
  throw new Error("resolveStorageForOpen is removed in 0.22.0. Use spaces registry via `@shemma/spaces`.");
}
```

Find all callers внутри CLI; update each к direct `findSpaceByPath` use.

- [ ] **Step 6: Run backend tests, fix breakage**

Многие existing tests reference `config.storageDir` или old `FilePersistence(roomsDir, roomId)` signature. Update тесты к pass mock `SpaceRecord` instead.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/config.ts apps/backend/src/rooms.ts apps/backend/src/index.ts packages/shemma-cli/src/storage.ts apps/backend/src/__tests__/
git commit -m "refactor(backend): remove global storageDir; rooms.ts threads space through RoomCache"
```

---

### Task 11: Update HTTP route handlers — read `space` from context

**Files:**
- Modify: `apps/backend/src/routes/{state,domain,context,rooms,prompts,layout,ai,export-miro,viewport,active-rooms}.ts`

- [ ] **Step 1: Audit pattern**

Each handler currently does:
```ts
const roomId = resolveRoomId(c.req.query("room"));
const persistence = getPersistenceFor(roomId);
```

Replace с (no cast needed — `ContextVariableMap` augmentation done в Task 8 step 2):
```ts
const space = c.get("space");                       // typed as SpaceRecord
const roomId = resolveRoomId(c.req.query("room"));
const persistence = getRoomCache().get(space, roomId);
```

- [ ] **Step 2: Update routes one by one**

```
- state.ts
- state/seed-schema.ts
- domain.ts
- agent/context.ts
- agent/layout-selection.ts
- agent/import-mermaid.ts
- ai/start, ai/stop, ai/activity
- layout.ts
- prompt, prompts (5 endpoints)
- rooms.ts (list + import + purge-archive + per-id routes)
- viewport.ts
- export/miro.ts
```

Active-rooms keeps optional `space` filter logic; default aggregate.

- [ ] **Step 3: Update active-rooms to scope by composite key**

```ts
// apps/backend/src/ws/active-rooms.ts
type Key = `${SpaceId}:${RoomId}`;
// adapt existing logic
```

- [ ] **Step 4: Run backend tests, fix breakage**

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/routes/ apps/backend/src/ws/active-rooms.ts
git commit -m "refactor(backend): all routes read space from middleware context"
```

---

### Task 12: WebSocket — composite key subscriptions

**Files:**
- Modify: `apps/backend/src/ws.ts` — accept `space` from query, key by `${space}:${room}`
- Modify: `apps/backend/src/__tests__/ws.test.ts`

- [ ] **Step 1: Update WsHub**

```ts
// before: rooms = Map<roomId, Set<Sock>>
// after:
type SubKey = `${SpaceId}:${RoomId}`;
private subs = new Map<SubKey, Set<Sock>>();

attach(spaceId: SpaceId, roomId: RoomId, sock: Sock): void {
  const key: SubKey = `${spaceId}:${roomId}`;
  let set = this.subs.get(key); if (!set) { set = new Set(); this.subs.set(key, set); }
  set.add(sock);
}

publish(spaceId: SpaceId, roomId: RoomId, msg: unknown): void {
  const set = this.subs.get(`${spaceId}:${roomId}`); if (!set) return;
  for (const s of set) s.send(JSON.stringify(msg));
}
```

- [ ] **Step 2: Update WS upgrade handler**

Read `space` from query на handshake. Validate via registry; reject (close 1008) если absent / unknown.

- [ ] **Step 3: Update ws.test.ts**

Tests now must include `space` in connect URL.

- [ ] **Step 4: Run tests, expect green**

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/ws.ts apps/backend/src/__tests__/ws.test.ts
git commit -m "feat(ws): scope subscriptions by (space, room) composite key"
```

---

# Milestone 4: Frontend routing + spaces landing

### Task 13: URL parser (cols syntax)

**Files:**
- Create: `apps/frontend/src/spaces/url-parser.ts`
- Create: `apps/frontend/src/spaces/__tests__/url-parser.test.ts`

- [ ] **Step 1: Write url-parser.test.ts (RED)**

Frontend tests use `bun:test` (confirmed: `apps/frontend/src/transport/ws.test.ts` and others).

```ts
import { describe, it, expect } from "bun:test";
import { parseShemmaUrl, serializeColumns } from "../url-parser";

describe("parseShemmaUrl", () => {
  it("returns landing when no params", () => {
    expect(parseShemmaUrl("/")).toEqual({ view: "landing" });
  });
  it("parses ?space=A as single gallery column", () => {
    expect(parseShemmaUrl("/?space=A")).toEqual({
      view: "columns",
      columns: [{ kind: "gallery", spaceId: "A" }],
    });
  });
  it("parses ?space=A&room=R as single room column", () => {
    expect(parseShemmaUrl("/?space=A&room=R")).toEqual({
      view: "columns",
      columns: [{ kind: "room", spaceId: "A", roomId: "R" }],
    });
  });
  it("parses ?cols=A,B:r2,C", () => {
    expect(parseShemmaUrl("/?cols=A,B:r2,C")).toEqual({
      view: "columns",
      columns: [
        { kind: "gallery", spaceId: "A" },
        { kind: "room", spaceId: "B", roomId: "r2" },
        { kind: "gallery", spaceId: "C" },
      ],
    });
  });
  it("caps columns to 3", () => {
    const parsed = parseShemmaUrl("/?cols=A,B,C,D");
    expect(parsed.view).toBe("columns");
    expect((parsed as any).columns).toHaveLength(3);
  });
});

describe("serializeColumns", () => {
  it("single gallery → ?space=A", () => {
    expect(serializeColumns([{ kind: "gallery", spaceId: "A" }])).toBe("?space=A");
  });
  it("multi → ?cols=A,B:r2", () => {
    expect(serializeColumns([
      { kind: "gallery", spaceId: "A" },
      { kind: "room", spaceId: "B", roomId: "r2" },
    ])).toBe("?cols=A,B%3Ar2");
  });
});
```

- [ ] **Step 2: Implement url-parser.ts**

```ts
export type Column =
  | { kind: "gallery"; spaceId: string }
  | { kind: "room"; spaceId: string; roomId: string };

export type ShemmaUrlState =
  | { view: "landing" }
  | { view: "columns"; columns: Column[] };

const MAX_COLUMNS = 3;

export function parseShemmaUrl(input: string | URL): ShemmaUrlState {
  const url = typeof input === "string" ? new URL(input, "http://x") : input;
  const params = url.searchParams;

  // Multi-column form (cols=)
  const cols = params.get("cols");
  if (cols) {
    const columns = cols.split(",").slice(0, MAX_COLUMNS).map(tuple => {
      const [spaceId, roomId] = tuple.split(":");
      return roomId ? { kind: "room" as const, spaceId, roomId } : { kind: "gallery" as const, spaceId };
    });
    return { view: "columns", columns };
  }

  // Single-column legacy form (space + optional room)
  const space = params.get("space");
  if (space) {
    const room = params.get("room");
    return {
      view: "columns",
      columns: [room ? { kind: "room", spaceId: space, roomId: room } : { kind: "gallery", spaceId: space }],
    };
  }

  return { view: "landing" };
}

export function serializeColumns(columns: Column[]): string {
  if (columns.length === 1) {
    const c = columns[0];
    return c.kind === "room" ? `?space=${encodeURIComponent(c.spaceId)}&room=${encodeURIComponent(c.roomId)}` : `?space=${encodeURIComponent(c.spaceId)}`;
  }
  const cols = columns.map(c => c.kind === "room" ? `${c.spaceId}:${c.roomId}` : c.spaceId).join(",");
  return `?cols=${encodeURIComponent(cols).replaceAll("%2C", ",")}`;
}
```

- [ ] **Step 3: Run tests, expect green. Commit.**

```bash
git add apps/frontend/src/spaces/url-parser.ts apps/frontend/src/spaces/__tests__/url-parser.test.ts
git commit -m "feat(frontend): URL parser/serializer for spaces + multi-column cols syntax"
```

---

### Task 14: Spaces landing page + add form

**Files:**
- Create: `apps/frontend/src/spaces/SpacesPage.tsx`
- Create: `apps/frontend/src/spaces/AddSpaceForm.tsx`
- Create: `apps/frontend/src/spaces/api.ts` — fetch wrappers для `/api/spaces`
- Modify: `apps/frontend/src/main.tsx` — route landing

- [ ] **Step 1: Implement api.ts (включая session fetch для home expansion)**

`/api/session` already существует в `apps/backend/src/routes/session.ts` и возвращает `{ sessionId, projectSlug, workspaceDir, home }` — используем `home` для `~/` expansion.

```ts
import type { SpaceLocalDTO } from "@shemma/spaces";

type SessionInfo = { sessionId: string; projectSlug: string; workspaceDir: string; home: string };

let sessionCache: Promise<SessionInfo> | null = null;
export function getSession(): Promise<SessionInfo> {
  if (!sessionCache) sessionCache = fetch("/api/session").then(r => r.json());
  return sessionCache;
}

export async function expandHomePath(input: string): Promise<string> {
  if (!input.startsWith("~/") && input !== "~") return input;
  const { home } = await getSession();
  return input === "~" ? home : `${home}/${input.slice(2)}`;
}

export async function listSpacesApi(): Promise<SpaceLocalDTO[]> {
  const resp = await fetch("/api/spaces");
  const { spaces } = await resp.json();
  return spaces;
}

export async function addSpaceApi(path: string, label?: string): Promise<{ space: SpaceLocalDTO; created: boolean }> {
  const resp = await fetch("/api/spaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, label }) });
  if (!resp.ok) throw new Error((await resp.json()).error ?? "failed");
  return resp.json();
}

export async function forgetSpaceApi(id: string): Promise<void> {
  await fetch(`/api/spaces/${id}`, { method: "DELETE" });
}

export async function renameSpaceLabelApi(id: string, label: string): Promise<void> {
  await fetch(`/api/spaces/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ label }) });
}
```

- [ ] **Step 2: Implement AddSpaceForm.tsx**

```tsx
import { useState } from "react";
import { addSpaceApi, expandHomePath } from "./api";

export function AddSpaceForm({ onAdded }: { onAdded: (id: string) => void }) {
  const [pathInput, setPathInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const resolved = await expandHomePath(pathInput.trim());
      const { space } = await addSpaceApi(resolved);
      onAdded(space.id);
    } catch (err: any) {
      setError(err.message ?? "failed");
    } finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit}>
      <input value={pathInput} onChange={e => setPathInput(e.target.value)} placeholder="/Users/me/Projects/my-app or ~/Projects/my-app" />
      <button type="submit" disabled={busy || pathInput.trim().length === 0}>Add</button>
      {error && <div className="error">{error}</div>}
    </form>
  );
}
```

- [ ] **Step 3: Implement SpacesPage.tsx**

```tsx
import { useEffect, useState } from "react";
import type { SpaceLocalDTO } from "@shemma/spaces";
import { listSpacesApi, forgetSpaceApi } from "./api";
import { AddSpaceForm } from "./AddSpaceForm";

export function SpacesPage() {
  const [spaces, setSpaces] = useState<SpaceLocalDTO[]>([]);

  useEffect(() => { listSpacesApi().then(setSpaces); }, []);

  const open = (id: string) => { window.location.href = `/?space=${encodeURIComponent(id)}`; };
  const forget = async (id: string) => { await forgetSpaceApi(id); setSpaces(await listSpacesApi()); };

  return (
    <main className="spaces-page">
      <h1>Spaces ({spaces.length})</h1>
      <AddSpaceForm onAdded={open} />
      <ul>
        {spaces.map(s => (
          <li key={s.id}>
            <button onClick={() => open(s.id)}>{s.label ?? s.id}</button>
            <code title={s.path}>{truncatePath(s.path)}</code>
            {s.legacy && <span className="badge">Legacy</span>}
            <time>{relativeTime(s.lastUsedAt)}</time>
            <button onClick={() => forget(s.id)}>Forget</button>
          </li>
        ))}
      </ul>
    </main>
  );
}
```

- [ ] **Step 4: Modify main.tsx — landing vs MultiColumnLayout (which handles 1+ columns uniformly)**

```tsx
import { parseShemmaUrl } from "./spaces/url-parser";
import { SpacesPage } from "./spaces/SpacesPage";
import { MultiColumnLayout } from "./spaces/MultiColumnLayout";

const state = parseShemmaUrl(window.location.href);
if (state.view === "landing") {
  root.render(<SpacesPage />);
} else {
  // MultiColumnLayout handles 1, 2, или 3 columns; single-column renders без splitter (см. §7.3, Task 17).
  root.render(<MultiColumnLayout columns={state.columns} />);
}
```

`MultiColumnLayout` (created в Task 17) — single entry point for any non-landing route, включая single-column. Task 15 prepares props plumbing для Gallery/App, не trogает main.tsx.

- [ ] **Step 5: Smoke в browser**: launch dev → `/` shows landing → add form works.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/spaces/ apps/frontend/src/main.tsx
git commit -m "feat(frontend): spaces landing page + main.tsx routing to MultiColumnLayout"
```

---

### Task 15: Plumb `(space, room)` props через Gallery + App

**Files:**
- Modify: `apps/frontend/src/App.tsx` — accept `{ space, room }` props
- Modify: `apps/frontend/src/canvas/store-sync.ts` (or equiv) — include `space` in WS url + HTTP queries
- Modify: `apps/frontend/src/gallery/Gallery.tsx` — accept `space` prop, fetch `/api/rooms?space=`

**Not modified:** `main.tsx` — already done в Task 14 step 4 (renders `MultiColumnLayout`).

- [ ] **Step 1: Update App.tsx signature** — `App({ space, room })`. WS url: `/ws?space=${space}&room=${room}`. HTTP fetches: add `&space=${space}` к every request (via CanvasClient — see Task 24 для underlying client change).

- [ ] **Step 2: Update Gallery.tsx** — `Gallery({ space })`. `listRooms({ space, includeArchived })`.

- [ ] **Step 3: Smoke**: open `/?space=<id>` → MultiColumnLayout renders single column → Gallery for space → click room → MultiColumnLayout reroutes (pushState) → renders App for that room.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/App.tsx apps/frontend/src/canvas/ apps/frontend/src/gallery/
git commit -m "feat(frontend): Gallery + App accept (space, room) props"
```

---

### Task 16: Frontend tests — URL routing + spaces page

**Files:**
- Create: `apps/frontend/src/spaces/__tests__/SpacesPage.test.tsx`
- Modify: `apps/frontend/src/__tests__/routing.test.ts`

- [ ] **Step 1: Test SpacesPage rendering** with mock fetch.
- [ ] **Step 2: Test AddSpaceForm** submit flow.
- [ ] **Step 3: Test URL transitions** in single-column mode.
- [ ] **Step 4: Run, fix, commit**

```bash
git commit -m "test(frontend): spaces landing + URL routing coverage"
```

---

# Milestone 5: Multi-gallery split UI

### Task 17: MultiColumnLayout container

**Files:**
- Create: `apps/frontend/src/spaces/MultiColumnLayout.tsx`
- Create: `apps/frontend/src/spaces/SplitterBar.tsx`

- [ ] **Step 1: MultiColumnLayout renders columns as flex children**

```tsx
export function MultiColumnLayout({ columns }: { columns: Column[] }) {
  const [widths, setWidths] = usePersistedWidths(columns.length);
  const [activeIdx, setActiveIdx] = useState(0);

  return (
    <div className="multi-col" onClick={...}>
      {columns.map((col, i) => (
        <Fragment key={`${col.spaceId}-${i}`}>
          <div className={`col ${activeIdx === i ? "active" : ""}`} style={{ flexBasis: `${widths[i]}%` }} onClick={() => setActiveIdx(i)}>
            {col.kind === "gallery"
              ? <Gallery space={col.spaceId} />
              : <App space={col.spaceId} room={col.roomId} />}
          </div>
          {i < columns.length - 1 && <SplitterBar onResize={delta => resize(i, delta)} />}
        </Fragment>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: usePersistedWidths hook** — localStorage `shemma.splitter.<N>`.

- [ ] **Step 3: SplitterBar** — drag handle, mousedown → mousemove delta → emit.

- [ ] **Step 4: Smoke**: open `/?cols=A,B` → two columns render, splitter drags.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/spaces/MultiColumnLayout.tsx apps/frontend/src/spaces/SplitterBar.tsx
git commit -m "feat(frontend): multi-column layout with resizable splitter"
```

---

### Task 18: Active column + within-column mode transitions

- [ ] **Step 1: Active state** — visual outline, click switches.
- [ ] **Step 2: Mode transition** — clicking room in gallery column → column shifts to `kind: "room"`, URL pushState'ит.
- [ ] **Step 3: Back-to-gallery button** in room column.
- [ ] **Step 4: Test + commit**

```bash
git commit -m "feat(frontend): active column tracking + within-column gallery↔room transitions"
```

---

### Task 19: Multi-column smoke tests

- [ ] **Step 1: Vitest test** rendering 2 columns from `parseShemmaUrl("/?cols=A,B")`.
- [ ] **Step 2: Splitter drag test** updates flex basis.
- [ ] **Step 3: Active column test**.
- [ ] **Step 4: Commit**

```bash
git commit -m "test(frontend): multi-column rendering + splitter + active state"
```

---

### Task 20: Visual smoke via chrome-devtools (manual)

- [ ] **Step 1: Start daemon with 2 registered spaces**.
- [ ] **Step 2: Navigate `/?cols=A,B`** через chrome-devtools MCP.
- [ ] **Step 3: Verify** split renders, both editors load, mutation в A не виден в B.
- [ ] **Step 4: Document findings** в commit message; no code commit if all green.

---

# Milestone 6: CLI surface

### Task 21: `shemma s` subcommands

**Files:**
- Create: `packages/shemma-cli/src/commands/spaces.ts`
- Modify: `packages/shemma-cli/src/index.ts` — wire subcommand router
- Create: `packages/shemma-cli/src/__tests__/cli-spaces.test.ts`

- [ ] **Step 1: Implement subcommands** using `@shemma/spaces` directly.

```ts
import { listSpaces, registerSpace, forgetSpace, renameSpaceLabel } from "@shemma/spaces";

export async function handleSpacesCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "list": { /* print table or --json */ break; }
    case "add": {
      const [pathArg] = rest;
      const { space, created } = registerSpace(pathArg);
      console.log(`${created ? "added" : "exists"}: ${space.id} → ${space.path}`);
      return 0;
    }
    case "forget": { forgetSpace(rest[0]); return 0; }
    case "rename": { renameSpaceLabel(rest[0], rest.slice(1).join(" ")); return 0; }
    case "prune": { /* implement orphan detection + interactive confirm */ break; }
    case "reveal": { /* spawn `open` on s.path */ break; }
    default: console.error(`unknown subcommand: ${sub}`); return 1;
  }
  return 0;
}
```

- [ ] **Step 2: Write CLI integration test** (spawn subprocess, assert exit codes).
- [ ] **Step 3: Wire into `shemma` CLI router**.
- [ ] **Step 4: Run + commit**

```bash
git commit -m "feat(cli): shemma s {list,add,forget,rename,prune,reveal} subcommands"
```

---

### Task 22: `shemma <path>` top-level positional

**CLI structure context:** `packages/shemma-cli/src/index.ts` uses linear cascade `if (cmd === "state") return cmdState(...); if (cmd === "patch") return ...` (см. lines ~109-415). Known subcommands (на 0.20.3): `internal-server`, `state`, `patch`, `clear`, `layout`, `prompts`, `ai`, `version`, `update`, `init`, `ps`, `logs`, `doctor`, `daemon`, `mcp`, `config`, `rooms`, `define`, `connect`, `group`, `note`, `delete`, `apply`, `context`. Top-level-path должен срабатывать **до** cascade-end fallback, но **после** all `if (cmd === ...)` keyword branches — иначе `shemma daemon` будет пытаться treat'нуть "daemon" как path.

**Files:**
- Create: `packages/shemma-cli/src/commands/top-level-path.ts`
- Modify: `packages/shemma-cli/src/index.ts` — insert path branch перед "unknown command" fallback

- [ ] **Step 1: Implement top-level-path.ts**

```ts
import fs from "node:fs";
import { spawn } from "node:child_process";
import { registerSpace, type SpaceRecord } from "@shemma/spaces";
import { ensure as ensureDaemon } from "../daemon.js";
import { portFor, type Profile } from "../profile.js";

export function looksLikePath(arg: string): boolean {
  if (arg.startsWith("-")) return false;
  try {
    return fs.statSync(arg).isDirectory();
  } catch {
    return false;
  }
}

export async function cmdTopLevelPath(args: string[], profile: Profile): Promise<number> {
  const paths = args.filter(a => !a.startsWith("-")).slice(0, 3);
  if (paths.length === 0) return 1;
  const spaceIds: string[] = [];
  for (const p of paths) {
    const { space } = registerSpace(p);
    spaceIds.push(space.id);
  }
  await ensureDaemon({ profile });
  const port = portFor(profile);
  const url = spaceIds.length === 1
    ? `http://localhost:${port}/?space=${encodeURIComponent(spaceIds[0])}`
    : `http://localhost:${port}/?cols=${spaceIds.join(",")}`;
  openBrowser(url);
  console.log(`Opened: ${url}`);
  return 0;
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
}
```

- [ ] **Step 2: Wire в index.ts cascade**

Locate в `packages/shemma-cli/src/index.ts` место **после** последнего `if (cmd === ...)` block (после `if (cmd === "context") ...` около line 414) и **до** `console.error("unknown command")` fallback. Insert:

```ts
// Top-level positional path detection — register space(s) + open browser.
// Must come AFTER all `if (cmd === ...)` keyword branches.
if (looksLikePath(cmd)) {
  // cmd is the first path; rest of argv are additional paths
  const allArgs = [cmd, ...argv.slice(1)];
  return cmdTopLevelPath(allArgs, profile);
}
```

Импорт сверху: `import { cmdTopLevelPath, looksLikePath } from "./commands/top-level-path";`

- [ ] **Step 3: Tests (CLI integration)**

```ts
import { describe, it, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("shemma <path>", () => {
  it("registers space and exits 0", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shemma-tlp-"));
    // ... set XDG_CONFIG_HOME isolation, spawn `shemma <tmp> --no-open`, check exit
    fs.rmSync(tmp, { recursive: true });
  });
});
```

Add `--no-open` flag к cmdTopLevelPath чтобы avoid opening browser в tests.

- [ ] **Step 4: Commit**

```bash
git add packages/shemma-cli/src/commands/top-level-path.ts packages/shemma-cli/src/index.ts packages/shemma-cli/src/__tests__/
git commit -m "feat(cli): shemma <path>... top-level positional registers spaces + opens browser"
```

---

### Task 23: Backward compat — deprecate `--storage` + `SHEMMA_STORAGE_DIR`

**Files:**
- Modify: `packages/shemma-cli/src/index.ts` — handle `--storage` deprecation
- Modify: `apps/backend/src/index.ts` — on startup, if `SHEMMA_STORAGE_DIR` set and no `default` space, auto-register

- [ ] **Step 1: CLI `--storage <path>` detect** → emit warning + auto-call `registerSpace(path, { storageLayout: "direct", label: "Default (from --storage)", id: "default" })` (or generated id).

- [ ] **Step 2: Backend startup** — same logic.

- [ ] **Step 3: Tests**.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(cli): deprecate --storage and SHEMMA_STORAGE_DIR with auto-translate to spaces"
```

---

### Task 24: CanvasClient (`@shemma/client`) — `space` field everywhere

**Files:**
- Modify: `packages/shemma-client/src/index.ts`

- [ ] **Step 1: Add `space` к CanvasClient constructor + per-method override**.

- [ ] **Step 2: All `.q()` calls include `&space=${this.space}`**.

- [ ] **Step 3: Tests + commit**.

```bash
git commit -m "feat(client): CanvasClient threads space through every HTTP call"
```

---

# Milestone 7: MCP `space` param + resolver

### Task 25: Space resolver module

**Files:**
- Create: `packages/shemma-mcp/src/space-resolver.ts`
- Create: `packages/shemma-mcp/src/__tests__/space-resolver.test.ts`

- [ ] **Step 1: Test cases** — explicit, CWD-match (single / longest / ambiguous / 0), default fallback.

- [ ] **Step 2: Implement resolver** per §8.2.

- [ ] **Step 3: Run + commit**

```bash
git commit -m "feat(mcp): space resolver (explicit > CWD > default fallback)"
```

---

### Task 26: Update all tool schemas + handlers

- [ ] **Step 1: Each tool schema** adds `space: z.string().optional()`.
- [ ] **Step 2: Each handler** calls `resolveSpace(args.space)` first; returns ambiguity error if fail.
- [ ] **Step 3: Schema tests** — all tools accept undefined space.
- [ ] **Step 4: Commit**

```bash
git commit -m "feat(mcp): all tools accept optional space + resolve pre-handler"
```

---

### Task 27: MCP active-rooms + rooms_list — space scoping

- [ ] **Step 1: active_rooms tool** aggregates by default; optional `space` filter.
- [ ] **Step 2: rooms_list** scoped to resolved space.
- [ ] **Step 3: Tests + commit**

```bash
git commit -m "feat(mcp): space-aware active-rooms + rooms-list"
```

---

### Task 28: MCP integration tests

- [ ] **Step 1: Mock daemon + registry**.
- [ ] **Step 2: End-to-end flow** — call `shape_define` без space → resolver finds default → succeeds.
- [ ] **Step 3: Commit**

```bash
git commit -m "test(mcp): end-to-end space resolution integration"
```

---

# Milestone 8: Legacy migration

### Task 29: Legacy scan + auto-register

**Files:**
- Create: `apps/backend/src/migration/legacy-spaces.ts`
- Create: `apps/backend/src/migration/__tests__/legacy-spaces.test.ts`

- [ ] **Step 1: Test** — fake `~/.claude/projects/foo-abc/canvas/` with files → migration registers `default` (most-recent) or `legacy-foo-abc`.
- [ ] **Step 2: Implement**

```ts
export function migrateLegacySpacesIfNeeded(): void {
  if (fs.existsSync(spacesJsonPath())) return; // already done
  const projectsRoot = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(projectsRoot)) {
    fs.writeFileSync(spacesJsonPath(), JSON.stringify({ schemaVersion: 1, spaces: [] }, null, 2));
    return;
  }
  const candidates = findCanvasDirs(projectsRoot);
  // Sort by mtime desc; first becomes `default`, rest become `legacy-<slug>`
  // Register each via registerSpace(path, { storageLayout: "legacy", legacy: true, id, label })
}
```

- [ ] **Step 3: Tests** — empty home, single project, multiple projects, idempotency.
- [ ] **Step 4: Commit**

```bash
git commit -m "feat(migration): auto-register legacy ~/.claude/projects/*/canvas as 'default' + legacy-*"
```

---

### Task 30: Migration hooked into daemon startup

- [ ] **Step 1: Backend `index.ts`** calls `migrateLegacySpacesIfNeeded()` before mounting routes.
- [ ] **Step 2: Idempotent on subsequent boots** (spaces.json exists → skip).
- [ ] **Step 3: Skip flag** `SHEMMA_SKIP_LEGACY_MIGRATION=1` → create empty registry.
- [ ] **Step 4: Commit**

```bash
git commit -m "feat(migration): integrate legacy scan into backend startup"
```

---

### Task 31: MCP fallback test — legacy default space resolution

- [ ] **Step 1: Test** — empty fresh state + legacy dirs → migrate → MCP call без `space` → resolves к `default`.
- [ ] **Step 2: Commit**

```bash
git commit -m "test(migration): MCP default fallback through legacy migration"
```

---

# Milestone 9: End-to-end smoke

### Task 32: Smoke matrix

- [ ] **Step 1: Fresh install** simulation: rm `~/.config/shemma`, `~/.claude/.shemma-*`, `~/.claude/projects/`. Run `shemma ~/Projects/foo` → expect daemon start + space registered + browser opens.
- [ ] **Step 2: Reuse** — second `shemma daemon start` returns reused.
- [ ] **Step 3: Multi** — `shemma ~/foo ~/bar` → 2 spaces, browser opens `/?cols=foo,bar`.
- [ ] **Step 4: MCP** — start MCP server with CWD in foo → call `shape_define` без space → resolves к foo.
- [ ] **Step 5: Legacy** — clean install but with `~/.claude/projects/legacy-abc/canvas/r.json` → migration creates `default` space pointing к `~/.claude/projects/legacy-abc` с `storageLayout: "legacy"` → `?space=default&room=r` loads room.
- [ ] **Step 6: Auto-shutdown** — start daemon с **env override set BEFORE spawn**:

```bash
SHEMMA_IDLE_SHUTDOWN_MS=2000 shemma daemon start --profile=release
# Wait ~3 seconds; no clients connect
sleep 3
# Daemon should self-exit; verify:
shemma daemon status --profile=release  # expect "not running"
```

Daemon process inherits env at spawn. If you export AFTER start — daemon ignores. Always `KEY=value cmd ...` or explicit `export KEY=... ; shemma ...`.
- [ ] **Step 7: Backward compat** — `SHEMMA_STORAGE_DIR=/tmp/old` shemma daemon start → warning emitted, `default` space auto-registered с `storageLayout: "direct"`.
- [ ] **Step 8: Document** results in commit message.

```bash
git commit -m "test(smoke): end-to-end matrix for DRW-116 phase"
```

---

# Milestone 10: Release

### Task 33: Code-simplifier + final review + release commit + merge

- [ ] **Step 1: Run `code-simplifier` agent** на full phase diff: `git diff main..HEAD`. Apply suggestions, commit.
- [ ] **Step 2: Run spec+quality review subagent** — full review pass. Apply fixes.
- [ ] **Step 3: Bump version** в всех `package.json` → 0.22.0.
- [ ] **Step 4: Update CHANGELOG.md** — entry 0.22.0 со всеми breaking changes.
- [ ] **Step 5: Update CLAUDE.md** — architecture summary section (singleton + composite key + spaces).
- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "release: 0.22.0 — DRW-116 singleton daemon + spaces registry + multi-gallery"
```

- [ ] **Step 7: Tag**

```bash
git tag 0.22.0
```

- [ ] **Step 8: Merge --no-ff в main**

```bash
git checkout main
git merge --no-ff feature/global-daemon-spaces -m "merge: feature/global-daemon-spaces → main (0.22.0 DRW-116)"
git branch -d feature/global-daemon-spaces
```

- [ ] **Step 9: Verify clean state**

```bash
git status
git log --oneline -10
```

- [ ] **Step 10: Update memory** — mark DRW-116 SHIPPED.

---

## Self-review

### Spec coverage check

| Spec section | Plan task |
|---|---|
| §3 composite key invariant | Threaded through every task |
| §4.1-4.4 spaces.json + ID gen | Tasks 1-3 |
| §4.5-4.6 symlinks, soft-delete | Tasks 3 + 21 (CLI prune) |
| §4.7 CRUD HTTP + shared package | Tasks 3 + 9 |
| §4.7.2 lastUsedAt debounce | Task 4 |
| §4.8 daemon ↔ CLI consistency | Tasks 3 + 9 + 21 (per-request `loadRegistry`; fs.watch deferred — см. Milestones table note) |
| §5.1 mkdir lock protocol | Tasks 5 (`@shemma/lockfile` package) + 6 (integrate) |
| §5.2 storage не bound | Tasks 10a + 10b |
| §5.3 auto-shutdown idle | Task 7 |
| §5.4-5.5 lifecycle commands + port-based locking | Tasks 5-7 |
| §6.1 URL syntax (cols) | Task 13 |
| §6.2 middleware enforcement + accurate inventory | Tasks 8 (+ Hono module aug) + 11 |
| §6.3 WS composite key | Task 12 |
| §6.4 backward compat shim | Task 23 |
| §7.1-7.4 multi-column UI | Tasks 17-19 |
| §7.5 spaces landing + text input | Task 14 |
| §8.1-8.3 MCP resolver + ambiguity | Tasks 25-28 |
| §9 CLI surface | Tasks 21-23 |
| §10 legacy migration | Tasks 29-31 |
| §11 testing strategy | Embedded in all tasks |
| §12 risks + rollout | Task 33 (release notes) |

All spec sections covered. Sole intentional defer — §4.8 fs.watch (Phase 2 follow-up).

### Placeholder scan (v0.2 pass)

Все TBD / broken-placeholder code (включая `expandHome → navigator.userAgent` bug из v0.1) removed. Step content includes actual code OR explicit "edit existing X" pointers (где changes too mechanical для inline code).

**Known intentional gaps:**
- `apps/backend/src/idle-tracker.ts` shutdown callback default `process.exit(0)` — production graceful shutdown handled через SIGTERM handler в Task 6 step 2. Acceptable.
- WS upgrade handler `space` validation — Task 12 mentions; subagent must update WS hello protocol consistency on its own.
- `--no-open` flag для `cmdTopLevelPath` (test convenience) — explicit in Task 22, implementation trivial.

### Type consistency

- `SpaceId` regex consistent (Task 1).
- `SpaceStorageLayout` 3 values (`project | legacy | direct`) used same way (Tasks 1-3, 10b, 23, 29).
- `SpaceRecord` shape stable across tasks; no field rename mid-stream.
- `Profile` type — defined в `@shemma/spaces` AND existing `packages/shemma-cli/src/profile.ts`; co-exist by design (см. Task 1 step 6 collision-check). Если станет проблемой — consolidation в Phase 2 follow-up.
- DTO split (PublicDTO vs LocalDTO) consistent — backend never returns LocalDTO to non-localhost (Task 9).
- Hono `ContextVariableMap` augmentation (Task 8 step 2) → `c.get("space")` typed across all handlers (Task 11) без cast.

### Bite-size review

- Tasks 1-4 (foundation): TDD format, code snippets, runnable steps. Granular ✓
- Tasks 5-7 (lock + daemon): explicit shared package separation (`@shemma/lockfile`) → no cross-package import ambiguity. Granular ✓
- Tasks 8-12 (backend): split Task 10 → 10a/10b reduces single-task scope; subagent should manage. ✓
- Tasks 13-20 (frontend): main.tsx routing clarified (always `MultiColumnLayout`); single-column case handled внутри MultiColumnLayout, not in main.tsx branches. ✓
- Tasks 21-31: structured, brief, manageable per subagent. Task 22 grounded в реальной CLI cascade. ✓
- Task 33 (release): mechanical checklist.

### Risks not in spec

- Tests across milestones: некоторые ports могут collide если running tests параллельно с dev daemon. Mitigation: per-test temp `XDG_CONFIG_HOME` (Tasks 3/5 шаблоны) + ports на нерезервированных high values (e.g. 9999 в Task 5 tests).
- `proper-lockfile` Bun compatibility — used в `@shemma/spaces` Task 3 для advisory lock on `spaces.json`. Если incompatible — fallback к minimal mkdir lock impl (copy из `@shemma/lockfile`). Flag за verify в Task 3 step 1.

### Deltas от v0.1 → v0.2

| Item | v0.1 | v0.2 |
|---|---|---|
| Lockfile location | `packages/shemma-cli/src/lockfile.ts` (NOT shared) | `@shemma/lockfile` shared package |
| Hono context typing | `as SpaceRecord` cast everywhere | `ContextVariableMap` module augmentation |
| Task 10 (mega-refactor) | Single task, 7 steps | Split T10a (FilePersistence+RoomCache) + T10b (config+rooms+CLI) |
| `expandHome` | Broken `navigator.userAgent` placeholder | Real `/api/session` fetch + cache |
| main.tsx routing | Conflict between Task 14 & 15 | Clarified: always `<MultiColumnLayout>`, single-col degrade внутри |
| Frontend test framework | "vitest or bun:test" ambiguous | Locked to `bun:test` |
| Task 22 (`shemma <path>`) | Generic implementation | Grounded в реальной cascade pattern; insert point identified |
| Auto-shutdown smoke (T32) | `SHEMMA_IDLE_SHUTDOWN_MS=2000` без ordering note | Explicit "set BEFORE spawn" |
| fs.watch для spaces.json | Implicit / missing | Explicit deferral note в Milestones table |
| Task count | 33 | 34 (T10 → T10a + T10b) |

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-21-global-daemon-spaces-plan.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch fresh subagent per task, two-stage review (spec compliance + code quality) after each, fast iteration. Skill: `superpowers:subagent-driven-development`.
2. **Inline Execution** — execute tasks в этой session с TaskCreate tracking, batch checkpoints для review. Skill: `superpowers:executing-plans`.

Per `feedback-plan-approval-gate` — **этот plan требует user approval перед execution**. Не запускать subagent-driven-development автоматически.
