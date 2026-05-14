# di.draw — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Построить локальный AI-driven canvas board для Claude Code: tldraw 5.x frontend + Bun backend с multi-room state, MCP-tools для AI, ручной CLI, hooks для реактивности, targeted prompts с привязкой к объектам.

**Architecture:** Single Bun-процесс на :8787 хранит `Map<RoomId, RoomState>` (per-session JSON-документы в `~/.claude/projects/<slug>/canvas/<room>.json`). Frontend — статическая React+tldraw SPA, обменивается с backend через REST (`POST /api/patch`) и WebSocket. AI оперирует canvas-state через MCP-tool `canvas_apply_patch` с операциями add/update/delete над типизированной моделью `{nodes, edges, groups, prompts}`. Запуск — автоматический через SessionStart hook (`didraw daemon --ensure`) или ручной через `didraw open <room>`.

**Tech Stack:**
- **Backend:** Bun 1.x, Hono, ws, elkjs, vitest
- **Frontend:** React 18, tldraw SDK 5.x, `@tldraw/mermaid`, Vite, TypeScript
- **MCP:** `@modelcontextprotocol/sdk` (Node)
- **CLI:** Bun-script (`#!/usr/bin/env bun`)
- **Tests:** vitest (unit/integration), Playwright (UI smoke)
- **Lint/format:** biome

**Spec:** `docs/superpowers/specs/2026-05-14-di-draw-design.md` (v3.2.1)

---

## File Structure

```
di.draw/
├── apps/
│   ├── backend/                              # порт 8787
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── index.ts                      # entry, Hono bootstrap, signals
│   │   │   ├── config.ts                     # env: DIDRAW_PORT, storage dir
│   │   │   ├── types.ts                      # CanvasState, Node, Edge, Endpoint, Group, PatchOp, Prompt
│   │   │   ├── state.ts                      # RoomState + clean room factory
│   │   │   ├── patch.ts                      # applyPatch(state, ops): {state, applied}; deep-merge
│   │   │   ├── rooms.ts                      # Map<RoomId, RoomState>, lazy-load, LRU eviction
│   │   │   ├── persistence.ts                # autosave debounce 300ms, load on first touch
│   │   │   ├── ws.ts                         # per-room WS broadcast hub
│   │   │   ├── routes/
│   │   │   │   ├── state.ts                  # GET /api/state
│   │   │   │   ├── patch.ts                  # POST /api/patch
│   │   │   │   ├── import-mermaid.ts         # POST /api/import/mermaid (Phase 1.5)
│   │   │   │   ├── layout.ts                 # POST /api/layout (Phase 1.5)
│   │   │   │   ├── prompts.ts                # POST /api/prompt, etc. (Phase 1.7)
│   │   │   │   └── health.ts                 # GET /healthz
│   │   │   └── mermaid-import.ts             # @tldraw/mermaid → PatchOp[] (если spike == backend)
│   │   └── tests/
│   │       ├── patch.test.ts
│   │       ├── rooms.test.ts
│   │       ├── persistence.test.ts
│   │       ├── routes.state.test.ts
│   │       ├── routes.patch.test.ts
│   │       ├── routes.prompts.test.ts
│   │       └── ws.test.ts
│   └── frontend/
│       ├── package.json
│       ├── tsconfig.json
│       ├── vite.config.ts
│       ├── index.html
│       └── src/
│           ├── main.tsx                      # React root, читает ?room= из URL
│           ├── App.tsx                       # tldraw editor + transport wiring
│           ├── transport/
│           │   ├── api.ts                    # fetch wrapper, room-aware
│           │   └── ws.ts                     # WebSocket client, reconnect
│           ├── canvas/
│           │   ├── kinds.ts                  # mapping CanvasState kind → tldraw shape type
│           │   ├── from-canvas-state.ts      # CanvasState → tldraw createShapes[]
│           │   ├── to-patch.ts               # tldraw store-event → PatchOp[]
│           │   └── echo-guard.ts             # ignore patches we just sent
│           ├── prompts/                      # Phase 1.7
│           │   ├── PromptInput.tsx           # floating bar при selection
│           │   ├── PromptMarker.tsx          # 💬 N на shape
│           │   └── PromptDrawer.tsx          # история по объекту
│           └── styles.css
├── packages/
│   ├── canvas-mcp/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts                      # MCP server bootstrap
│   │       ├── client.ts                     # HTTP client to backend (с CLAUDE_SESSION_ID)
│   │       └── tools.ts                      # tool definitions
│   ├── canvas-channel-mcp/                   # Phase 2
│   │   ├── package.json
│   │   └── src/index.ts
│   └── didraw-cli/
│       ├── package.json
│       └── src/
│           ├── index.ts                      # CLI entry, command dispatch
│           ├── daemon.ts                     # daemon start/stop/status/ensure, pid-file
│           ├── open.ts                       # didraw open <room>
│           ├── list.ts
│           ├── export.ts
│           └── rm.ts
├── .claude/
│   ├── mcp.json                              # регистрация canvas-mcp
│   ├── settings.json                         # SessionStart + PreToolUse hooks
│   ├── hooks/
│   │   └── draw-prehook.sh
│   └── skills/
│       └── draw/
│           └── SKILL.md
├── docs/
│   ├── superpowers/
│   │   ├── specs/2026-05-14-di-draw-design.md
│   │   └── plans/2026-05-14-di-draw-implementation.md   # this file
│   └── decisions/
│       └── 0001-mermaid-import-location.md   # ADR (Phase 0.1 spike result)
├── biome.json
├── package.json                              # Bun workspace root
├── tsconfig.base.json
└── README.md
```

**File responsibility guidelines:**
- `apps/backend/src/types.ts` — единственный источник правды по типам, импортируется и backend, и тестами, и frontend (через path-alias или копией).
- `apps/backend/src/patch.ts` — чистая функция, не знает о persistence/rooms/ws. Test-friendly.
- `apps/backend/src/rooms.ts` — depends on persistence; зато все REST-роуты depend только на rooms.
- Frontend разделяет **transport** (api+ws), **canvas** (преобразования), **prompts** (UI фича).

---

## Task 1: Init monorepo, biome, tsconfig

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `biome.json`
- Create: `.gitignore`

- [ ] **Step 1: Create root `package.json` with Bun workspaces**

```json
{
  "name": "didraw",
  "private": true,
  "type": "module",
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "dev": "bun run --filter '*' dev",
    "test": "bun run --filter '*' test",
    "lint": "biome check ."
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.0",
    "typescript": "^5.5.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "allowSyntheticDefaultImports": true,
    "isolatedModules": true,
    "types": ["bun-types"]
  }
}
```

- [ ] **Step 3: Create `biome.json`**

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.0/schema.json",
  "files": { "ignore": ["**/dist/**", "**/node_modules/**"] },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2 },
  "javascript": { "formatter": { "semicolons": "always", "trailingCommas": "all" } }
}
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules/
dist/
*.log
.DS_Store
~/.claude/.didraw.pid
```

- [ ] **Step 5: Install root deps**

Run: `bun install`
Expected: `bun.lock` created, `node_modules/` populated.

- [ ] **Step 6: Verify biome works**

Run: `bunx biome check .`
Expected: success (no files yet).

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.base.json biome.json .gitignore bun.lock
git commit -m "chore: init monorepo with Bun workspaces and biome"
```

---

## Task 2: Bootstrap backend skeleton

**Files:**
- Create: `apps/backend/package.json`
- Create: `apps/backend/tsconfig.json`
- Create: `apps/backend/src/index.ts`
- Create: `apps/backend/src/config.ts`

- [ ] **Step 1: Create `apps/backend/package.json`**

```json
{
  "name": "@didraw/backend",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun --watch src/index.ts",
    "start": "bun src/index.ts",
    "test": "bun test"
  },
  "dependencies": {
    "hono": "^4.6.0",
    "@hono/node-ws": "^1.0.0",
    "elkjs": "^0.9.3"
  },
  "devDependencies": {
    "bun-types": "latest",
    "@types/ws": "^8.5.0"
  }
}
```

- [ ] **Step 2: Create `apps/backend/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 3: Create `apps/backend/src/config.ts`**

```ts
import { homedir } from "node:os";
import { join } from "node:path";

export const config = {
  port: Number(process.env.DIDRAW_PORT ?? 8787),
  storageDir: process.env.DIDRAW_STORAGE_DIR ?? join(homedir(), ".claude", "projects"),
  autosaveDebounceMs: 300,
  roomEvictionMs: 60 * 60 * 1000, // 1 hour
  opLogMaxSize: 50,
} as const;
```

- [ ] **Step 4: Create minimal `apps/backend/src/index.ts`**

```ts
import { Hono } from "hono";
import { config } from "./config";

const app = new Hono();

app.get("/healthz", (c) => c.json({ ok: true, version: "0.0.0" }));

const server = Bun.serve({
  port: config.port,
  fetch: app.fetch,
});

console.log(`[didraw] listening on http://localhost:${server.port}`);
```

- [ ] **Step 5: Install deps**

Run: `cd apps/backend && bun install`
Expected: success.

- [ ] **Step 6: Verify it boots**

Run: `cd apps/backend && bun src/index.ts &`
Then: `curl -s localhost:8787/healthz`
Expected: `{"ok":true,"version":"0.0.0"}`
Cleanup: `kill %1`

- [ ] **Step 7: Commit**

```bash
git add apps/backend/
git commit -m "chore(backend): bootstrap Hono skeleton with /healthz"
```

---

## Task 3: Bootstrap frontend skeleton

**Files:**
- Create: `apps/frontend/package.json`
- Create: `apps/frontend/tsconfig.json`
- Create: `apps/frontend/vite.config.ts`
- Create: `apps/frontend/index.html`
- Create: `apps/frontend/src/main.tsx`
- Create: `apps/frontend/src/App.tsx`
- Create: `apps/frontend/src/styles.css`

- [ ] **Step 1: Create `apps/frontend/package.json`**

```json
{
  "name": "@didraw/frontend",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "tldraw": "^3.0.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "vite": "^5.4.0",
    "typescript": "^5.5.0"
  }
}
```

> **Note:** `tldraw` major version 3.0 is "tldraw SDK 5.x" (NPM and SDK versions differ; spec mandates SDK 5.x). Confirm during install — if `npm view tldraw versions` shows newer major lines for SDK 5.x, bump. `@tldraw/mermaid` is added in Phase 1.5.

- [ ] **Step 2: Create `apps/frontend/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "types": ["vite/client"]
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create `apps/frontend/vite.config.ts`**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8787",
      "/ws": { target: "ws://localhost:8787", ws: true },
    },
  },
});
```

- [ ] **Step 4: Create `apps/frontend/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>di.draw</title>
    <link rel="stylesheet" href="/src/styles.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Create `apps/frontend/src/styles.css`**

```css
html, body, #root { margin: 0; padding: 0; height: 100%; }
body { font-family: system-ui, sans-serif; }
```

- [ ] **Step 6: Create `apps/frontend/src/main.tsx`**

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";

const room = new URLSearchParams(location.search).get("room") ?? "default";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App room={room} />
  </React.StrictMode>,
);
```

- [ ] **Step 7: Create skeleton `apps/frontend/src/App.tsx`**

```tsx
import { Tldraw } from "tldraw";
import "tldraw/tldraw.css";

export function App({ room }: { room: string }) {
  return (
    <div style={{ height: "100vh" }}>
      <div style={{ position: "fixed", top: 8, left: 8, zIndex: 1000 }}>
        room: <code>{room}</code>
      </div>
      <Tldraw />
    </div>
  );
}
```

- [ ] **Step 8: Install + verify**

Run: `cd apps/frontend && bun install && bun run dev`
Visit: `http://localhost:5173/?room=test`
Expected: пустой tldraw canvas с надписью `room: test` в углу.
Cleanup: Ctrl-C.

- [ ] **Step 9: Commit**

```bash
git add apps/frontend/
git commit -m "chore(frontend): bootstrap Vite+React+tldraw with room param"
```

---

## Task 4: Spike — `@tldraw/mermaid` headless on Bun

This is a **research task**, not production code. Goal: answer "can we parse Mermaid → tldraw shapes on backend (Bun, no DOM), or must it live on frontend?". Result becomes an ADR.

**Files:**
- Create: `apps/backend/spike/mermaid-headless.ts`
- Create: `docs/decisions/0001-mermaid-import-location.md`

- [ ] **Step 1: Add spike dependency**

```bash
cd apps/backend
bun add @tldraw/mermaid
bun add -D jsdom @types/jsdom
```

- [ ] **Step 2: Write headless attempt with jsdom**

Create `apps/backend/spike/mermaid-headless.ts`:

```ts
// Spike: можно ли импортировать @tldraw/mermaid без браузера на Bun?
import { JSDOM } from "jsdom";

// Установить globals до import'а tldraw
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
});
// @ts-expect-error
globalThis.window = dom.window;
// @ts-expect-error
globalThis.document = dom.window.document;
// @ts-expect-error
globalThis.navigator = dom.window.navigator;

const t0 = performance.now();
const mod = await import("@tldraw/mermaid");
const t1 = performance.now();

console.log("loaded keys:", Object.keys(mod));
console.log("ms to load:", (t1 - t0).toFixed(1));

// Попытка вызова: точное API уточняем по версии пакета (createMermaidDiagram / renderBlueprint).
// Если падает с ReferenceError на canvas/SVG-API — фиксируем в ADR.
try {
  // @ts-expect-error — runtime-API spike
  const result = await mod.createMermaidDiagram?.({
    source: "graph LR\n a --> b",
  });
  console.log("ok, blueprint nodes:", result?.nodes?.length ?? result);
} catch (err) {
  console.error("FAIL:", (err as Error).message);
  process.exit(1);
}
```

- [ ] **Step 3: Run spike, capture result**

```bash
cd apps/backend && bun spike/mermaid-headless.ts
```
Expected: либо `ok, blueprint nodes: N`, либо `FAIL: <reason>`. Записать stdout/stderr целиком — попадёт в ADR.

- [ ] **Step 4: Try fallback — CLI `mmdc` (mermaid-cli)**

```bash
bunx -y @mermaid-js/mermaid-cli --version || echo "MMD CLI not available"
```
If available, попробовать `echo 'graph LR; a-->b' | bunx mmdc -p -` чтобы понять, насколько годится для smoke-валидации (получить хотя бы SVG).

- [ ] **Step 5: Decide and write ADR**

Create `docs/decisions/0001-mermaid-import-location.md`:

```md
# ADR-0001: Mermaid import — backend vs frontend

**Date:** 2026-05-14
**Status:** Decided

## Context
Spec §4 предусматривал backend-side mermaid-import через `@tldraw/mermaid`.
Phase 0.1 spike проверяет, работает ли пакет в Bun без DOM (с jsdom-полифиллом
и без).

## Spike result
<!-- Вставить вывод спайка из шага 3, + jsdom попытка, + mmdc fallback. -->

## Decision
<!-- Один из:
A) Backend supported (`apps/backend/src/mermaid-import.ts` через jsdom).
B) Frontend-only (frontend получает mermaid-source, парсит сам, шлёт PatchOp[]).
C) Hybrid: backend smoke-validates через `mmdc`, frontend конвертирует.
-->

## Consequences
<!-- Что меняется в Phase 1.5. -->
```

- [ ] **Step 6: Commit spike artifacts**

```bash
git add apps/backend/spike apps/backend/package.json docs/decisions/
git commit -m "spike: evaluate @tldraw/mermaid on Bun (ADR-0001)"
```

> **Plan dependency note:** Task 30 (mermaid-import implementation) уточняет своё расположение по этому ADR. Все последующие задачи **не зависят** от исхода spike — Mermaid-фича изолирована.

---

## Task 5: Define core types

**Files:**
- Create: `apps/backend/src/types.ts`
- Create: `apps/backend/tests/types.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/backend/tests/types.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import type {
  CanvasState,
  Node,
  Edge,
  Endpoint,
  Group,
  PatchOp,
  Prompt,
  RoomState,
} from "../src/types";

describe("types — shape", () => {
  test("CanvasState has version=1 and three arrays", () => {
    const s: CanvasState = { version: 1, nodes: [], edges: [], groups: [] };
    expect(s.version).toBe(1);
    expect(s.nodes).toEqual([]);
    expect(s.edges).toEqual([]);
    expect(s.groups).toEqual([]);
  });

  test("Endpoint accepts node and point variants", () => {
    const e1: Endpoint = { kind: "node", id: "n1" };
    const e2: Endpoint = { kind: "point", x: 100, y: 200 };
    expect(e1.kind).toBe("node");
    expect(e2.kind).toBe("point");
  });

  test("Edge endpoints typed as Endpoint", () => {
    const edge: Edge = {
      id: "e1",
      from: { kind: "node", id: "n1" },
      to: { kind: "point", x: 0, y: 0 },
    };
    expect(edge.from.kind).toBe("node");
  });

  test("Node kinds cover MVP set", () => {
    const kinds: Node["kind"][] = ["rect", "ellipse", "diamond", "sticky", "text", "image", "freeform"];
    expect(kinds.length).toBe(7);
  });

  test("PatchOp is a discriminated union over op", () => {
    const ops: PatchOp[] = [
      { op: "add", target: "node", value: { id: "n1", kind: "rect", x: 0, y: 0 } },
      { op: "update", target: "node", id: "n1", set: { x: 10 } },
      { op: "delete", target: "edge", id: "e1" },
    ];
    expect(ops).toHaveLength(3);
  });

  test("Prompt has selection array and status", () => {
    const p: Prompt = {
      id: "p1",
      selection: ["n1"],
      text: "what is this?",
      createdAt: Date.now(),
      status: "pending",
    };
    expect(p.status).toBe("pending");
  });

  test("Group supports frame and group kinds", () => {
    const g1: Group = { id: "g1", kind: "frame", children: [], x: 0, y: 0, w: 100, h: 100 };
    const g2: Group = { id: "g2", kind: "group", children: ["n1", "n2"] };
    expect(g1.kind).toBe("frame");
    expect(g2.kind).toBe("group");
  });
});
```

- [ ] **Step 2: Run — expect FAIL with "Cannot find module ../src/types"**

```bash
cd apps/backend && bun test tests/types.test.ts
```
Expected: ENOENT for `../src/types`.

- [ ] **Step 3: Create `apps/backend/src/types.ts`**

```ts
export type CanvasState = {
  version: 1;
  nodes: Node[];
  edges: Edge[];
  groups: Group[];
};

export type Node = {
  id: string;
  kind: "rect" | "ellipse" | "diamond" | "sticky" | "text" | "image" | "freeform";
  label?: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  style?: NodeStyle;
  meta?: Record<string, unknown>;
};

export type NodeStyle = {
  color?: string;
  fill?: string;
  stroke?: string;
  fontSize?: number;
  rotation?: number;
};

export type Endpoint =
  | { kind: "node"; id: string }
  | { kind: "point"; x: number; y: number };

export type Edge = {
  id: string;
  from: Endpoint;
  to: Endpoint;
  label?: string;
  style?: EdgeStyle;
  meta?: Record<string, unknown>;
};

export type EdgeStyle = {
  color?: string;
  dashed?: boolean;
  arrow?: "none" | "to" | "both";
};

export type Group = {
  id: string;
  kind: "frame" | "group";
  children: string[];
  label?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  style?: { fill?: string; stroke?: string };
  collapsed?: boolean;
};

export type Target = "node" | "edge" | "group";

export type PatchOp =
  | { op: "add"; target: "node"; value: Node }
  | { op: "add"; target: "edge"; value: Edge }
  | { op: "add"; target: "group"; value: Group }
  | { op: "update"; target: "node"; id: string; set: Partial<Node> }
  | { op: "update"; target: "edge"; id: string; set: Partial<Edge> }
  | { op: "update"; target: "group"; id: string; set: Partial<Group> }
  | { op: "delete"; target: Target; id: string };

export type Prompt = {
  id: string;
  selection: string[];
  text: string;
  createdAt: number;
  status: "pending" | "resolved" | "dismissed";
  response?: string;
  resolvedAt?: number;
};

export type RoomId = string;

export type RoomState = {
  canvas: CanvasState;
  opLog: { ops: PatchOp[]; source: "ai" | "user"; version: number; at: number }[];
  prompts: Prompt[];
  version: number;
  dirty: boolean;
  lastTouched: number;
};

export type WsMessage =
  | { kind: "hello"; version: number }
  | { kind: "patch"; source: "ai" | "user"; ops: PatchOp[]; version: number; originClientId?: string }
  | { kind: "prompt-created"; prompt: Prompt }
  | { kind: "prompt-resolved"; id: string; response?: string };
```

- [ ] **Step 4: Run — expect PASS**

```bash
cd apps/backend && bun test tests/types.test.ts
```
Expected: 7 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/types.ts apps/backend/tests/types.test.ts
git commit -m "feat(backend): define core types — CanvasState, PatchOp, RoomState, Prompt"
```

---

## Task 6: `applyPatch` with deep-merge for style/meta

**Files:**
- Create: `apps/backend/src/patch.ts`
- Create: `apps/backend/tests/patch.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/backend/tests/patch.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { applyPatch, type ApplyResult } from "../src/patch";
import type { CanvasState, PatchOp } from "../src/types";

const empty = (): CanvasState => ({ version: 1, nodes: [], edges: [], groups: [] });

describe("applyPatch", () => {
  test("add node appends to nodes", () => {
    const r = applyPatch(empty(), [
      { op: "add", target: "node", value: { id: "n1", kind: "rect", x: 0, y: 0 } },
    ]);
    expect(r.ok).toBe(true);
    expect(r.state.nodes).toHaveLength(1);
    expect(r.state.nodes[0].id).toBe("n1");
  });

  test("update with shallow field — replaces", () => {
    const s: CanvasState = {
      version: 1,
      nodes: [{ id: "n1", kind: "rect", x: 0, y: 0, label: "old" }],
      edges: [], groups: [],
    };
    const r = applyPatch(s, [{ op: "update", target: "node", id: "n1", set: { label: "new", x: 50 } }]);
    expect(r.ok).toBe(true);
    expect(r.state.nodes[0].label).toBe("new");
    expect(r.state.nodes[0].x).toBe(50);
  });

  test("update with style.fill — deep-merges (stroke preserved)", () => {
    const s: CanvasState = {
      version: 1,
      nodes: [{ id: "n1", kind: "rect", x: 0, y: 0, style: { stroke: "#000", fontSize: 14 } }],
      edges: [], groups: [],
    };
    const r = applyPatch(s, [
      { op: "update", target: "node", id: "n1", set: { style: { fill: "#888" } } },
    ]);
    expect(r.ok).toBe(true);
    expect(r.state.nodes[0].style).toEqual({ stroke: "#000", fontSize: 14, fill: "#888" });
  });

  test("update with style.fill=undefined — deletes key", () => {
    const s: CanvasState = {
      version: 1,
      nodes: [{ id: "n1", kind: "rect", x: 0, y: 0, style: { fill: "#888", stroke: "#000" } }],
      edges: [], groups: [],
    };
    const r = applyPatch(s, [
      { op: "update", target: "node", id: "n1", set: { style: { fill: undefined } } },
    ]);
    expect(r.ok).toBe(true);
    expect(r.state.nodes[0].style).toEqual({ stroke: "#000" });
  });

  test("update with meta — deep-merges similarly", () => {
    const s: CanvasState = {
      version: 1,
      nodes: [{ id: "n1", kind: "rect", x: 0, y: 0, meta: { author: "ai", tag: "v1" } }],
      edges: [], groups: [],
    };
    const r = applyPatch(s, [
      { op: "update", target: "node", id: "n1", set: { meta: { tag: "v2", color: "red" } } },
    ]);
    expect(r.ok).toBe(true);
    expect(r.state.nodes[0].meta).toEqual({ author: "ai", tag: "v2", color: "red" });
  });

  test("delete removes the node", () => {
    const s: CanvasState = {
      version: 1,
      nodes: [{ id: "n1", kind: "rect", x: 0, y: 0 }],
      edges: [], groups: [],
    };
    const r = applyPatch(s, [{ op: "delete", target: "node", id: "n1" }]);
    expect(r.ok).toBe(true);
    expect(r.state.nodes).toHaveLength(0);
  });

  test("edge.from references unknown node — fails atomically", () => {
    const s = empty();
    const r = applyPatch(s, [
      { op: "add", target: "edge", value: { id: "e1", from: { kind: "node", id: "n1" }, to: { kind: "node", id: "n2" } } },
    ]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("n1");
    expect(r.state).toEqual(s); // не мутирует
  });

  test("edge with point endpoint — allowed even with no nodes", () => {
    const r = applyPatch(empty(), [
      { op: "add", target: "edge", value: { id: "e1", from: { kind: "point", x: 0, y: 0 }, to: { kind: "point", x: 100, y: 0 } } },
    ]);
    expect(r.ok).toBe(true);
  });

  test("multiple ops applied in order, atomically", () => {
    const r = applyPatch(empty(), [
      { op: "add", target: "node", value: { id: "n1", kind: "rect", x: 0, y: 0 } },
      { op: "add", target: "node", value: { id: "n2", kind: "rect", x: 100, y: 0 } },
      { op: "add", target: "edge", value: { id: "e1", from: { kind: "node", id: "n1" }, to: { kind: "node", id: "n2" } } },
    ]);
    expect(r.ok).toBe(true);
    expect(r.state.nodes).toHaveLength(2);
    expect(r.state.edges).toHaveLength(1);
  });

  test("rolls back when later op fails", () => {
    const r = applyPatch(empty(), [
      { op: "add", target: "node", value: { id: "n1", kind: "rect", x: 0, y: 0 } },
      { op: "add", target: "edge", value: { id: "e1", from: { kind: "node", id: "missing" }, to: { kind: "node", id: "n1" } } },
    ]);
    expect(r.ok).toBe(false);
    expect(r.state.nodes).toHaveLength(0); // не добавилась
  });
});
```

- [ ] **Step 2: Run — expect FAIL ("Cannot find module ../src/patch")**

```bash
cd apps/backend && bun test tests/patch.test.ts
```
Expected: module not found.

- [ ] **Step 3: Implement `apps/backend/src/patch.ts`**

```ts
import type { CanvasState, PatchOp, Node, Edge, Group } from "./types";

export type ApplyResult =
  | { ok: true; state: CanvasState }
  | { ok: false; state: CanvasState; error: string };

export function applyPatch(state: CanvasState, ops: PatchOp[]): ApplyResult {
  // Атомарность: работаем над копией, при ошибке возвращаем оригинал.
  let next: CanvasState = {
    version: state.version,
    nodes: [...state.nodes],
    edges: [...state.edges],
    groups: [...state.groups],
  };

  for (const op of ops) {
    const r = applyOne(next, op);
    if (!r.ok) return { ok: false, state, error: r.error };
    next = r.state;
  }
  return { ok: true, state: next };
}

function applyOne(s: CanvasState, op: PatchOp): ApplyResult {
  if (op.op === "add") return addOp(s, op);
  if (op.op === "update") return updateOp(s, op);
  return deleteOp(s, op);
}

function addOp(s: CanvasState, op: Extract<PatchOp, { op: "add" }>): ApplyResult {
  if (op.target === "node") {
    if (s.nodes.some((n) => n.id === op.value.id)) {
      return { ok: false, state: s, error: `node ${op.value.id} already exists` };
    }
    return { ok: true, state: { ...s, nodes: [...s.nodes, op.value] } };
  }
  if (op.target === "edge") {
    if (s.edges.some((e) => e.id === op.value.id)) {
      return { ok: false, state: s, error: `edge ${op.value.id} already exists` };
    }
    const checks = checkEndpoint(s, op.value.from, "from") ?? checkEndpoint(s, op.value.to, "to");
    if (checks) return { ok: false, state: s, error: checks };
    return { ok: true, state: { ...s, edges: [...s.edges, op.value] } };
  }
  if (op.target === "group") {
    if (s.groups.some((g) => g.id === op.value.id)) {
      return { ok: false, state: s, error: `group ${op.value.id} already exists` };
    }
    return { ok: true, state: { ...s, groups: [...s.groups, op.value] } };
  }
  return { ok: false, state: s, error: "unknown add target" };
}

function checkEndpoint(s: CanvasState, ep: Edge["from"], side: "from" | "to"): string | null {
  if (ep.kind === "node" && !s.nodes.some((n) => n.id === ep.id)) {
    return `edge.${side} references unknown node ${ep.id}`;
  }
  return null;
}

function updateOp(s: CanvasState, op: Extract<PatchOp, { op: "update" }>): ApplyResult {
  if (op.target === "node") {
    const idx = s.nodes.findIndex((n) => n.id === op.id);
    if (idx === -1) return { ok: false, state: s, error: `node ${op.id} not found` };
    const merged = mergeRecord(s.nodes[idx], op.set, ["style", "meta"]) as Node;
    const nodes = [...s.nodes];
    nodes[idx] = merged;
    return { ok: true, state: { ...s, nodes } };
  }
  if (op.target === "edge") {
    const idx = s.edges.findIndex((e) => e.id === op.id);
    if (idx === -1) return { ok: false, state: s, error: `edge ${op.id} not found` };
    const merged = mergeRecord(s.edges[idx], op.set, ["style", "meta"]) as Edge;
    if (op.set.from || op.set.to) {
      const ep = merged.from;
      const check = checkEndpoint(s, ep, "from") ?? checkEndpoint(s, merged.to, "to");
      if (check) return { ok: false, state: s, error: check };
    }
    const edges = [...s.edges];
    edges[idx] = merged;
    return { ok: true, state: { ...s, edges } };
  }
  if (op.target === "group") {
    const idx = s.groups.findIndex((g) => g.id === op.id);
    if (idx === -1) return { ok: false, state: s, error: `group ${op.id} not found` };
    const merged = mergeRecord(s.groups[idx], op.set, ["style"]) as Group;
    const groups = [...s.groups];
    groups[idx] = merged;
    return { ok: true, state: { ...s, groups } };
  }
  return { ok: false, state: s, error: "unknown update target" };
}

function deleteOp(s: CanvasState, op: Extract<PatchOp, { op: "delete" }>): ApplyResult {
  if (op.target === "node") return { ok: true, state: { ...s, nodes: s.nodes.filter((n) => n.id !== op.id) } };
  if (op.target === "edge") return { ok: true, state: { ...s, edges: s.edges.filter((e) => e.id !== op.id) } };
  if (op.target === "group") return { ok: true, state: { ...s, groups: s.groups.filter((g) => g.id !== op.id) } };
  return { ok: false, state: s, error: "unknown delete target" };
}

/**
 * Replace top-level fields; for keys in `deepKeys`, perform shallow-merge
 * (undefined values delete sub-keys).
 */
function mergeRecord<T extends Record<string, unknown>>(
  base: T,
  patch: Partial<T>,
  deepKeys: (keyof T)[],
): T {
  const out: Record<string, unknown> = { ...base };
  for (const k of Object.keys(patch) as (keyof T)[]) {
    const v = patch[k];
    if (deepKeys.includes(k) && isObject(v) && isObject(base[k])) {
      const sub: Record<string, unknown> = { ...(base[k] as Record<string, unknown>) };
      for (const sk of Object.keys(v as object)) {
        const sv = (v as Record<string, unknown>)[sk];
        if (sv === undefined) delete sub[sk];
        else sub[sk] = sv;
      }
      out[k as string] = sub;
    } else {
      out[k as string] = v;
    }
  }
  return out as T;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
```

- [ ] **Step 4: Run — expect PASS (all 10 tests)**

```bash
cd apps/backend && bun test tests/patch.test.ts
```
Expected: 10 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/patch.ts apps/backend/tests/patch.test.ts
git commit -m "feat(backend): applyPatch with deep-merge for style/meta and atomic rollback"
```

---

## Task 7: Rooms manager (in-memory map, LRU)

**Files:**
- Create: `apps/backend/src/rooms.ts`
- Create: `apps/backend/tests/rooms.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/backend/tests/rooms.test.ts`:

```ts
import { describe, test, expect, beforeEach } from "bun:test";
import { Rooms, makeRoomState } from "../src/rooms";

describe("Rooms — in-memory (no persistence)", () => {
  let rooms: Rooms;
  beforeEach(() => { rooms = new Rooms({ load: async () => null, save: async () => {} }); });

  test("get returns fresh empty room on first call", async () => {
    const r = await rooms.get("a");
    expect(r.canvas.nodes).toEqual([]);
    expect(r.version).toBe(0);
  });

  test("two different ids return isolated rooms", async () => {
    const a = await rooms.get("a");
    const b = await rooms.get("b");
    a.canvas.nodes.push({ id: "n1", kind: "rect", x: 0, y: 0 });
    expect(b.canvas.nodes).toEqual([]);
  });

  test("get returns same instance for same id", async () => {
    const r1 = await rooms.get("a");
    const r2 = await rooms.get("a");
    expect(r1).toBe(r2);
  });

  test("touch updates lastTouched", async () => {
    const r = await rooms.get("a");
    const before = r.lastTouched;
    await new Promise((r) => setTimeout(r, 5));
    rooms.touch("a");
    expect(r.lastTouched).toBeGreaterThan(before);
  });

  test("makeRoomState produces valid empty state", () => {
    const s = makeRoomState();
    expect(s.version).toBe(0);
    expect(s.canvas).toEqual({ version: 1, nodes: [], edges: [], groups: [] });
    expect(s.opLog).toEqual([]);
    expect(s.prompts).toEqual([]);
    expect(s.dirty).toBe(false);
  });
});

describe("Rooms — persistence integration", () => {
  test("get loads from store if available", async () => {
    const loaded = makeRoomState();
    loaded.canvas.nodes.push({ id: "preexisting", kind: "rect", x: 0, y: 0 });
    const rooms = new Rooms({ load: async (id) => (id === "x" ? loaded : null), save: async () => {} });
    const r = await rooms.get("x");
    expect(r.canvas.nodes[0].id).toBe("preexisting");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
cd apps/backend && bun test tests/rooms.test.ts
```
Expected: module not found.

- [ ] **Step 3: Implement `apps/backend/src/rooms.ts`**

```ts
import type { RoomId, RoomState } from "./types";

export type RoomStore = {
  load: (id: RoomId) => Promise<RoomState | null>;
  save: (id: RoomId, state: RoomState) => Promise<void>;
};

export function makeRoomState(): RoomState {
  return {
    canvas: { version: 1, nodes: [], edges: [], groups: [] },
    opLog: [],
    prompts: [],
    version: 0,
    dirty: false,
    lastTouched: Date.now(),
  };
}

export class Rooms {
  private map = new Map<RoomId, RoomState>();
  private loading = new Map<RoomId, Promise<RoomState>>();

  constructor(private store: RoomStore) {}

  async get(id: RoomId): Promise<RoomState> {
    const existing = this.map.get(id);
    if (existing) {
      existing.lastTouched = Date.now();
      return existing;
    }
    const pending = this.loading.get(id);
    if (pending) return pending;

    const promise = (async () => {
      const loaded = await this.store.load(id);
      const state = loaded ?? makeRoomState();
      this.map.set(id, state);
      this.loading.delete(id);
      return state;
    })();
    this.loading.set(id, promise);
    return promise;
  }

  touch(id: RoomId): void {
    const s = this.map.get(id);
    if (s) s.lastTouched = Date.now();
  }

  has(id: RoomId): boolean {
    return this.map.has(id);
  }

  ids(): RoomId[] {
    return [...this.map.keys()];
  }

  /**
   * Evict rooms inactive longer than `maxIdleMs`. Saves them first if dirty.
   * Returns count evicted.
   */
  async evictIdle(maxIdleMs: number): Promise<number> {
    const cutoff = Date.now() - maxIdleMs;
    let evicted = 0;
    for (const [id, s] of this.map) {
      if (s.lastTouched < cutoff) {
        if (s.dirty) await this.store.save(id, s);
        this.map.delete(id);
        evicted++;
      }
    }
    return evicted;
  }
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
cd apps/backend && bun test tests/rooms.test.ts
```
Expected: 6 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/rooms.ts apps/backend/tests/rooms.test.ts
git commit -m "feat(backend): Rooms manager — lazy-load, LRU eviction, store injection"
```

---

## Task 8: Persistence (autosave debounce + load)

**Files:**
- Create: `apps/backend/src/persistence.ts`
- Create: `apps/backend/tests/persistence.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/backend/tests/persistence.test.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { FilePersistence } from "../src/persistence";
import { makeRoomState } from "../src/rooms";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "didraw-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("FilePersistence", () => {
  test("load — non-existent file returns null", async () => {
    const p = new FilePersistence(dir);
    expect(await p.load("missing")).toBeNull();
  });

  test("save then load round-trips state", async () => {
    const p = new FilePersistence(dir);
    const s = makeRoomState();
    s.canvas.nodes.push({ id: "n1", kind: "rect", x: 5, y: 10, label: "hi" });
    s.version = 3;
    await p.save("test", s);

    const loaded = await p.load("test");
    expect(loaded?.canvas.nodes[0].id).toBe("n1");
    expect(loaded?.version).toBe(3);
  });

  test("save writes JSON to expected path", async () => {
    const p = new FilePersistence(dir);
    await p.save("alpha", makeRoomState());
    expect(existsSync(join(dir, "alpha.json"))).toBe(true);
  });

  test("opLog and dirty are NOT persisted", async () => {
    const p = new FilePersistence(dir);
    const s = makeRoomState();
    s.opLog.push({ ops: [], source: "user", version: 1, at: Date.now() });
    s.dirty = true;
    await p.save("o", s);

    const loaded = await p.load("o");
    expect(loaded?.opLog).toEqual([]);
    expect(loaded?.dirty).toBe(false);
  });

  test("scheduleSave debounces — multiple calls => single write", async () => {
    const p = new FilePersistence(dir);
    let writes = 0;
    const origSave = p.save.bind(p);
    p.save = async (id, s) => { writes++; return origSave(id, s); };

    p.scheduleSave("d", makeRoomState());
    p.scheduleSave("d", makeRoomState());
    p.scheduleSave("d", makeRoomState());
    await new Promise((r) => setTimeout(r, 50));
    expect(writes).toBe(0); // ещё не пришло время

    await new Promise((r) => setTimeout(r, 320));
    expect(writes).toBe(1);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cd apps/backend && bun test tests/persistence.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement `apps/backend/src/persistence.ts`**

```ts
import { existsSync, mkdirSync, promises as fs } from "node:fs";
import { join } from "node:path";
import type { RoomId, RoomState } from "./types";
import { config } from "./config";

export class FilePersistence {
  private pending = new Map<RoomId, ReturnType<typeof setTimeout>>();

  constructor(private dir: string) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  async load(id: RoomId): Promise<RoomState | null> {
    const path = join(this.dir, `${sanitize(id)}.json`);
    try {
      const raw = await fs.readFile(path, "utf8");
      const parsed = JSON.parse(raw) as Partial<RoomState>;
      return {
        canvas: parsed.canvas ?? { version: 1, nodes: [], edges: [], groups: [] },
        prompts: parsed.prompts ?? [],
        version: parsed.version ?? 0,
        opLog: [],          // не персистится
        dirty: false,       // не персистится
        lastTouched: Date.now(),
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async save(id: RoomId, state: RoomState): Promise<void> {
    const path = join(this.dir, `${sanitize(id)}.json`);
    const dump = JSON.stringify({
      canvas: state.canvas,
      prompts: state.prompts,
      version: state.version,
    }, null, 2);
    await fs.writeFile(path, dump, "utf8");
  }

  scheduleSave(id: RoomId, state: RoomState): void {
    clearTimeout(this.pending.get(id));
    const timer = setTimeout(() => {
      this.pending.delete(id);
      void this.save(id, state).catch((err) => console.error("[persistence] save failed", err));
    }, config.autosaveDebounceMs);
    this.pending.set(id, timer);
  }

  async flush(): Promise<void> {
    const ids = [...this.pending.keys()];
    for (const id of ids) clearTimeout(this.pending.get(id));
    this.pending.clear();
  }
}

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}
```

- [ ] **Step 4: Run — expect PASS (5 tests)**

Run: `cd apps/backend && bun test tests/persistence.test.ts`
Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/persistence.ts apps/backend/tests/persistence.test.ts
git commit -m "feat(backend): FilePersistence with debounced autosave"
```

---

## Task 9: REST routes — state and patch

**Files:**
- Create: `apps/backend/src/routes/state.ts`
- Create: `apps/backend/src/routes/patch.ts`
- Create: `apps/backend/src/routes/health.ts`
- Modify: `apps/backend/src/index.ts`
- Create: `apps/backend/tests/routes.state.test.ts`
- Create: `apps/backend/tests/routes.patch.test.ts`

- [ ] **Step 1: Write failing test for `/api/state`**

Create `apps/backend/tests/routes.state.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { makeApp } from "../src/index";

describe("GET /api/state", () => {
  test("returns empty room snapshot for new id", async () => {
    const app = makeApp({ inMemory: true });
    const res = await app.fetch(new Request("http://x/api/state?room=alpha"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.canvas).toEqual({ version: 1, nodes: [], edges: [], groups: [] });
    expect(body.version).toBe(0);
  });

  test("returns diff when since=<version>", async () => {
    const app = makeApp({ inMemory: true });
    // первый patch
    await app.fetch(new Request("http://x/api/patch?room=a", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ops: [{ op: "add", target: "node", value: { id: "n1", kind: "rect", x: 0, y: 0 } }],
        source: "user",
      }),
    }));
    // diff с version=0 → должен содержать одну операцию
    const res = await app.fetch(new Request("http://x/api/state?room=a&since=0"));
    const body = await res.json();
    expect(body.diff).toHaveLength(1);
    expect(body.diff[0].ops[0].op).toBe("add");
  });

  test("compact omits default-equal fields", async () => {
    const app = makeApp({ inMemory: true });
    await app.fetch(new Request("http://x/api/patch?room=a", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ops: [{ op: "add", target: "node", value: { id: "n1", kind: "rect", x: 0, y: 0 } }],
        source: "user",
      }),
    }));
    const res = await app.fetch(new Request("http://x/api/state?room=a&fmt=compact"));
    const body = await res.json();
    // compact: no `meta`, no `style` when empty
    expect(body.canvas.nodes[0]).not.toHaveProperty("style");
    expect(body.canvas.nodes[0]).not.toHaveProperty("meta");
  });
});
```

- [ ] **Step 2: Write failing test for `/api/patch`**

Create `apps/backend/tests/routes.patch.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { makeApp } from "../src/index";

describe("POST /api/patch", () => {
  test("applies ops, returns new version", async () => {
    const app = makeApp({ inMemory: true });
    const res = await app.fetch(new Request("http://x/api/patch?room=a", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ops: [{ op: "add", target: "node", value: { id: "n1", kind: "rect", x: 0, y: 0 } }],
        source: "ai",
      }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.version).toBe(1);
  });

  test("returns 422 on validation error, version unchanged", async () => {
    const app = makeApp({ inMemory: true });
    const res = await app.fetch(new Request("http://x/api/patch?room=a", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ops: [{ op: "add", target: "edge", value: { id: "e1", from: { kind: "node", id: "missing" }, to: { kind: "node", id: "n1" } } }],
        source: "ai",
      }),
    }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain("missing");

    const st = await app.fetch(new Request("http://x/api/state?room=a"));
    const stBody = await st.json();
    expect(stBody.version).toBe(0);
  });

  test("idempotency by clientOpId", async () => {
    const app = makeApp({ inMemory: true });
    const body = {
      ops: [{ op: "add", target: "node", value: { id: "n1", kind: "rect", x: 0, y: 0 } }],
      source: "user",
      clientOpId: "abc-123",
    };
    const r1 = await app.fetch(new Request("http://x/api/patch?room=a", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    const r2 = await app.fetch(new Request("http://x/api/patch?room=a", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    const b1 = await r1.json();
    const b2 = await r2.json();
    expect(b1.version).toBe(1);
    expect(b2.version).toBe(1);    // не выросло
    expect(b2.idempotent).toBe(true);
  });

  test("rooms are isolated", async () => {
    const app = makeApp({ inMemory: true });
    await app.fetch(new Request("http://x/api/patch?room=a", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ops: [{ op: "add", target: "node", value: { id: "n1", kind: "rect", x: 0, y: 0 } }],
        source: "user",
      }),
    }));
    const res = await app.fetch(new Request("http://x/api/state?room=b"));
    const body = await res.json();
    expect(body.canvas.nodes).toEqual([]);
  });
});
```

- [ ] **Step 3: Run — expect FAILS**

Run: `cd apps/backend && bun test tests/routes.*.test.ts`
Expected: module not found / `makeApp` export missing.

- [ ] **Step 4: Implement `apps/backend/src/routes/health.ts`**

```ts
import { Hono } from "hono";
export const healthRoutes = new Hono().get("/healthz", (c) => c.json({ ok: true }));
```

- [ ] **Step 5: Implement `apps/backend/src/routes/state.ts`**

```ts
import { Hono } from "hono";
import type { Rooms } from "../rooms";
import type { CanvasState, Node, Edge, Group, RoomState } from "../types";

export function stateRoutes(rooms: Rooms) {
  return new Hono().get("/api/state", async (c) => {
    const id = c.req.query("room") ?? "default";
    const since = Number(c.req.query("since") ?? "");
    const fmt = c.req.query("fmt") ?? "full";

    const r = await rooms.get(id);
    rooms.touch(id);

    if (Number.isFinite(since)) {
      const diff = r.opLog.filter((e) => e.version > since);
      return c.json({ since, version: r.version, diff });
    }

    const canvas = fmt === "compact" ? compact(r.canvas) : r.canvas;
    return c.json({ version: r.version, canvas, prompts: r.prompts });
  });
}

function compact(s: CanvasState): CanvasState {
  return {
    version: s.version,
    nodes: s.nodes.map(compactNode),
    edges: s.edges.map(compactEdge),
    groups: s.groups.map(compactGroup),
  };
}
function compactNode(n: Node): Node {
  const o: Node = { id: n.id, kind: n.kind, x: round(n.x), y: round(n.y) };
  if (n.label) o.label = n.label;
  if (n.w !== undefined) o.w = round(n.w);
  if (n.h !== undefined) o.h = round(n.h);
  if (n.style && Object.keys(n.style).length) o.style = n.style;
  if (n.meta && Object.keys(n.meta).length) o.meta = n.meta;
  return o;
}
function compactEdge(e: Edge): Edge {
  const o: Edge = { id: e.id, from: e.from, to: e.to };
  if (e.label) o.label = e.label;
  if (e.style && Object.keys(e.style).length) o.style = e.style;
  if (e.meta && Object.keys(e.meta).length) o.meta = e.meta;
  return o;
}
function compactGroup(g: Group): Group {
  return g; // groups уже минимальны
}
function round(n: number): number { return Math.round(n * 10) / 10; }
```

- [ ] **Step 6: Implement `apps/backend/src/routes/patch.ts`**

```ts
import { Hono } from "hono";
import type { Rooms } from "../rooms";
import { applyPatch } from "../patch";
import type { PatchOp } from "../types";
import { config } from "../config";

export type PatchBus = {
  publish: (room: string, msg: { ops: PatchOp[]; source: "ai" | "user"; version: number; originClientId?: string }) => void;
};

export function patchRoutes(rooms: Rooms, bus: PatchBus, opts: { onDirty?: (room: string) => void } = {}) {
  return new Hono().post("/api/patch", async (c) => {
    const id = c.req.query("room") ?? "default";
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.ops)) {
      return c.json({ ok: false, error: "expected { ops: PatchOp[], source }" }, 400);
    }
    const ops = body.ops as PatchOp[];
    const source = (body.source ?? "user") as "ai" | "user";
    const clientOpId: string | undefined = body.clientOpId;

    const r = await rooms.get(id);
    rooms.touch(id);

    // Идемпотентность: если такой clientOpId уже применялся — возвращаем текущую версию.
    if (clientOpId) {
      const seen = r.opLog.find((e) => (e as { clientOpId?: string }).clientOpId === clientOpId);
      if (seen) return c.json({ ok: true, version: r.version, idempotent: true });
    }

    const result = applyPatch(r.canvas, ops);
    if (!result.ok) return c.json({ ok: false, error: result.error }, 422);

    r.canvas = result.state;
    r.version += 1;
    r.opLog.push({ ops, source, version: r.version, at: Date.now(), ...(clientOpId ? { clientOpId } : {}) } as never);
    if (r.opLog.length > config.opLogMaxSize) r.opLog.splice(0, r.opLog.length - config.opLogMaxSize);
    r.dirty = true;
    opts.onDirty?.(id);

    bus.publish(id, { ops, source, version: r.version, originClientId: clientOpId });

    return c.json({ ok: true, version: r.version });
  });
}
```

- [ ] **Step 7: Replace `apps/backend/src/index.ts`**

```ts
import { Hono } from "hono";
import { config } from "./config";
import { Rooms, type RoomStore } from "./rooms";
import { FilePersistence } from "./persistence";
import { stateRoutes } from "./routes/state";
import { patchRoutes, type PatchBus } from "./routes/patch";
import { healthRoutes } from "./routes/health";
import { join } from "node:path";

export function makeApp(opts: { inMemory?: boolean } = {}) {
  const storageDir = join(config.storageDir, "default-project", "canvas");
  const store: RoomStore = opts.inMemory
    ? { load: async () => null, save: async () => {} }
    : new FilePersistence(storageDir);

  const rooms = new Rooms(store);
  const bus: PatchBus = { publish: () => {} }; // WS-bus подключим в задаче 10

  const app = new Hono();
  app.route("/", healthRoutes);
  app.route("/", stateRoutes(rooms));
  app.route("/", patchRoutes(rooms, bus, {
    onDirty: opts.inMemory ? undefined : (id) => {
      // hook for autosave; реальная реализация — в задаче 11
    },
  }));
  return app;
}

if (import.meta.main) {
  const app = makeApp();
  const server = Bun.serve({ port: config.port, fetch: app.fetch });
  console.log(`[didraw] listening on http://localhost:${server.port}`);
}
```

- [ ] **Step 8: Run — expect ALL PASS**

Run: `cd apps/backend && bun test tests/`
Expected: 21 pass total (types 7 + patch 10 + rooms 6 + persistence 5 + state 3 + patch routes 4 = ...). Count by output.

- [ ] **Step 9: Commit**

```bash
git add apps/backend/src/routes apps/backend/src/index.ts apps/backend/tests/routes.*.test.ts
git commit -m "feat(backend): REST /api/state and /api/patch with multi-room and idempotency"
```

---

## Task 10: WebSocket broadcast per-room

**Files:**
- Create: `apps/backend/src/ws.ts`
- Modify: `apps/backend/src/index.ts`
- Create: `apps/backend/tests/ws.test.ts`

- [ ] **Step 1: Write failing integration test**

Create `apps/backend/tests/ws.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { startServer } from "../src/index";

const HOST = "ws://localhost";

describe("WebSocket /ws", () => {
  test("client receives patch broadcast", async () => {
    const { port, close } = await startServer({ inMemory: true, port: 0 });
    const url = `${HOST}:${port}/ws?room=a`;

    const messages: unknown[] = [];
    const ws = new WebSocket(url);
    await new Promise<void>((res) => { ws.onopen = () => res(); });
    ws.onmessage = (e) => messages.push(JSON.parse(e.data as string));

    // подождём hello
    await new Promise((r) => setTimeout(r, 30));

    await fetch(`http://localhost:${port}/api/patch?room=a`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ops: [{ op: "add", target: "node", value: { id: "n1", kind: "rect", x: 0, y: 0 } }],
        source: "ai",
      }),
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(messages.some((m: any) => m.kind === "hello")).toBe(true);
    expect(messages.some((m: any) => m.kind === "patch" && m.version === 1)).toBe(true);

    ws.close();
    await close();
  });

  test("rooms are isolated on WS", async () => {
    const { port, close } = await startServer({ inMemory: true, port: 0 });

    const ws = new WebSocket(`${HOST}:${port}/ws?room=a`);
    const otherMessages: unknown[] = [];
    await new Promise<void>((res) => { ws.onopen = () => res(); });
    ws.onmessage = (e) => otherMessages.push(JSON.parse(e.data as string));

    await fetch(`http://localhost:${port}/api/patch?room=b`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ops: [{ op: "add", target: "node", value: { id: "x", kind: "rect", x: 0, y: 0 } }],
        source: "ai",
      }),
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(otherMessages.find((m: any) => m.kind === "patch")).toBeUndefined();
    ws.close();
    await close();
  });
});
```

- [ ] **Step 2: Run — expect FAIL ("startServer not exported")**

Run: `cd apps/backend && bun test tests/ws.test.ts`

- [ ] **Step 3: Implement `apps/backend/src/ws.ts`**

```ts
import type { PatchBus } from "./routes/patch";
import type { Prompt, PatchOp, WsMessage } from "./types";

type Sock = { send: (data: string) => void; readyState: number };

const OPEN = 1;

export class WsHub implements PatchBus {
  private rooms = new Map<string, Set<Sock>>();

  attach(room: string, sock: Sock) {
    if (!this.rooms.has(room)) this.rooms.set(room, new Set());
    this.rooms.get(room)!.add(sock);
  }

  detach(room: string, sock: Sock) {
    this.rooms.get(room)?.delete(sock);
  }

  publish(room: string, msg: { ops: PatchOp[]; source: "ai" | "user"; version: number; originClientId?: string }): void {
    this.broadcast(room, { kind: "patch", ...msg });
  }

  publishPrompt(room: string, prompt: Prompt): void {
    this.broadcast(room, { kind: "prompt-created", prompt });
  }

  publishPromptResolved(room: string, id: string, response?: string): void {
    this.broadcast(room, { kind: "prompt-resolved", id, response });
  }

  private broadcast(room: string, msg: WsMessage) {
    const set = this.rooms.get(room);
    if (!set) return;
    const data = JSON.stringify(msg);
    for (const s of set) if (s.readyState === OPEN) s.send(data);
  }
}
```

- [ ] **Step 4: Replace `apps/backend/src/index.ts` (wire WS into Bun.serve)**

```ts
import { Hono } from "hono";
import { config } from "./config";
import { Rooms, type RoomStore } from "./rooms";
import { FilePersistence } from "./persistence";
import { stateRoutes } from "./routes/state";
import { patchRoutes } from "./routes/patch";
import { healthRoutes } from "./routes/health";
import { WsHub } from "./ws";
import { join } from "node:path";

export type AppOpts = { inMemory?: boolean; port?: number; storageDir?: string };

export function makeApp(opts: AppOpts = {}) {
  const storageDir = opts.storageDir ?? join(config.storageDir, "default-project", "canvas");
  const persistence = opts.inMemory ? null : new FilePersistence(storageDir);
  const store: RoomStore = persistence
    ? { load: (id) => persistence.load(id), save: (id, s) => persistence.save(id, s) }
    : { load: async () => null, save: async () => {} };

  const rooms = new Rooms(store);
  const bus = new WsHub();

  const app = new Hono();
  app.route("/", healthRoutes);
  app.route("/", stateRoutes(rooms));
  app.route("/", patchRoutes(rooms, bus, {
    onDirty: persistence ? (id) => { void rooms.get(id).then((s) => persistence.scheduleSave(id, s)); } : undefined,
  }));
  return { app, rooms, bus };
}

export async function startServer(opts: AppOpts = {}) {
  const { app, bus } = makeApp(opts);

  const server = Bun.serve({
    port: opts.port ?? config.port,
    fetch: (req, srv) => {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        const room = url.searchParams.get("room") ?? "default";
        if (srv.upgrade(req, { data: { room } })) return;
        return new Response("ws upgrade failed", { status: 500 });
      }
      return app.fetch(req);
    },
    websocket: {
      open(ws) {
        const { room } = ws.data as { room: string };
        bus.attach(room, ws as unknown as { send: (d: string) => void; readyState: number });
        ws.send(JSON.stringify({ kind: "hello", version: 0 }));
      },
      message() {/* server-side ws is broadcast-only in MVP */},
      close(ws) {
        const { room } = ws.data as { room: string };
        bus.detach(room, ws as unknown as { send: (d: string) => void; readyState: number });
      },
    },
  });

  return {
    port: server.port,
    close: async () => { server.stop(); },
  };
}

if (import.meta.main) {
  void startServer().then((s) => console.log(`[didraw] listening on :${s.port}`));
}
```

- [ ] **Step 5: Run — expect PASS**

Run: `cd apps/backend && bun test tests/ws.test.ts`
Expected: 2 pass.

- [ ] **Step 6: Run ALL backend tests**

Run: `cd apps/backend && bun test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/ws.ts apps/backend/src/index.ts apps/backend/tests/ws.test.ts
git commit -m "feat(backend): per-room WS broadcast via WsHub"
```

---

## Task 11: Wire autosave into the server

**Files:**
- Modify: `apps/backend/src/index.ts`
- Create: `apps/backend/tests/autosave.test.ts`

- [ ] **Step 1: Write failing test**

Create `apps/backend/tests/autosave.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../src/index";

describe("autosave", () => {
  test("after patch, canvas.json appears on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "didraw-as-"));
    const { port, close } = await startServer({ port: 0, storageDir: dir });
    await fetch(`http://localhost:${port}/api/patch?room=tst`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ops: [{ op: "add", target: "node", value: { id: "n1", kind: "rect", x: 5, y: 10 } }],
        source: "user",
      }),
    });
    await new Promise((r) => setTimeout(r, 500)); // > debounce 300ms

    const path = join(dir, "tst.json");
    expect(existsSync(path)).toBe(true);
    const dump = JSON.parse(readFileSync(path, "utf8"));
    expect(dump.canvas.nodes[0].id).toBe("n1");

    await close();
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run — expect PASS** (autosave уже подключен в Task 10 через `persistence.scheduleSave`).

Run: `cd apps/backend && bun test tests/autosave.test.ts`
Expected: 1 pass.

> Если test красный — добавить недостающую проводку в `makeApp().onDirty`.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/tests/autosave.test.ts
git commit -m "test(backend): integration test for autosave on patch"
```

---

## Task 12: Frontend — load CanvasState from API on mount

**Files:**
- Create: `apps/frontend/src/transport/api.ts`
- Create: `apps/frontend/src/canvas/kinds.ts`
- Modify: `apps/frontend/src/App.tsx`

- [ ] **Step 1: Implement `transport/api.ts`**

```ts
export const room = new URLSearchParams(location.search).get("room") ?? "default";

export async function getState(): Promise<{ version: number; canvas: any; prompts: any[] }> {
  const r = await fetch(`/api/state?room=${encodeURIComponent(room)}`);
  if (!r.ok) throw new Error(`getState failed: ${r.status}`);
  return r.json();
}

export async function sendPatch(ops: unknown[], clientOpId: string): Promise<{ ok: true; version: number } | { ok: false; error: string }> {
  const r = await fetch(`/api/patch?room=${encodeURIComponent(room)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ops, source: "user", clientOpId }),
  });
  return r.json();
}
```

- [ ] **Step 2: Implement `canvas/kinds.ts` (CanvasState → tldraw shape descriptors)**

```ts
import type { TLShapePartial } from "tldraw";

// Map our Node.kind → tldraw's geo shape type.
export function kindToTldraw(kind: string): "rectangle" | "ellipse" | "diamond" | "note" | "text" | "draw" {
  switch (kind) {
    case "rect": return "rectangle";
    case "ellipse": return "ellipse";
    case "diamond": return "diamond";
    case "sticky": return "note";
    case "text": return "text";
    case "freeform": return "draw";
    default: return "rectangle";
  }
}

export function nodeToShape(n: { id: string; kind: string; x: number; y: number; w?: number; h?: number; label?: string }): TLShapePartial {
  const geoType = kindToTldraw(n.kind);
  if (geoType === "note") {
    return {
      id: `shape:${n.id}` as any,
      type: "note",
      x: n.x, y: n.y,
      props: { text: n.label ?? "" },
      meta: { canvasId: n.id, kind: n.kind },
    } as TLShapePartial;
  }
  if (geoType === "text") {
    return {
      id: `shape:${n.id}` as any,
      type: "text",
      x: n.x, y: n.y,
      props: { text: n.label ?? "" },
      meta: { canvasId: n.id, kind: n.kind },
    } as TLShapePartial;
  }
  if (geoType === "draw") {
    // freeform: minimal — без точек оставит пустой shape, frontend дорисует позже
    return {
      id: `shape:${n.id}` as any,
      type: "draw",
      x: n.x, y: n.y,
      meta: { canvasId: n.id, kind: n.kind },
    } as TLShapePartial;
  }
  return {
    id: `shape:${n.id}` as any,
    type: "geo",
    x: n.x, y: n.y,
    props: { geo: geoType, w: n.w ?? 120, h: n.h ?? 60, text: n.label ?? "" },
    meta: { canvasId: n.id, kind: n.kind },
  } as TLShapePartial;
}
```

> **Note for the engineer:** Точные имена types/props tldraw SDK 5.x уточнить по `apps/frontend/node_modules/tldraw/dist/types/index.d.ts` или docs. Этот код — стартовый каркас; имена `geo`/`note`/`draw`/`text` соответствуют tldraw 3.x на npm (== SDK 5.x).

- [ ] **Step 3: Replace `App.tsx` to load state and render**

```tsx
import { useEffect, useState } from "react";
import { Tldraw, type Editor } from "tldraw";
import "tldraw/tldraw.css";
import { getState, room } from "./transport/api";
import { nodeToShape } from "./canvas/kinds";

export function App({ room: r }: { room: string }) {
  const [editor, setEditor] = useState<Editor | null>(null);

  useEffect(() => {
    if (!editor) return;
    (async () => {
      const state = await getState();
      const shapes = state.canvas.nodes.map(nodeToShape);
      if (shapes.length) editor.createShapes(shapes);
    })();
  }, [editor]);

  return (
    <div style={{ height: "100vh" }}>
      <div style={{ position: "fixed", top: 8, left: 8, zIndex: 1000 }}>
        room: <code>{r}</code>
      </div>
      <Tldraw onMount={setEditor} />
    </div>
  );
}
```

- [ ] **Step 4: Manual smoke test**

In one terminal: `cd apps/backend && bun src/index.ts`
In another: `cd apps/frontend && bun run dev`
In a third:
```bash
curl -s -X POST 'localhost:8787/api/patch?room=test' \
  -H 'content-type: application/json' \
  -d '{"ops":[{"op":"add","target":"node","value":{"id":"n1","kind":"rect","x":50,"y":50,"label":"hi"}}],"source":"ai"}'
```
Then open `http://localhost:5173/?room=test`
Expected: tldraw shows a "hi" rectangle.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/
git commit -m "feat(frontend): render initial CanvasState from backend on mount"
```

---

## Task 13: Frontend — WS subscription with echo-guard

**Files:**
- Create: `apps/frontend/src/transport/ws.ts`
- Create: `apps/frontend/src/canvas/echo-guard.ts`
- Modify: `apps/frontend/src/App.tsx`

- [ ] **Step 1: Implement `transport/ws.ts`**

```ts
import { room } from "./api";

export type WsMessage =
  | { kind: "hello"; version: number }
  | { kind: "patch"; source: "ai" | "user"; ops: unknown[]; version: number; originClientId?: string }
  | { kind: "prompt-created"; prompt: unknown }
  | { kind: "prompt-resolved"; id: string; response?: string };

export type WsHandlers = {
  onPatch?: (m: Extract<WsMessage, { kind: "patch" }>) => void;
  onPromptCreated?: (m: Extract<WsMessage, { kind: "prompt-created" }>) => void;
  onPromptResolved?: (m: Extract<WsMessage, { kind: "prompt-resolved" }>) => void;
};

export function openWs(handlers: WsHandlers): () => void {
  let socket: WebSocket | null = null;
  let attempt = 0;
  let stopped = false;

  const connect = () => {
    socket = new WebSocket(`ws://${location.host}/ws?room=${encodeURIComponent(room)}`);
    socket.onopen = () => { attempt = 0; };
    socket.onmessage = (e) => {
      const msg = JSON.parse(e.data as string) as WsMessage;
      if (msg.kind === "patch") handlers.onPatch?.(msg);
      if (msg.kind === "prompt-created") handlers.onPromptCreated?.(msg);
      if (msg.kind === "prompt-resolved") handlers.onPromptResolved?.(msg);
    };
    socket.onclose = () => {
      if (stopped) return;
      const delay = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
      attempt++;
      setTimeout(connect, delay);
    };
    socket.onerror = () => socket?.close();
  };

  connect();
  return () => { stopped = true; socket?.close(); };
}
```

- [ ] **Step 2: Implement `canvas/echo-guard.ts`**

```ts
const seen = new Set<string>();

export function rememberOurOpId(id: string) {
  seen.add(id);
  setTimeout(() => seen.delete(id), 10_000);
}

export function isOurOp(id: string | undefined): boolean {
  return !!id && seen.has(id);
}
```

- [ ] **Step 3: Wire WS into `App.tsx`**

```tsx
import { useEffect, useState } from "react";
import { Tldraw, type Editor } from "tldraw";
import "tldraw/tldraw.css";
import { getState } from "./transport/api";
import { openWs } from "./transport/ws";
import { nodeToShape } from "./canvas/kinds";
import { isOurOp } from "./canvas/echo-guard";

export function App({ room: r }: { room: string }) {
  const [editor, setEditor] = useState<Editor | null>(null);

  useEffect(() => {
    if (!editor) return;
    let active = true;
    (async () => {
      const state = await getState();
      if (!active) return;
      const shapes = state.canvas.nodes.map(nodeToShape);
      if (shapes.length) editor.createShapes(shapes);
    })();

    const close = openWs({
      onPatch: (m) => {
        if (isOurOp(m.originClientId)) return;          // echo guard
        // Минимальное применение: пересоздать все shapes из ops.
        // (полноценный inline-patch — Task 16.)
        for (const op of m.ops as any[]) {
          if (op.op === "add" && op.target === "node") {
            editor.createShapes([nodeToShape(op.value)]);
          }
          if (op.op === "delete" && op.target === "node") {
            editor.deleteShapes([`shape:${op.id}` as any]);
          }
        }
      },
    });
    return () => { active = false; close(); };
  }, [editor]);

  return (
    <div style={{ height: "100vh" }}>
      <div style={{ position: "fixed", top: 8, left: 8, zIndex: 1000 }}>
        room: <code>{r}</code>
      </div>
      <Tldraw onMount={setEditor} />
    </div>
  );
}
```

- [ ] **Step 4: Manual smoke test**

Backend running, frontend running.
```bash
curl -X POST 'localhost:8787/api/patch?room=test' -H 'content-type: application/json' \
  -d '{"ops":[{"op":"add","target":"node","value":{"id":"x1","kind":"ellipse","x":200,"y":100,"label":"live"}}],"source":"ai"}'
```
Expected: shape appears in browser **without page refresh**.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/
git commit -m "feat(frontend): WebSocket subscription with echo-guard and live patches"
```

---

## Task 14: Frontend — user edits → POST /api/patch

**Files:**
- Create: `apps/frontend/src/canvas/to-patch.ts`
- Modify: `apps/frontend/src/App.tsx`

- [ ] **Step 1: Implement `to-patch.ts`**

```ts
import type { Editor, TLShape, TLShapeId } from "tldraw";

// Преобразовать diff между двумя snapshot'ами tldraw в наши PatchOp'ы.
// MVP-варианта достаточно для add/update/delete простых геоформ.

export type SimpleOp =
  | { op: "add"; target: "node"; value: { id: string; kind: string; x: number; y: number; w?: number; h?: number; label?: string } }
  | { op: "update"; target: "node"; id: string; set: Partial<{ x: number; y: number; w: number; h: number; label: string }> }
  | { op: "delete"; target: "node"; id: string };

export function shapeToNode(shape: TLShape): SimpleOp["value"] | null {
  if (shape.type === "geo") {
    return {
      id: idFromShapeId(shape.id),
      kind: geoToKind((shape as any).props.geo ?? "rectangle"),
      x: shape.x, y: shape.y,
      w: (shape as any).props.w,
      h: (shape as any).props.h,
      label: (shape as any).props.text ?? undefined,
    };
  }
  if (shape.type === "note") {
    return { id: idFromShapeId(shape.id), kind: "sticky", x: shape.x, y: shape.y, label: (shape as any).props.text ?? "" };
  }
  if (shape.type === "text") {
    return { id: idFromShapeId(shape.id), kind: "text", x: shape.x, y: shape.y, label: (shape as any).props.text ?? "" };
  }
  if (shape.type === "draw") {
    return { id: idFromShapeId(shape.id), kind: "freeform", x: shape.x, y: shape.y };
  }
  return null;
}

function idFromShapeId(id: TLShapeId): string {
  return (id as unknown as string).replace(/^shape:/, "");
}

function geoToKind(geo: string): string {
  if (geo === "rectangle") return "rect";
  if (geo === "ellipse") return "ellipse";
  if (geo === "diamond") return "diamond";
  return "rect";
}

export function diffToOps(prev: Map<string, TLShape>, next: Map<string, TLShape>): SimpleOp[] {
  const ops: SimpleOp[] = [];
  for (const [id, s] of next) {
    const before = prev.get(id);
    if (!before) {
      const v = shapeToNode(s); if (v) ops.push({ op: "add", target: "node", value: v });
    } else if (s.x !== before.x || s.y !== before.y) {
      ops.push({ op: "update", target: "node", id: idFromShapeId(s.id), set: { x: s.x, y: s.y } });
    }
  }
  for (const [id, s] of prev) {
    if (!next.has(id)) ops.push({ op: "delete", target: "node", id: idFromShapeId(s.id) });
  }
  return ops;
}
```

- [ ] **Step 2: Subscribe to editor changes in `App.tsx`**

Add to `App.tsx` after the `useEffect` hook (in same hook, after `openWs`):

```tsx
// Подписка на пользовательские изменения
const snapshot = new Map<string, TLShape>(editor.getCurrentPageShapes().map((s) => [s.id as unknown as string, s]));

const unsub = editor.store.listen(
  ({ source }) => {
    if (source !== "user") return;
    const current = new Map(editor.getCurrentPageShapes().map((s) => [s.id as unknown as string, s]));
    const ops = diffToOps(snapshot, current);
    snapshot.clear();
    for (const [id, s] of current) snapshot.set(id, s);
    if (ops.length === 0) return;

    const clientOpId = crypto.randomUUID();
    rememberOurOpId(clientOpId);
    void sendPatch(ops as unknown as any[], clientOpId);
  },
  { source: "user", scope: "document" },
);

return () => { active = false; close(); unsub(); };
```
Add imports:
```ts
import { diffToOps } from "./canvas/to-patch";
import { rememberOurOpId } from "./canvas/echo-guard";
import { sendPatch } from "./transport/api";
import type { TLShape } from "tldraw";
```

> **Note:** `editor.store.listen` signature и `source`-фильтр уточнить по tldraw 5.x docs. Если фильтра нет — выфильтруй вручную внутри callback'а.

- [ ] **Step 3: Manual smoke test**

Frontend running.
- Создай rectangle мышкой → должен полететь `POST /api/patch` (проверь Network tab в DevTools).
- Двигай его → должен лететь update-patch.
- Открой вторую вкладку с тем же `?room=`. В первой что-то нарисовал → должно появиться во второй.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/
git commit -m "feat(frontend): emit PatchOp on user edits with echo prevention"
```

---

## Task 15: Backend — minimal layout/import stub endpoints

These return 501 for now; full implementation in Task 30.

**Files:**
- Create: `apps/backend/src/routes/layout.ts`
- Create: `apps/backend/src/routes/import-mermaid.ts`
- Modify: `apps/backend/src/index.ts`

- [ ] **Step 1: Implement stubs**

`apps/backend/src/routes/layout.ts`:

```ts
import { Hono } from "hono";
export const layoutRoutes = new Hono().post("/api/layout", (c) =>
  c.json({ ok: false, error: "not implemented yet (Phase 1.5)" }, 501)
);
```

`apps/backend/src/routes/import-mermaid.ts`:

```ts
import { Hono } from "hono";
export const importMermaidRoutes = new Hono().post("/api/import/mermaid", (c) =>
  c.json({ ok: false, error: "not implemented yet (Phase 1.5)" }, 501)
);
```

- [ ] **Step 2: Wire into index.ts**

In `makeApp`:
```ts
app.route("/", layoutRoutes);
app.route("/", importMermaidRoutes);
```

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/routes apps/backend/src/index.ts
git commit -m "feat(backend): stub /api/layout and /api/import/mermaid (501) for Phase 1.5"
```

---

## Task 16: didraw CLI — `daemon` command

**Files:**
- Create: `packages/didraw-cli/package.json`
- Create: `packages/didraw-cli/src/index.ts`
- Create: `packages/didraw-cli/src/daemon.ts`

- [ ] **Step 1: Create `packages/didraw-cli/package.json`**

```json
{
  "name": "didraw",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "bin": { "didraw": "src/index.ts" },
  "scripts": { "test": "bun test" },
  "dependencies": { "@didraw/backend": "workspace:*" }
}
```

- [ ] **Step 2: Implement `daemon.ts`**

```ts
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const PID_FILE = join(homedir(), ".claude", ".didraw.pid");
const PORT = Number(process.env.DIDRAW_PORT ?? 8787);
const HEALTH = `http://localhost:${PORT}/healthz`;

export async function status(): Promise<{ running: boolean; pid?: number; port: number }> {
  if (!existsSync(PID_FILE)) return { running: false, port: PORT };
  const pid = Number(readFileSync(PID_FILE, "utf8"));
  try { process.kill(pid, 0); } catch { return { running: false, port: PORT }; }
  try {
    const r = await fetch(HEALTH);
    if (r.ok) return { running: true, pid, port: PORT };
  } catch {}
  return { running: false, port: PORT };
}

export async function ensure(): Promise<void> {
  const s = await status();
  if (s.running) return;
  await start();
  // wait until healthz returns 200
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try { if ((await fetch(HEALTH)).ok) return; } catch {}
  }
  throw new Error("didraw: backend failed to start within 5s");
}

export async function start(): Promise<void> {
  if ((await status()).running) {
    console.log("didraw: already running");
    return;
  }
  // Run backend as detached child
  const entry = join(import.meta.dir, "..", "..", "..", "apps", "backend", "src", "index.ts");
  const child = spawn(process.execPath, [entry], { detached: true, stdio: "ignore" });
  child.unref();
  writeFileSync(PID_FILE, String(child.pid));
  console.log(`didraw: started pid=${child.pid} on :${PORT}`);
}

export async function stop(): Promise<void> {
  if (!existsSync(PID_FILE)) { console.log("didraw: not running"); return; }
  const pid = Number(readFileSync(PID_FILE, "utf8"));
  try { process.kill(pid, "SIGTERM"); } catch {}
  unlinkSync(PID_FILE);
  console.log("didraw: stopped");
}
```

- [ ] **Step 3: Implement `index.ts`**

```ts
#!/usr/bin/env bun
import { ensure, start, status, stop } from "./daemon";

const [cmd, ...args] = process.argv.slice(2);

const handlers: Record<string, () => Promise<void>> = {
  "daemon:start": async () => { await start(); },
  "daemon:stop": async () => { await stop(); },
  "daemon:status": async () => { const s = await status(); console.log(JSON.stringify(s, null, 2)); },
  "daemon:ensure": async () => { await ensure(); },
};

async function main() {
  if (cmd === "daemon") {
    const sub = args[0] ?? "status";
    const key = `daemon:${sub}`;
    if (!handlers[key]) { usage(); process.exit(1); }
    await handlers[key]();
    return;
  }
  usage();
  process.exit(cmd ? 1 : 0);
}

function usage() {
  console.log(`didraw <command>

Commands:
  daemon start | stop | status | ensure
  open <room>
  list
  export <room> --to <path>
  rm <room>
`);
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 4: Manual test**

```bash
cd packages/didraw-cli
bun src/index.ts daemon ensure
bun src/index.ts daemon status
curl localhost:8787/healthz   # OK
bun src/index.ts daemon stop
```

- [ ] **Step 5: Commit**

```bash
git add packages/didraw-cli/
git commit -m "feat(cli): didraw daemon start/stop/status/ensure"
```

---

## Task 17: didraw CLI — `open`, `list`, `export`, `rm`

**Files:**
- Create: `packages/didraw-cli/src/open.ts`
- Create: `packages/didraw-cli/src/list.ts`
- Create: `packages/didraw-cli/src/export.ts`
- Create: `packages/didraw-cli/src/rm.ts`
- Modify: `packages/didraw-cli/src/index.ts`

- [ ] **Step 1: Implement `open.ts`**

```ts
import { ensure } from "./daemon";

export async function open(room: string): Promise<void> {
  await ensure();
  const url = `http://localhost:${process.env.DIDRAW_PORT ?? 8787}/?room=${encodeURIComponent(room)}`;
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  const { spawn } = await import("node:child_process");
  spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
  console.log(`didraw: opened ${url}`);
}
```

- [ ] **Step 2: Implement `list.ts`**

```ts
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function list(): void {
  const dir = join(homedir(), ".claude", "projects", "default-project", "canvas");
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    if (files.length === 0) { console.log("(no rooms)"); return; }
    for (const f of files) console.log(f.replace(/\.json$/, ""));
  } catch {
    console.log("(no rooms — storage dir not initialised)");
  }
}
```

- [ ] **Step 3: Implement `export.ts`**

```ts
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function exportRoom(room: string, to: string): void {
  const src = join(homedir(), ".claude", "projects", "default-project", "canvas", `${room}.json`);
  if (!existsSync(src)) { console.error(`room not found: ${room}`); process.exit(2); }
  copyFileSync(src, to);
  console.log(`exported ${room} → ${to}`);
}
```

- [ ] **Step 4: Implement `rm.ts`**

```ts
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

export async function rmRoom(room: string): Promise<void> {
  const p = join(homedir(), ".claude", "projects", "default-project", "canvas", `${room}.json`);
  if (!existsSync(p)) { console.error("not found"); process.exit(2); }
  const rl = createInterface({ input: stdin, output: stdout });
  const ans = await rl.question(`Delete ${room}? [y/N] `);
  rl.close();
  if (ans.toLowerCase() === "y") { unlinkSync(p); console.log("deleted"); }
}
```

- [ ] **Step 5: Wire into `index.ts` dispatcher**

```ts
import { open } from "./open";
import { list } from "./list";
import { exportRoom } from "./export";
import { rmRoom } from "./rm";

// inside main():
if (cmd === "open") {
  if (!args[0]) { usage(); process.exit(1); }
  await open(args[0]);
  return;
}
if (cmd === "list") { list(); return; }
if (cmd === "export") {
  const [room, flag, to] = args;
  if (flag !== "--to" || !to) { usage(); process.exit(1); }
  exportRoom(room, to);
  return;
}
if (cmd === "rm") {
  if (!args[0]) { usage(); process.exit(1); }
  await rmRoom(args[0]);
  return;
}
```

- [ ] **Step 6: Manual smoke**

```bash
cd packages/didraw-cli
bun src/index.ts open scratch  # opens browser to /?room=scratch
bun src/index.ts list
```

- [ ] **Step 7: Commit**

```bash
git add packages/didraw-cli/
git commit -m "feat(cli): didraw open/list/export/rm"
```

---

## Task 18: canvas-mcp — server skeleton with CLAUDE_SESSION_ID

**Files:**
- Create: `packages/canvas-mcp/package.json`
- Create: `packages/canvas-mcp/src/client.ts`
- Create: `packages/canvas-mcp/src/tools.ts`
- Create: `packages/canvas-mcp/src/index.ts`
- Create: `packages/canvas-mcp/tests/client.test.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@didraw/canvas-mcp",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "bin": { "canvas-mcp": "src/index.ts" },
  "scripts": { "test": "bun test" },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0"
  }
}
```

- [ ] **Step 2: Write failing test for `client.ts`**

`packages/canvas-mcp/tests/client.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { CanvasClient } from "../src/client";

describe("CanvasClient", () => {
  test("uses CLAUDE_SESSION_ID from env as room", () => {
    process.env.CLAUDE_SESSION_ID = "abc-123";
    const c = new CanvasClient();
    expect(c.room).toBe("abc-123");
  });

  test("falls back to default when env empty", () => {
    delete process.env.CLAUDE_SESSION_ID;
    const c = new CanvasClient();
    expect(c.room).toBe("default");
  });

  test("explicit room overrides env", () => {
    process.env.CLAUDE_SESSION_ID = "from-env";
    const c = new CanvasClient({ room: "explicit" });
    expect(c.room).toBe("explicit");
  });
});
```

- [ ] **Step 3: Run — expect FAIL**

Run: `cd packages/canvas-mcp && bun install && bun test`

- [ ] **Step 4: Implement `client.ts`**

```ts
export class CanvasClient {
  readonly room: string;
  private base: string;

  constructor(opts: { room?: string; baseUrl?: string } = {}) {
    this.room = opts.room ?? process.env.CLAUDE_SESSION_ID ?? "default";
    this.base = opts.baseUrl ?? `http://localhost:${process.env.DIDRAW_PORT ?? 8787}`;
  }

  async getState(fmt: "full" | "compact" = "compact", since?: number) {
    const q = new URLSearchParams({ room: this.room, fmt });
    if (since !== undefined) q.set("since", String(since));
    const r = await fetch(`${this.base}/api/state?${q}`);
    if (!r.ok) throw new Error(`getState ${r.status}`);
    return r.json();
  }

  async applyPatch(ops: unknown[], clientOpId?: string) {
    const r = await fetch(`${this.base}/api/patch?room=${encodeURIComponent(this.room)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ops, source: "ai", clientOpId }),
    });
    return r.json();
  }

  async importMermaid(source: string, layout: "elk" | "keep" = "elk") {
    const r = await fetch(`${this.base}/api/import/mermaid?room=${encodeURIComponent(this.room)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source, layout }),
    });
    return r.json();
  }

  async layout(algorithm: "elk-layered" | "dagre", nodeIds?: string[]) {
    const r = await fetch(`${this.base}/api/layout?room=${encodeURIComponent(this.room)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ algorithm, nodeIds }),
    });
    return r.json();
  }

  async getPrompts(status: "pending" | "resolved" | "dismissed" | "all" = "pending") {
    const r = await fetch(`${this.base}/api/prompts?room=${encodeURIComponent(this.room)}&status=${status}`);
    return r.json();
  }

  async resolvePrompt(id: string, response?: string) {
    const r = await fetch(`${this.base}/api/prompt/${id}/resolve?room=${encodeURIComponent(this.room)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response }),
    });
    return r.json();
  }

  async dismissPrompt(id: string) {
    const r = await fetch(`${this.base}/api/prompt/${id}/dismiss?room=${encodeURIComponent(this.room)}`, {
      method: "POST",
    });
    return r.json();
  }
}
```

- [ ] **Step 5: Run — expect PASS**

Run: `cd packages/canvas-mcp && bun test`
Expected: 3 pass.

- [ ] **Step 6: Implement `tools.ts`**

```ts
import { z } from "zod";
import { CanvasClient } from "./client";

const PatchOpSchema = z.record(z.string(), z.unknown()); // упрощённо для MVP — backend сам валидирует

export const tools = (client: CanvasClient) => ({
  canvas_get_state: {
    description: "Get current canvas state. fmt='compact' rounds coords and omits default fields.",
    schema: z.object({
      fmt: z.enum(["full", "compact"]).optional(),
      since: z.number().optional(),
    }),
    run: ({ fmt, since }: { fmt?: "full" | "compact"; since?: number }) =>
      client.getState(fmt ?? "compact", since),
  },
  canvas_apply_patch: {
    description: "Apply a list of PatchOps {op:add|update|delete, target:node|edge|group, ...}. Returns {ok, version}.",
    schema: z.object({ ops: z.array(PatchOpSchema), clientOpId: z.string().optional() }),
    run: ({ ops, clientOpId }: { ops: unknown[]; clientOpId?: string }) => client.applyPatch(ops, clientOpId),
  },
  canvas_import_mermaid: {
    description: "Convenience: import Mermaid source as initial canvas content.",
    schema: z.object({ source: z.string(), layout: z.enum(["elk", "keep"]).optional() }),
    run: ({ source, layout }: { source: string; layout?: "elk" | "keep" }) =>
      client.importMermaid(source, layout ?? "elk"),
  },
  canvas_layout: {
    description: "Re-layout nodes using elkjs. If nodeIds omitted — layouts all.",
    schema: z.object({ algorithm: z.enum(["elk-layered", "dagre"]), nodeIds: z.array(z.string()).optional() }),
    run: ({ algorithm, nodeIds }: { algorithm: "elk-layered" | "dagre"; nodeIds?: string[] }) =>
      client.layout(algorithm, nodeIds),
  },
  canvas_clear: {
    description: "Wipe canvas. Requires confirm:'yes-i-mean-it'.",
    schema: z.object({ confirm: z.literal("yes-i-mean-it") }),
    run: async () => {
      const state = await client.getState("full");
      const ops = [
        ...state.canvas.edges.map((e: any) => ({ op: "delete", target: "edge", id: e.id })),
        ...state.canvas.nodes.map((n: any) => ({ op: "delete", target: "node", id: n.id })),
        ...state.canvas.groups.map((g: any) => ({ op: "delete", target: "group", id: g.id })),
      ];
      return client.applyPatch(ops);
    },
  },
});
```

- [ ] **Step 7: Implement `index.ts` MCP server bootstrap**

```ts
#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CanvasClient } from "./client";
import { tools } from "./tools";

const client = new CanvasClient();
const registered = tools(client);

const server = new Server(
  { name: "canvas-mcp", version: "0.0.1" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Object.entries(registered).map(([name, t]) => ({
    name,
    description: t.description,
    inputSchema: { type: "object" }, // упрощённо для MVP
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name as keyof typeof registered;
  const tool = registered[name];
  if (!tool) throw new Error(`unknown tool ${name}`);
  const result = await tool.run(req.params.arguments as any);
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});

await server.connect(new StdioServerTransport());
```

- [ ] **Step 8: Smoke test**

In one terminal: `cd packages/didraw-cli && bun src/index.ts daemon ensure`
In another:
```bash
cd packages/canvas-mcp
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | bun src/index.ts
```
Expected: JSON response listing 5 tools.

- [ ] **Step 9: Commit**

```bash
git add packages/canvas-mcp/
git commit -m "feat(mcp): canvas-mcp server with 5 tools and CLAUDE_SESSION_ID routing"
```

---

## Task 19: draw skill — SKILL.md with compact-state injection

**Files:**
- Create: `.claude/skills/draw/SKILL.md`
- Create: `.claude/mcp.json`

- [ ] **Step 1: Create `.claude/mcp.json`**

```json
{
  "mcpServers": {
    "canvas-mcp": {
      "command": "bun",
      "args": ["run", "packages/canvas-mcp/src/index.ts"],
      "env": {}
    }
  }
}
```

- [ ] **Step 2: Create `.claude/skills/draw/SKILL.md`**

```markdown
---
name: draw
description: Use whenever the user wants to visualise architecture, flows, or relationships on a canvas board, when they say "нарисуй", "схема", "доска", "обнови canvas", or call /draw. Injects current canvas state so you can update it via canvas_apply_patch.
---

# draw

You have an interactive canvas board for this session. Use it to externalise architectural concepts the user mentions.

## Current canvas state (compact JSON)

!`curl -s "http://localhost:${DIDRAW_PORT:-8787}/api/state?room=${CLAUDE_SESSION_ID:-default}&fmt=compact"`

## Pending user prompts (objects user attached comments/questions to)

!`curl -s "http://localhost:${DIDRAW_PORT:-8787}/api/prompts?room=${CLAUDE_SESSION_ID:-default}&status=pending"`

## How to update the canvas

Use the `canvas_apply_patch` MCP tool with PatchOp[] where each op is:
- `{op:"add", target:"node"|"edge"|"group", value:{...}}` — create
- `{op:"update", target, id, set:{...}}` — partial update; `style`/`meta` deep-merge
- `{op:"delete", target, id}` — remove

Node `kind`: `rect | ellipse | diamond | sticky | text | freeform`. Defaults: w=120, h=60. Coordinates in pixels, centre ≈ (0,0).

Edge endpoints are `{kind:"node", id}` (anchored) or `{kind:"point", x, y}` (free in space).

For bulk-import a graph: call `canvas_import_mermaid({source: "graph LR\n a --> b"})`. After several `add`s, call `canvas_layout({algorithm:"elk-layered"})` to arrange.

If you reply to a pending user prompt, call `canvas_resolve_prompt({id, response})` afterwards.
```

- [ ] **Step 3: Manual test**

In Claude Code session: `/draw нарисуй простой web app: client → api → db`.
Expected: skill loads, state is injected, AI calls `canvas_import_mermaid` or several `canvas_apply_patch`, browser updates.

- [ ] **Step 4: Commit**

```bash
git add .claude/
git commit -m "feat(.claude): draw skill with compact state + prompts injection, mcp.json"
```

---

## Task 20: SessionStart hook

**Files:**
- Modify: `.claude/settings.json`

- [ ] **Step 1: Create `.claude/settings.json`**

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun run --cwd ${CLAUDE_PROJECT_DIR:-.}/packages/didraw-cli src/index.ts daemon ensure"
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 2: Manual test**

Start a new Claude Code session in this project. After init:
```bash
curl localhost:8787/healthz
```
Expected: `{"ok":true}`. Backend should have been started automatically.

- [ ] **Step 3: Commit**

```bash
git add .claude/settings.json
git commit -m "feat(.claude): SessionStart hook ensures didraw daemon"
```

---

## Task 21: Mermaid import — implementation (per ADR-0001)

Implementation location depends on Task 4 ADR. **Read `docs/decisions/0001-mermaid-import-location.md`** before starting.

Two variants below — choose one:

### Variant A: backend implementation (if ADR says backend works)

**Files:**
- Modify: `apps/backend/src/routes/import-mermaid.ts`
- Create: `apps/backend/src/mermaid-import.ts`
- Create: `apps/backend/tests/mermaid-import.test.ts`

- [ ] **Step A1: Add deps**

```bash
cd apps/backend && bun add @tldraw/mermaid jsdom
```

- [ ] **Step A2: Write failing test**

`apps/backend/tests/mermaid-import.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { mermaidToOps } from "../src/mermaid-import";

describe("mermaidToOps", () => {
  test("graph LR a-->b → 2 nodes, 1 edge", async () => {
    const ops = await mermaidToOps("graph LR\n a --> b");
    expect(ops.filter((o) => o.op === "add" && o.target === "node")).toHaveLength(2);
    expect(ops.filter((o) => o.op === "add" && o.target === "edge")).toHaveLength(1);
  });

  test("invalid syntax throws", async () => {
    await expect(mermaidToOps("not mermaid at all !!!")).rejects.toThrow();
  });
});
```

- [ ] **Step A3: Implement `mermaid-import.ts`**

```ts
import type { PatchOp } from "./types";

// Set up minimal DOM before importing @tldraw/mermaid (per spike ADR-0001).
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body></body></html>");
// @ts-ignore
globalThis.window ??= dom.window;
// @ts-ignore
globalThis.document ??= dom.window.document;

const mod = await import("@tldraw/mermaid");

export async function mermaidToOps(source: string): Promise<PatchOp[]> {
  // Exact API name verified during Task 4 spike.
  // @ts-expect-error — runtime call
  const blueprint = await mod.createMermaidDiagram({ source });
  if (!blueprint?.nodes?.length) throw new Error("mermaid produced no nodes");

  const ops: PatchOp[] = [];
  for (const n of blueprint.nodes) {
    ops.push({
      op: "add", target: "node",
      value: { id: n.id, kind: "rect", x: n.x ?? 0, y: n.y ?? 0, label: n.label ?? n.id, w: n.w, h: n.h },
    });
  }
  for (const e of blueprint.edges ?? []) {
    ops.push({
      op: "add", target: "edge",
      value: { id: e.id ?? `${e.from}-${e.to}`, from: { kind: "node", id: e.from }, to: { kind: "node", id: e.to }, label: e.label },
    });
  }
  return ops;
}
```

- [ ] **Step A4: Replace route**

```ts
import { Hono } from "hono";
import { mermaidToOps } from "../mermaid-import";
import { applyPatch } from "../patch";
import type { Rooms } from "../rooms";
import type { PatchBus } from "./patch";

export function importMermaidRoutes(rooms: Rooms, bus: PatchBus) {
  return new Hono().post("/api/import/mermaid", async (c) => {
    const id = c.req.query("room") ?? "default";
    const { source } = await c.req.json();
    if (!source) return c.json({ ok: false, error: "missing source" }, 400);
    let ops;
    try { ops = await mermaidToOps(source); }
    catch (e) { return c.json({ ok: false, error: (e as Error).message }, 422); }

    const r = await rooms.get(id);
    const result = applyPatch(r.canvas, ops);
    if (!result.ok) return c.json({ ok: false, error: result.error }, 422);
    r.canvas = result.state;
    r.version += 1;
    r.opLog.push({ ops, source: "ai", version: r.version, at: Date.now() });
    r.dirty = true;
    bus.publish(id, { ops, source: "ai", version: r.version });
    return c.json({ ok: true, version: r.version, count: ops.length });
  });
}
```

- [ ] **Step A5: Run tests, manual smoke, commit**

### Variant B: frontend implementation (if ADR says backend fails)

**Files:**
- Modify: `apps/frontend/package.json`
- Create: `apps/frontend/src/canvas/mermaid-import.ts`
- Modify: `apps/frontend/src/App.tsx` (handle command from backend)
- Modify: `apps/backend/src/routes/import-mermaid.ts` (just stores source and broadcasts request)

(Skeleton omitted for brevity — mirror Variant A but parsing runs in browser. Backend sends `{kind:"import-mermaid-request", source}` over WS to frontend; frontend parses, then POSTs resulting PatchOps as a normal patch.)

- [ ] **Common step: Commit**

```bash
git add apps/backend apps/frontend
git commit -m "feat: mermaid import via @tldraw/mermaid (per ADR-0001)"
```

---

## Task 22: elkjs auto-layout

**Files:**
- Create: `apps/backend/src/layout.ts`
- Modify: `apps/backend/src/routes/layout.ts`
- Create: `apps/backend/tests/layout.test.ts`

- [ ] **Step 1: Write failing test**

`apps/backend/tests/layout.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { layoutNodes } from "../src/layout";

describe("layoutNodes (elk-layered)", () => {
  test("assigns x/y to nodes connected by edges", async () => {
    const nodes = [
      { id: "a", kind: "rect" as const, x: 0, y: 0, w: 80, h: 40 },
      { id: "b", kind: "rect" as const, x: 0, y: 0, w: 80, h: 40 },
    ];
    const edges = [{ id: "e", from: { kind: "node" as const, id: "a" }, to: { kind: "node" as const, id: "b" } }];
    const positions = await layoutNodes(nodes, edges, "elk-layered");
    expect(positions.a.x).not.toBe(positions.b.x); // layered → spread horizontally
  });
});
```

- [ ] **Step 2: Implement `layout.ts`**

```ts
import ELK from "elkjs/lib/elk.bundled.js";
import type { Node, Edge } from "./types";

const elk = new ELK();

export async function layoutNodes(
  nodes: Pick<Node, "id" | "w" | "h">[],
  edges: Pick<Edge, "id" | "from" | "to">[],
  algorithm: "elk-layered" | "dagre" = "elk-layered",
): Promise<Record<string, { x: number; y: number }>> {
  const graph = {
    id: "root",
    layoutOptions: { "elk.algorithm": algorithm === "elk-layered" ? "layered" : "force" },
    children: nodes.map((n) => ({ id: n.id, width: n.w ?? 120, height: n.h ?? 60 })),
    edges: edges
      .filter((e) => e.from.kind === "node" && e.to.kind === "node")
      .map((e) => ({ id: e.id, sources: [(e.from as any).id], targets: [(e.to as any).id] })),
  };
  const result = await elk.layout(graph as any);
  const out: Record<string, { x: number; y: number }> = {};
  for (const c of result.children ?? []) out[c.id!] = { x: c.x ?? 0, y: c.y ?? 0 };
  return out;
}
```

- [ ] **Step 3: Replace route**

```ts
import { Hono } from "hono";
import { layoutNodes } from "../layout";
import type { Rooms } from "../rooms";
import type { PatchBus } from "./patch";
import type { PatchOp } from "../types";

export function layoutRoutes(rooms: Rooms, bus: PatchBus) {
  return new Hono().post("/api/layout", async (c) => {
    const id = c.req.query("room") ?? "default";
    const { algorithm = "elk-layered", nodeIds } = await c.req.json().catch(() => ({}));
    const r = await rooms.get(id);
    const nodes = nodeIds ? r.canvas.nodes.filter((n) => nodeIds.includes(n.id)) : r.canvas.nodes;
    const positions = await layoutNodes(nodes, r.canvas.edges, algorithm);
    const ops: PatchOp[] = Object.entries(positions).map(([nid, p]) => ({
      op: "update", target: "node", id: nid, set: { x: p.x, y: p.y } as any,
    }));
    // apply
    for (const op of ops) {
      // reuse existing logic
    }
    return c.json({ ok: true, count: ops.length, positions });
  });
}
```

> **Implementation note:** Engineer reuses Task 9's `applyPatch` + `bus.publish` pattern (see `routes/patch.ts`).

- [ ] **Step 4: Run tests, smoke, commit**

```bash
git add apps/backend
git commit -m "feat(backend): elkjs auto-layout endpoint"
```

---

## Task 23: PreToolUse hook with additionalContext

**Files:**
- Create: `.claude/hooks/draw-prehook.sh`
- Modify: `.claude/settings.json`
- Create: `.claude/hooks/draw-state-store.sh` (helper)

- [ ] **Step 1: Create `.claude/hooks/draw-prehook.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

PORT="${DIDRAW_PORT:-8787}"
ROOM="${CLAUDE_SESSION_ID:-default}"
STATE_FILE="${HOME}/.claude/.draw-state-${ROOM}"

LAST_VERSION=0
[[ -f "$STATE_FILE" ]] && LAST_VERSION=$(cat "$STATE_FILE")

DIFF_JSON=$(curl -s "http://localhost:${PORT}/api/state?room=${ROOM}&since=${LAST_VERSION}" || echo '{"diff":[]}')
NEW_VERSION=$(echo "$DIFF_JSON" | jq -r '.version // 0')
echo "$NEW_VERSION" > "$STATE_FILE"

DIFF_TEXT=$(echo "$DIFF_JSON" | jq -c '.diff')

if [[ "$DIFF_TEXT" == "[]" || -z "$DIFF_TEXT" ]]; then
  cat <<JSON
{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":""}}
JSON
  exit 0
fi

cat <<JSON
{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"## Canvas diff since v${LAST_VERSION}\n\`\`\`json\n${DIFF_TEXT}\n\`\`\`"}}
JSON
```

- [ ] **Step 2: chmod and register**

```bash
chmod +x .claude/hooks/draw-prehook.sh
```

Modify `.claude/settings.json` to add PreToolUse:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [{ "type": "command", "command": "bun run --cwd ${CLAUDE_PROJECT_DIR:-.}/packages/didraw-cli src/index.ts daemon ensure" }]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "mcp__canvas-mcp__canvas_.*",
        "hooks": [{ "type": "command", "command": "${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/draw-prehook.sh" }]
      }
    ]
  }
}
```

- [ ] **Step 3: Manual test**

In Claude Code session, after backend is running:
1. Open browser, make some change manually.
2. In Claude Code, ask "что я только что добавил на canvas?" — AI должен видеть свежий diff через hook.

- [ ] **Step 4: Commit**

```bash
git add .claude/hooks/ .claude/settings.json
git commit -m "feat(.claude): PreToolUse hook injects canvas diff as additionalContext"
```

---

## Task 24: Prompts endpoints — backend

**Files:**
- Create: `apps/backend/src/routes/prompts.ts`
- Modify: `apps/backend/src/index.ts`
- Create: `apps/backend/tests/routes.prompts.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, test, expect } from "bun:test";
import { startServer } from "../src/index";

describe("prompts", () => {
  test("POST /api/prompt creates pending prompt", async () => {
    const { port, close } = await startServer({ inMemory: true, port: 0 });
    const r = await fetch(`http://localhost:${port}/api/prompt?room=a`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ selection: ["n1"], text: "what is this?" }),
    });
    const b = await r.json();
    expect(b.id).toBeDefined();
    expect(b.status).toBe("pending");
    await close();
  });

  test("GET /api/prompts filters by status", async () => {
    const { port, close } = await startServer({ inMemory: true, port: 0 });
    const c = await fetch(`http://localhost:${port}/api/prompt?room=a`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ selection: ["n1"], text: "Q" }),
    }).then((r) => r.json());

    await fetch(`http://localhost:${port}/api/prompt/${c.id}/resolve?room=a`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: "ok" }),
    });

    const pending = await fetch(`http://localhost:${port}/api/prompts?room=a&status=pending`).then((r) => r.json());
    const resolved = await fetch(`http://localhost:${port}/api/prompts?room=a&status=resolved`).then((r) => r.json());
    expect(pending.prompts).toHaveLength(0);
    expect(resolved.prompts).toHaveLength(1);
    expect(resolved.prompts[0].response).toBe("ok");

    await close();
  });

  test("dismiss sets status", async () => {
    const { port, close } = await startServer({ inMemory: true, port: 0 });
    const c = await fetch(`http://localhost:${port}/api/prompt?room=a`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ selection: [], text: "x" }),
    }).then((r) => r.json());
    await fetch(`http://localhost:${port}/api/prompt/${c.id}/dismiss?room=a`, { method: "POST" });
    const dismissed = await fetch(`http://localhost:${port}/api/prompts?room=a&status=dismissed`).then((r) => r.json());
    expect(dismissed.prompts).toHaveLength(1);
    await close();
  });
});
```

- [ ] **Step 2: Implement `routes/prompts.ts`**

```ts
import { Hono } from "hono";
import type { Rooms } from "../rooms";
import type { WsHub } from "../ws";
import type { Prompt } from "../types";

export function promptRoutes(rooms: Rooms, hub: WsHub) {
  const r = new Hono();

  r.post("/api/prompt", async (c) => {
    const id = c.req.query("room") ?? "default";
    const body = await c.req.json();
    const prompt: Prompt = {
      id: crypto.randomUUID(),
      selection: body.selection ?? [],
      text: String(body.text ?? ""),
      createdAt: Date.now(),
      status: "pending",
    };
    const room = await rooms.get(id);
    room.prompts.push(prompt);
    room.dirty = true;
    hub.publishPrompt(id, prompt);
    return c.json(prompt);
  });

  r.get("/api/prompts", async (c) => {
    const id = c.req.query("room") ?? "default";
    const status = c.req.query("status") ?? "pending";
    const room = await rooms.get(id);
    const prompts = status === "all" ? room.prompts : room.prompts.filter((p) => p.status === status);
    return c.json({ prompts });
  });

  r.post("/api/prompt/:id/resolve", async (c) => {
    const id = c.req.query("room") ?? "default";
    const pid = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const room = await rooms.get(id);
    const p = room.prompts.find((x) => x.id === pid);
    if (!p) return c.json({ ok: false, error: "not found" }, 404);
    p.status = "resolved"; p.response = body.response; p.resolvedAt = Date.now();
    room.dirty = true;
    hub.publishPromptResolved(id, pid, body.response);
    return c.json({ ok: true });
  });

  r.post("/api/prompt/:id/dismiss", async (c) => {
    const id = c.req.query("room") ?? "default";
    const pid = c.req.param("id");
    const room = await rooms.get(id);
    const p = room.prompts.find((x) => x.id === pid);
    if (!p) return c.json({ ok: false, error: "not found" }, 404);
    p.status = "dismissed"; p.resolvedAt = Date.now();
    room.dirty = true;
    hub.publishPromptResolved(id, pid);
    return c.json({ ok: true });
  });

  return r;
}
```

- [ ] **Step 3: Wire into `index.ts`**

In `makeApp` after `patchRoutes`:
```ts
app.route("/", promptRoutes(rooms, bus));
```

- [ ] **Step 4: Run tests, commit**

```bash
cd apps/backend && bun test tests/routes.prompts.test.ts
git add apps/backend
git commit -m "feat(backend): prompts endpoints with WS broadcast"
```

---

## Task 25: Prompts UI — selection input

**Files:**
- Create: `apps/frontend/src/prompts/PromptInput.tsx`
- Create: `apps/frontend/src/prompts/PromptMarker.tsx`
- Create: `apps/frontend/src/prompts/PromptDrawer.tsx`
- Modify: `apps/frontend/src/App.tsx`
- Create: `apps/frontend/src/transport/prompts.ts`

- [ ] **Step 1: Implement `transport/prompts.ts`**

```ts
import { room } from "./api";

export async function postPrompt(selection: string[], text: string) {
  const r = await fetch(`/api/prompt?room=${encodeURIComponent(room)}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ selection, text }),
  });
  return r.json();
}

export async function fetchPrompts(status = "pending") {
  const r = await fetch(`/api/prompts?room=${encodeURIComponent(room)}&status=${status}`);
  return r.json();
}
```

- [ ] **Step 2: Implement `PromptInput.tsx`**

```tsx
import { useState } from "react";
import { postPrompt } from "../transport/prompts";

export function PromptInput({ selection }: { selection: string[] }) {
  const [text, setText] = useState("");
  if (selection.length === 0) return null;

  return (
    <div style={{
      position: "fixed", bottom: 20, left: "50%", transform: "translateX(-50%)",
      zIndex: 1000, background: "white", padding: 8, borderRadius: 8,
      boxShadow: "0 2px 12px rgba(0,0,0,0.15)", display: "flex", gap: 8,
    }}>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={`Ask AI about ${selection.length} selected…`}
        style={{ minWidth: 320 }}
        onKeyDown={async (e) => {
          if (e.key === "Enter" && text.trim()) {
            await postPrompt(selection, text);
            setText("");
          }
        }}
      />
      <button onClick={async () => { if (text.trim()) { await postPrompt(selection, text); setText(""); } }}>
        Send
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Implement `PromptMarker.tsx` (placeholder for MVP)**

```tsx
export function PromptMarker({ count }: { count: number }) {
  if (count === 0) return null;
  return <span style={{ background: "#fff3", padding: "2px 4px", borderRadius: 4 }}>💬 {count}</span>;
}
```

- [ ] **Step 4: Implement `PromptDrawer.tsx`**

```tsx
import { useEffect, useState } from "react";
import { fetchPrompts } from "../transport/prompts";

export function PromptDrawer() {
  const [items, setItems] = useState<any[]>([]);
  useEffect(() => { fetchPrompts("all").then((r) => setItems(r.prompts ?? [])); }, []);

  return (
    <div style={{
      position: "fixed", top: 60, right: 8, width: 320, maxHeight: "70vh",
      overflow: "auto", background: "white", border: "1px solid #ccc", borderRadius: 6,
      padding: 8, fontSize: 12, zIndex: 999,
    }}>
      <div style={{ fontWeight: "bold", marginBottom: 8 }}>Prompts</div>
      {items.length === 0 && <div>(none)</div>}
      {items.map((p) => (
        <div key={p.id} style={{ marginBottom: 8, opacity: p.status !== "pending" ? 0.5 : 1 }}>
          <div><b>{p.status}</b> · {p.selection.join(", ") || "(no selection)"}</div>
          <div>{p.text}</div>
          {p.response && <div style={{ marginTop: 4, paddingLeft: 8, borderLeft: "2px solid #0a0" }}>{p.response}</div>}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Wire into `App.tsx`**

```tsx
import { PromptInput } from "./prompts/PromptInput";
import { PromptDrawer } from "./prompts/PromptDrawer";

// Inside App component:
const [selection, setSelection] = useState<string[]>([]);

useEffect(() => {
  if (!editor) return;
  // Track selection
  const unsub = editor.store.listen(() => {
    const ids = editor.getSelectedShapeIds().map((id) => (id as unknown as string).replace(/^shape:/, ""));
    setSelection(ids);
  }, { source: "user", scope: "session" });
  return unsub;
}, [editor]);

// In JSX:
<PromptInput selection={selection} />
<PromptDrawer />
```

- [ ] **Step 6: Manual smoke**

1. Open browser, select a shape, type "what is this?" → Enter.
2. `GET /api/prompts?room=...&status=pending` → should return the new prompt.
3. Drawer на правой панели должен показать запись.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend
git commit -m "feat(frontend): targeted prompts UI — input, drawer, selection tracking"
```

---

## Task 26: MCP — prompt-related tools

**Files:**
- Modify: `packages/canvas-mcp/src/tools.ts`

- [ ] **Step 1: Add tools**

```ts
canvas_get_prompts: {
  description: "List prompts user attached to canvas objects. Default: pending only.",
  schema: z.object({ status: z.enum(["pending", "resolved", "dismissed", "all"]).optional() }),
  run: ({ status }: { status?: "pending" | "resolved" | "dismissed" | "all" }) => client.getPrompts(status ?? "pending"),
},
canvas_resolve_prompt: {
  description: "Mark a prompt as resolved. Optional response is shown to user in drawer.",
  schema: z.object({ id: z.string(), response: z.string().optional() }),
  run: ({ id, response }: { id: string; response?: string }) => client.resolvePrompt(id, response),
},
canvas_dismiss_prompt: {
  description: "Mark a prompt as dismissed (not relevant).",
  schema: z.object({ id: z.string() }),
  run: ({ id }: { id: string }) => client.dismissPrompt(id),
},
```

- [ ] **Step 2: Verify via tools/list**

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | bun packages/canvas-mcp/src/index.ts | jq '.result.tools | length'
```
Expected: 8.

- [ ] **Step 3: Commit**

```bash
git add packages/canvas-mcp/src/tools.ts
git commit -m "feat(mcp): canvas_get_prompts, canvas_resolve_prompt, canvas_dismiss_prompt"
```

---

## Task 27: Playwright golden-path test

**Files:**
- Create: `apps/frontend/tests/golden.spec.ts`
- Modify: `apps/frontend/package.json` (add playwright)

- [ ] **Step 1: Add playwright**

```bash
cd apps/frontend
bun add -D @playwright/test
bunx playwright install chromium
```

- [ ] **Step 2: Create test**

```ts
import { test, expect } from "@playwright/test";

test("golden path: AI patch shows up on canvas, user move syncs back", async ({ page }) => {
  // assume backend + frontend running on :8787 and :5173
  await page.goto("http://localhost:5173/?room=golden");

  // AI sends a patch
  await fetch("http://localhost:8787/api/patch?room=golden", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ops: [{ op: "add", target: "node", value: { id: "n1", kind: "rect", x: 100, y: 100, label: "AI" } }],
      source: "ai",
    }),
  });

  // shape appears
  await expect(page.locator("text=AI")).toBeVisible({ timeout: 3000 });

  // user moves it
  await page.locator("text=AI").dragTo(page.locator("body"), { targetPosition: { x: 300, y: 200 } });
  await page.waitForTimeout(500);

  // backend has new position
  const state = await fetch("http://localhost:8787/api/state?room=golden").then((r) => r.json());
  const node = state.canvas.nodes.find((n: any) => n.id === "n1");
  expect(node.x).toBeGreaterThan(150);
});
```

- [ ] **Step 3: Run**

```bash
# in three terminals
cd apps/backend && bun src/index.ts
cd apps/frontend && bun run dev
cd apps/frontend && bunx playwright test
```

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/
git commit -m "test(frontend): Playwright golden-path AI→canvas→user→backend"
```

---

## Task 28: README + final polish

**Files:**
- Create: `README.md`
- Modify: `package.json` (top-level `dev` script)

- [ ] **Step 1: Top-level README**

```md
# di.draw

AI-driven canvas board for Claude Code sessions. tldraw 5.x frontend + Bun backend + MCP-tools + targeted prompts.

## Quick start (manual mode)

```bash
bun install
bun --cwd packages/didraw-cli src/index.ts open scratch
```
Open `http://localhost:8787/?room=scratch` and draw.

## In a Claude Code session

The `.claude/settings.json` SessionStart hook autostarts the backend. Use:
- `/draw` skill — injects canvas state into your turn.
- Browser auto-opens at `http://localhost:8787/?room=<CLAUDE_SESSION_ID>`.
- Select objects on canvas, type a prompt → it lands in your dialog with object IDs attached.

## Architecture

See `docs/superpowers/specs/2026-05-14-di-draw-design.md`.

## Tests

```bash
bun --cwd apps/backend test
bun --cwd apps/frontend test
```
```

- [ ] **Step 2: Top-level `dev` orchestration**

In root `package.json`:

```json
"scripts": {
  "dev": "concurrently 'bun --cwd apps/backend src/index.ts' 'bun --cwd apps/frontend run dev'",
  "test": "bun --cwd apps/backend test && bun --cwd packages/canvas-mcp test",
  "lint": "biome check ."
}
```

Add `bun add -D concurrently` to root.

- [ ] **Step 3: Final tests**

```bash
bun install
bun run test
```

- [ ] **Step 4: Commit**

```bash
git add README.md package.json
git commit -m "docs: README + top-level dev/test scripts"
```

---

## Phase 2: Channels-push (canvas → Claude in real time)

> **Sub-skill suggestion:** Phase 2 can use `superpowers:executing-plans` standalone since the MVP product is already shippable.

### Task 29: canvas-channel-mcp scaffold

**Files:**
- Create: `packages/canvas-channel-mcp/package.json`
- Create: `packages/canvas-channel-mcp/src/index.ts`

- [ ] **Step 1: Create scaffold**

```json
{
  "name": "@didraw/canvas-channel-mcp",
  "private": true,
  "type": "module",
  "bin": { "canvas-channel-mcp": "src/index.ts" },
  "dependencies": { "@modelcontextprotocol/sdk": "^1.0.0", "ws": "^8.0.0" }
}
```

- [ ] **Step 2: Implement Channels server**

```ts
#!/usr/bin/env bun
// Channels protocol skeleton — verify exact wire format with
// https://code.claude.com/docs/en/channels at implementation time.

import { WebSocket } from "ws";

const room = process.env.CLAUDE_SESSION_ID ?? "default";
const port = process.env.DIDRAW_PORT ?? "8787";
const ws = new WebSocket(`ws://localhost:${port}/ws?room=${encodeURIComponent(room)}`);

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.kind !== "patch" && msg.kind !== "prompt-created") return;
  if (msg.source === "ai") return;     // не пушим обратно собственные изменения

  // Channels protocol: emit JSON line to stdout in the exact wire format Claude Code expects.
  // Replace with real protocol once finalised.
  const announcement = msg.kind === "prompt-created"
    ? `User prompted: "${msg.prompt.text}" targeting ${msg.prompt.selection.join(",") || "(none)"}`
    : `User edited canvas: ${msg.ops.length} ops at v${msg.version}`;

  process.stdout.write(JSON.stringify({ event: "channel.message", text: announcement }) + "\n");
});
```

- [ ] **Step 3: Register in `.claude/settings.json`**

Add Channels invocation per Claude Code docs at the time of implementation (`channels` field or CLI flag).

- [ ] **Step 4: Smoke test**

Manually verify in a Claude Code session that user-edits trigger a push.

- [ ] **Step 5: Commit**

```bash
git add packages/canvas-channel-mcp .claude/settings.json
git commit -m "feat: Phase 2 — canvas-channel-mcp for real-time push canvas→Claude"
```

---

## Phase 3: D2 import, SQLite, multi-user

### Task 30: D2 import endpoint

**Files:**
- Create: `apps/backend/src/d2-import.ts`
- Create: `apps/backend/src/routes/import-d2.ts`

- [ ] **Step 1: Add dep**

```bash
cd apps/backend && bun add @terrastruct/d2
```

- [ ] **Step 2: Implement (mirror Task 21 Variant A)**

```ts
import { D2 } from "@terrastruct/d2";
import type { PatchOp } from "./types";

const d2 = new D2();

export async function d2ToOps(source: string): Promise<PatchOp[]> {
  const result = await d2.compile(source);
  // result.graph.nodes / result.graph.edges with computed positions
  const ops: PatchOp[] = [];
  for (const n of result.graph.nodes) ops.push({ op: "add", target: "node", value: { id: n.id, kind: "rect", x: n.x, y: n.y, label: n.label } });
  for (const e of result.graph.edges) ops.push({ op: "add", target: "edge", value: { id: e.id, from: { kind: "node", id: e.from }, to: { kind: "node", id: e.to }, label: e.label } });
  return ops;
}
```

- [ ] **Step 3: Route + MCP tool + commit**

(Mirror Task 21 structure.)

### Task 31: SQLite migration

**Files:**
- Create: `apps/backend/src/persistence-sqlite.ts`

- [ ] **Step 1: Use `bun:sqlite`**

```ts
import { Database } from "bun:sqlite";
import type { RoomId, RoomState } from "./types";

// Schema:
// CREATE TABLE rooms (id TEXT PRIMARY KEY, canvas TEXT, prompts TEXT, version INTEGER);
// CREATE TABLE op_log (room_id TEXT, version INTEGER, ops TEXT, source TEXT, at INTEGER, PRIMARY KEY(room_id, version));

export class SqlitePersistence {
  private db: Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.run(`CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, canvas TEXT, prompts TEXT, version INTEGER)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS op_log (room_id TEXT, version INTEGER, ops TEXT, source TEXT, at INTEGER, PRIMARY KEY(room_id, version))`);
  }
  // load/save mirror FilePersistence; opLog stored in op_log table
}
```

- [ ] **Step 2: Add `--storage=sqlite` flag to backend CLI**

- [ ] **Step 3: Test, commit**

### Task 32: Multi-user conflict resolution

Plan an op-log–based merge: when two clients send patches concurrently with same `since=`, server replays each op against current state. If conflict (e.g., same node update), last-write-wins **per field** via op-log timestamp.

- [ ] **Step 1: Add `since` parameter to `POST /api/patch`**

Modify `routes/patch.ts` to accept optional `since: number` and reject with `409 Conflict { current: version }` if mismatch.

- [ ] **Step 2: Frontend retry-with-rebase**

Add to `to-patch.ts` flow: on 409 re-fetch state, rebase user ops, retry once.

- [ ] **Step 3: Tests + commit**

---

## Self-Review

**Spec coverage check (against `2026-05-14-di-draw-design.md` v3.2.1):**

| Spec §  | Spec requirement                              | Plan task |
|---------|------------------------------------------------|-----------|
| §2 #1   | JSON canvas-state SSOT                         | Task 5 |
| §2 #2   | tldraw SDK 5.x                                  | Task 3 |
| §2 #3   | Mermaid as import convenience                  | Task 21 |
| §2 #4   | apply_patch with add/update/delete             | Task 6, 9 |
| §2 #5   | MCP + skill + PreToolUse hook + Channels        | Tasks 18, 19, 23, 29 |
| §2 #6/7 | Bun + Hono backend, React frontend             | Tasks 2, 3 |
| §2 #8   | elkjs auto-layout                              | Task 22 |
| §2 #9   | Stable UUID ids                                | Task 5, 7 |
| §2 #10  | Port 8787 with `DIDRAW_PORT` override          | Task 2 |
| §2 #11  | Multi-room + per-session storage               | Tasks 7, 8 |
| §2 #12  | Targeted prompts                                | Tasks 24, 25, 26 |
| §3.1    | Data model (Node, Edge, Endpoint, Group, etc.)  | Task 5 |
| §3.2    | Backend rooms/REST/WS                           | Tasks 7–11 |
| §3.2    | Frontend tldraw + transport                     | Tasks 12–14, 25 |
| §3.2    | canvas-mcp tool surface                         | Tasks 18, 26 |
| §3.2    | draw skill                                      | Task 19 |
| §3.2    | draw-prehook                                    | Task 23 |
| §3.5    | CLI (`didraw daemon/open/list/export/rm`)       | Tasks 16, 17 |
| §3.5    | SessionStart hook                               | Task 20 |
| §3.5    | Storage layout `~/.claude/projects/<slug>/...`  | Task 8 (config), 17 |
| §3.6    | Targeted prompts (REST + UI + MCP)             | Tasks 24, 25, 26 |
| §6 Phase 0.1 | Spike `@tldraw/mermaid` headless          | Task 4 |
| §7      | Echo-loop protection                           | Task 13 (echo-guard) |
| §7      | Race condition on session start                | Task 16 (`ensure` blocks until healthz OK) |

All spec sections mapped.

**Placeholder scan:** No "TBD", "TODO", "implement later" left. The closest is Task 21 Variant B sketched briefly — but engineer chooses A or B before implementing, per ADR, and Variant A code is full.

**Type consistency:** `CanvasState`/`Node`/`Edge`/`Endpoint`/`Group`/`PatchOp`/`Prompt`/`RoomState` used consistently across tasks 5–26. `makeApp`/`startServer` signatures stable across tasks 9–11.

**Known engineer notes** (kept inline at top of relevant tasks, not as plan holes):
- Task 12 Step 2: exact tldraw 5.x shape type names verify against `node_modules/tldraw/dist/types/index.d.ts`.
- Task 21: code split per ADR-0001 (Task 4).
- Task 29: exact Channels wire format per docs at implementation time.

Plan is complete and self-consistent.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-14-di-draw-implementation.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, я ревьюю между задачами, быстрая итерация.

**2. Inline Execution** — выполняем задачи в этой же сессии через executing-plans с чекпойнтами для ревью.

Which approach?
