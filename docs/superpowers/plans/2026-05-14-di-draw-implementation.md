# di.draw — Implementation Plan (v4, CLI-first + distribution + release-binary ready)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Построить локальный AI-driven canvas board для Claude Code: tldraw 5.x frontend + Bun backend с multi-room state + `didraw` CLI как стабильный machine interface + skill cheat-sheet (Bash-вызовы) + hooks. MCP-adapter — Phase 2 как тонкая обёртка над тем же client'ом.

**Architecture:**
- **Core:** Bun-процесс на `:8787` хранит `Map<RoomId, RoomState>`, REST + WebSocket API. Каждая комната — per-session JSON-документ в `~/.claude/projects/<slug>/canvas/<room>.json`.
- **Machine interface:** `didraw` CLI — обёртка над shared `didraw-client` (тот же HTTP client). Используется и AI (через Bash + skill), и человеком, и тестами, и будущим MCP-adapter'ом.
- **AI ↔ canvas (MVP):** skill инжектит state + cheat-sheet с didraw-командами; AI вызывает `didraw patch --stdin` через Bash; PreToolUse hook добавляет diff в `additionalContext`.
- **AI ↔ canvas (Phase 2):** MCP-adapter добавляет typed-tools поверх того же client'а; Channels добавляет real-time push.

**Tech Stack:**
- **Backend:** Bun 1.x, Hono, ws, elkjs, bun:test
- **Frontend:** React 18, tldraw SDK 5.x, `@tldraw/mermaid`, Vite, TypeScript
- **CLI:** Bun-script с shebang `#!/usr/bin/env bun`
- **Shared client:** `packages/didraw-client` — один HTTP-клиент для CLI/MCP/тестов
- **MCP (Phase 2.1):** `@modelcontextprotocol/sdk` поверх `didraw-client`
- **Tests:** bun:test (backend, CLI, client), Playwright (UI smoke)
- **Lint/format:** biome

**Spec:** `docs/superpowers/specs/2026-05-14-di-draw-design.md` (v3.6)

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
│   │   │   ├── types.ts                      # CanvasState, Node, Edge, Endpoint, Group, PatchOp, Prompt, RoomState
│   │   │   ├── patch.ts                      # applyPatch(state, ops): pure function
│   │   │   ├── rooms.ts                      # Map<RoomId, RoomState>, lazy-load, LRU
│   │   │   ├── persistence.ts                # autosave debounce, load on first touch
│   │   │   ├── ws.ts                         # WsHub: per-room broadcast
│   │   │   ├── routes/
│   │   │   │   ├── health.ts
│   │   │   │   ├── state.ts                  # GET /api/state
│   │   │   │   ├── patch.ts                  # POST /api/patch
│   │   │   │   ├── import-mermaid.ts         # POST /api/import/mermaid (Phase 1.6)
│   │   │   │   ├── layout.ts                 # POST /api/layout (Phase 1.6)
│   │   │   │   └── prompts.ts                # POST /api/prompt* (Phase 1.8)
│   │   │   ├── mermaid-import.ts             # @tldraw/mermaid → PatchOp[] (per ADR-0001)
│   │   │   └── layout-engine.ts              # elkjs wrapper (Phase 1.6)
│   │   └── tests/
│   ├── frontend/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── vite.config.ts
│   │   ├── index.html
│   │   └── src/
│   │       ├── main.tsx
│   │       ├── App.tsx
│   │       ├── transport/
│   │       │   ├── api.ts
│   │       │   ├── ws.ts
│   │       │   └── prompts.ts                # Phase 1.8
│   │       ├── canvas/
│   │       │   ├── kinds.ts
│   │       │   ├── from-canvas-state.ts
│   │       │   ├── to-patch.ts
│   │       │   └── echo-guard.ts
│   │       ├── prompts/                      # Phase 1.8
│   │       │   ├── PromptInput.tsx
│   │       │   ├── PromptMarker.tsx
│   │       │   └── PromptDrawer.tsx
│   │       └── styles.css
│   └── frontend-tests/
│       └── golden.spec.ts                    # Playwright
├── packages/
│   ├── didraw-client/                        # shared HTTP client
│   │   ├── package.json
│   │   └── src/index.ts                      # CanvasClient class
│   ├── didraw-cli/                           # didraw CLI
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts                      # command dispatcher
│   │       ├── daemon.ts                     # daemon start/stop/status/ensure
│   │       ├── lifecycle.ts                  # open/list/export/rm
│   │       ├── data.ts                       # state/patch/clear
│   │       ├── import.ts                     # import mermaid (Phase 1.6)
│   │       ├── layout.ts                     # layout (Phase 1.6)
│   │       └── prompts.ts                    # prompts list/resolve/dismiss (Phase 1.8)
│   ├── canvas-mcp/                           # Phase 2.1
│   └── canvas-channel-mcp/                   # Phase 2.2
├── .claude/
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
│       └── 0001-mermaid-import-location.md
├── biome.json
├── package.json                              # Bun workspace root
├── tsconfig.base.json
└── README.md
```

**File responsibility:**
- `apps/backend/src/types.ts` — единственный источник правды для всех типов.
- `apps/backend/src/patch.ts` — pure function без зависимостей.
- `packages/didraw-client/src/index.ts` — единственное место, где формируются HTTP-запросы к backend. CLI, MCP-adapter, тесты — все используют его.
- `packages/didraw-cli` — тонкая argv-обёртка над client'ом. Не содержит бизнес-логики.

---

## Task 1: Init monorepo, biome, tsconfig

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `biome.json`, `.gitignore`

- [ ] **Step 1: Root `package.json`**

```json
{
  "name": "didraw-root",
  "private": true,
  "type": "module",
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "dev": "concurrently 'DIDRAW_PROFILE=dev bun --cwd apps/backend src/index.ts' 'bun --cwd apps/frontend run dev'",
    "test": "bun --cwd apps/backend test && bun --cwd packages/didraw-client test && bun --cwd packages/didraw-cli test",
    "lint": "biome check ."
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.0",
    "concurrently": "^9.0.0",
    "typescript": "^5.5.0"
  }
}
```

- [ ] **Step 2: `tsconfig.base.json`**

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
    "isolatedModules": true,
    "types": ["bun-types"]
  }
}
```

- [ ] **Step 3: `biome.json`**

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.0/schema.json",
  "files": { "ignore": ["**/dist/**", "**/node_modules/**"] },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "formatter": { "indentStyle": "space", "indentWidth": 2 },
  "javascript": { "formatter": { "semicolons": "always", "trailingCommas": "all" } }
}
```

- [ ] **Step 4: `.gitignore`**

```
node_modules/
dist/
*.log
.DS_Store
```

- [ ] **Step 5: Install and verify**

```bash
bun install
bunx biome check .
```

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.base.json biome.json .gitignore bun.lock
git commit -m "chore: init monorepo (Bun workspaces + biome)"
```

---

## Task 2: Bootstrap backend skeleton with /healthz

**Files:**
- Create: `apps/backend/package.json`, `apps/backend/tsconfig.json`
- Create: `apps/backend/src/config.ts`, `apps/backend/src/index.ts`

- [ ] **Step 1: `apps/backend/package.json`**

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
    "elkjs": "^0.9.3"
  },
  "devDependencies": {
    "bun-types": "latest"
  }
}
```

- [ ] **Step 2: `apps/backend/tsconfig.json`**

```json
{ "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts", "tests/**/*.ts"] }
```

- [ ] **Step 3: `apps/backend/src/config.ts`**

Profile-aware с самого начала: dev=8788 (vs Vite proxy), release=8787, отдельные storage namespaces. Сделать config **функцией**, не frozen constant — `--profile` flag меняет env до import'а в большинстве кейсов, но lazy-read через `getConfig()` страхует от race conditions.

```ts
import { homedir } from "node:os";
import { join } from "node:path";

export type Profile = "dev" | "release" | "debug";

const portByProfile: Record<Profile, number> = { dev: 8788, release: 8787, debug: 8787 };
const storageSubdir: Record<Profile, string> = { dev: "canvas-dev", release: "canvas", debug: "canvas" };

export function getProfile(): Profile {
  return (process.env.DIDRAW_PROFILE ?? "release") as Profile;
}

export function getConfig() {
  const profile = getProfile();
  return {
    profile,
    port: Number(process.env.DIDRAW_PORT ?? portByProfile[profile]),
    storageDir: process.env.DIDRAW_STORAGE_DIR
      ?? join(homedir(), ".claude", "projects", "default-project", storageSubdir[profile]),
    logLevel: (process.env.DIDRAW_LOG_LEVEL
      ?? (profile === "dev" || profile === "debug" ? "debug" : "info")) as "debug" | "info" | "error",
    autosaveDebounceMs: 300,
    roomEvictionMs: 60 * 60 * 1000,
    opLogMaxSize: 50,
    gracefulShutdownMs: 2000,
  } as const;
}

// Convenience getter — для top-level reads после parse-args.
export const config = new Proxy({} as ReturnType<typeof getConfig>, { get: (_, k) => (getConfig() as any)[k] });
```

> **Why Proxy?** Top-level imports (Hono routes, Rooms, persistence) хватают `config.port` / `config.storageDir`. Если бы это был frozen object, читался бы DEFAULT профиль раньше, чем CLI применит `--profile`. Proxy lazy-делегирует к `getConfig()` при каждом обращении.

- [ ] **Step 4: Minimal `apps/backend/src/index.ts`**

```ts
import { Hono } from "hono";
import { config } from "./config";

const app = new Hono();
app.get("/healthz", (c) => c.json({ ok: true, version: "0.0.0" }));

if (import.meta.main) {
  const server = Bun.serve({ port: config.port, fetch: app.fetch });
  console.log(`[didraw] listening on http://localhost:${server.port}`);
}
```

- [ ] **Step 5: Install and verify**

```bash
cd apps/backend && bun install && bun src/index.ts &
curl -s localhost:8787/healthz
kill %1
```
Expected: `{"ok":true,"version":"0.0.0"}`

- [ ] **Step 6: Commit**

```bash
git add apps/backend/
git commit -m "chore(backend): bootstrap Hono with /healthz"
```

---

## Task 3: Bootstrap frontend (tldraw + room param)

**Files:**
- Create: `apps/frontend/package.json`, `apps/frontend/tsconfig.json`, `apps/frontend/vite.config.ts`
- Create: `apps/frontend/index.html`, `apps/frontend/src/main.tsx`, `apps/frontend/src/App.tsx`, `apps/frontend/src/styles.css`

- [ ] **Step 1: `apps/frontend/package.json`**

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

> **Note:** Spec mandates tldraw SDK 5.x. npm `tldraw@3.0` is SDK 5.x (npm major != SDK major). Verify at install: `npm view tldraw versions | tail -10`. If a newer SDK 5.x major appeared (`tldraw@4.x`), bump.

- [ ] **Step 2: `apps/frontend/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "jsx": "react-jsx", "types": ["vite/client"] },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: `apps/frontend/vite.config.ts`**

```ts
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // Vite dev → ходит на backend profile=dev, default 8788. Можно переопределить env DIDRAW_PORT.
  const backendPort = Number(env.DIDRAW_PORT ?? 8788);
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        "/api": `http://localhost:${backendPort}`,
        "/ws": { target: `ws://localhost:${backendPort}`, ws: true },
      },
    },
  };
});
```

- [ ] **Step 4: `apps/frontend/index.html`**

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

- [ ] **Step 5: `apps/frontend/src/styles.css`**

```css
html, body, #root { margin: 0; padding: 0; height: 100%; }
body { font-family: system-ui, sans-serif; }
```

- [ ] **Step 6: `apps/frontend/src/main.tsx`**

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";

const room = new URLSearchParams(location.search).get("room") ?? "default";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><App room={room} /></React.StrictMode>,
);
```

- [ ] **Step 7: Skeleton `apps/frontend/src/App.tsx`**

```tsx
import { Tldraw } from "tldraw";
import "tldraw/tldraw.css";

export function App({ room }: { room: string }) {
  return (
    <div style={{ height: "100vh" }}>
      <div style={{ position: "fixed", top: 8, left: 8, zIndex: 1000 }}>room: <code>{room}</code></div>
      <Tldraw />
    </div>
  );
}
```

- [ ] **Step 8: Install and verify**

```bash
cd apps/frontend && bun install && bun run dev
# visit http://localhost:5173/?room=test
```
Expected: пустой tldraw, надпись `room: test`.

- [ ] **Step 9: Commit**

```bash
git add apps/frontend/
git commit -m "chore(frontend): bootstrap Vite+React+tldraw 5.x with room param"
```

---

## Task 4: Spike — `@tldraw/mermaid` headless on Bun

This task answers "can we parse Mermaid → tldraw shapes server-side (Bun, no DOM), or must it run in the browser?". Result is an ADR; Phase 1.6 (Task 22) splits accordingly.

**Files:**
- Create: `apps/backend/spike/mermaid-headless.ts`
- Create: `docs/decisions/0001-mermaid-import-location.md`

- [ ] **Step 1: Add deps**

```bash
cd apps/backend
bun add @tldraw/mermaid
bun add -D jsdom @types/jsdom
```

- [ ] **Step 2: Write spike**

```ts
// apps/backend/spike/mermaid-headless.ts
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true, url: "http://localhost/",
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

try {
  // @ts-expect-error — runtime spike, exact API verified post-install
  const result = await mod.createMermaidDiagram?.({ source: "graph LR\n a --> b" });
  console.log("ok, nodes:", result?.nodes?.length ?? result);
} catch (err) {
  console.error("FAIL:", (err as Error).message);
  process.exit(1);
}
```

- [ ] **Step 3: Run, capture output**

```bash
cd apps/backend && bun spike/mermaid-headless.ts 2>&1 | tee /tmp/spike-output.txt
```

- [ ] **Step 4: Try CLI fallback `mmdc`**

```bash
bunx -y @mermaid-js/mermaid-cli --version || echo "MMD CLI unavailable"
echo 'graph LR; a-->b' | bunx mmdc -p - 2>&1 || true
```

- [ ] **Step 5: Write ADR**

```md
<!-- docs/decisions/0001-mermaid-import-location.md -->
# ADR-0001: Mermaid import — backend vs frontend

**Date:** 2026-05-14
**Status:** Decided

## Context
Spec §4 предусматривал backend-side mermaid-import через `@tldraw/mermaid`.
Phase 0.1 spike (Task 4) проверяет, работает ли пакет в Bun с jsdom-полифиллом.

## Spike result
<!-- Вставить stdout/stderr из /tmp/spike-output.txt + результат mmdc fallback -->

## Decision
<!-- Один из:
A) Backend implementation (`apps/backend/src/mermaid-import.ts` через jsdom)
B) Frontend implementation (frontend парсит, шлёт PatchOp[] через POST /api/patch)
C) Hybrid: backend smoke-validates через `mmdc`, frontend конвертирует
-->

## Consequences for Task 22
<!-- Что точно меняется -->
```

- [ ] **Step 6: Commit**

```bash
git add apps/backend/spike apps/backend/package.json docs/decisions/
git commit -m "spike: evaluate @tldraw/mermaid on Bun (ADR-0001)"
```

---

## Task 5: Core types

**Files:**
- Create: `apps/backend/src/types.ts`
- Create: `apps/backend/tests/types.test.ts`

- [ ] **Step 1: Failing tests**

```ts
// apps/backend/tests/types.test.ts
import { describe, test, expect } from "bun:test";
import type {
  CanvasState, Node, Edge, Endpoint, Group, PatchOp, Prompt, RoomState,
} from "../src/types";

describe("types — shape", () => {
  test("CanvasState has version=1 and three arrays", () => {
    const s: CanvasState = { version: 1, nodes: [], edges: [], groups: [] };
    expect(s.version).toBe(1);
  });

  test("Endpoint accepts node and point variants", () => {
    const e1: Endpoint = { kind: "node", id: "n1" };
    const e2: Endpoint = { kind: "point", x: 0, y: 0 };
    expect(e1.kind).toBe("node");
    expect(e2.kind).toBe("point");
  });

  test("Node kinds cover MVP set", () => {
    const kinds: Node["kind"][] = ["rect", "ellipse", "diamond", "sticky", "text", "image", "freeform"];
    expect(kinds.length).toBe(7);
  });

  test("Group supports frame and group", () => {
    const g: Group = { id: "g1", kind: "frame", children: [], x: 0, y: 0, w: 100, h: 100 };
    expect(g.kind).toBe("frame");
  });

  test("PatchOp union", () => {
    const ops: PatchOp[] = [
      { op: "add", target: "node", value: { id: "n1", kind: "rect", x: 0, y: 0 } },
      { op: "update", target: "node", id: "n1", set: { x: 10 } },
      { op: "delete", target: "edge", id: "e1" },
    ];
    expect(ops).toHaveLength(3);
  });

  test("Prompt fields", () => {
    const p: Prompt = { id: "p1", selection: ["n1"], text: "x", createdAt: 0, status: "pending" };
    expect(p.status).toBe("pending");
  });
});
```

- [ ] **Step 2: Run — FAIL (module missing)**

```bash
cd apps/backend && bun test tests/types.test.ts
```

- [ ] **Step 3: Implement `apps/backend/src/types.ts`**

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

export type OpLogEntry = {
  ops: PatchOp[];
  source: "ai" | "user";
  version: number;
  at: number;
  clientOpId?: string;
};

export type RoomState = {
  canvas: CanvasState;
  opLog: OpLogEntry[];
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

- [ ] **Step 4: Run — PASS**

```bash
cd apps/backend && bun test tests/types.test.ts
```
Expected: 6 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/types.ts apps/backend/tests/types.test.ts
git commit -m "feat(backend): core types — CanvasState, PatchOp, RoomState, Prompt"
```

---

## Task 6: applyPatch with deep-merge for style/meta

**Files:**
- Create: `apps/backend/src/patch.ts`
- Create: `apps/backend/tests/patch.test.ts`

- [ ] **Step 1: Failing tests**

```ts
// apps/backend/tests/patch.test.ts
import { describe, test, expect } from "bun:test";
import { applyPatch } from "../src/patch";
import type { CanvasState } from "../src/types";

const empty = (): CanvasState => ({ version: 1, nodes: [], edges: [], groups: [] });

describe("applyPatch", () => {
  test("add node", () => {
    const r = applyPatch(empty(), [{ op: "add", target: "node", value: { id: "n1", kind: "rect", x: 0, y: 0 } }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.nodes).toHaveLength(1);
  });

  test("update with style deep-merges", () => {
    const s: CanvasState = {
      version: 1,
      nodes: [{ id: "n1", kind: "rect", x: 0, y: 0, style: { stroke: "#000", fontSize: 14 } }],
      edges: [], groups: [],
    };
    const r = applyPatch(s, [{ op: "update", target: "node", id: "n1", set: { style: { fill: "#888" } } }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.nodes[0].style).toEqual({ stroke: "#000", fontSize: 14, fill: "#888" });
  });

  test("update style.fill=undefined deletes key", () => {
    const s: CanvasState = {
      version: 1,
      nodes: [{ id: "n1", kind: "rect", x: 0, y: 0, style: { fill: "#888", stroke: "#000" } }],
      edges: [], groups: [],
    };
    const r = applyPatch(s, [{ op: "update", target: "node", id: "n1", set: { style: { fill: undefined } } }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.nodes[0].style).toEqual({ stroke: "#000" });
  });

  test("edge.from references unknown node — fails atomically", () => {
    const r = applyPatch(empty(), [
      { op: "add", target: "edge", value: { id: "e1", from: { kind: "node", id: "missing" }, to: { kind: "node", id: "n1" } } },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("missing");
  });

  test("edge with point endpoint — allowed", () => {
    const r = applyPatch(empty(), [
      { op: "add", target: "edge", value: { id: "e1", from: { kind: "point", x: 0, y: 0 }, to: { kind: "point", x: 100, y: 0 } } },
    ]);
    expect(r.ok).toBe(true);
  });

  test("rollback on later op failure", () => {
    const r = applyPatch(empty(), [
      { op: "add", target: "node", value: { id: "n1", kind: "rect", x: 0, y: 0 } },
      { op: "add", target: "edge", value: { id: "e1", from: { kind: "node", id: "missing" }, to: { kind: "node", id: "n1" } } },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.state.nodes).toHaveLength(0);
  });

  test("delete removes", () => {
    const s: CanvasState = { version: 1, nodes: [{ id: "n1", kind: "rect", x: 0, y: 0 }], edges: [], groups: [] };
    const r = applyPatch(s, [{ op: "delete", target: "node", id: "n1" }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.nodes).toHaveLength(0);
  });

  test("cascade: delete node removes referencing edges", () => {
    const s: CanvasState = {
      version: 1,
      nodes: [{ id: "n1", kind: "rect", x: 0, y: 0 }, { id: "n2", kind: "rect", x: 100, y: 0 }],
      edges: [
        { id: "e1", from: { kind: "node", id: "n1" }, to: { kind: "node", id: "n2" } },
        { id: "e2", from: { kind: "node", id: "n2" }, to: { kind: "point", x: 0, y: 0 } },
      ],
      groups: [],
    };
    const r = applyPatch(s, [{ op: "delete", target: "node", id: "n1" }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.state.nodes.map((n) => n.id)).toEqual(["n2"]);
      expect(r.state.edges.map((e) => e.id)).toEqual(["e2"]); // e1 удалён каскадом
    }
  });

  test("cascade: delete node removes id from group.children", () => {
    const s: CanvasState = {
      version: 1,
      nodes: [{ id: "n1", kind: "rect", x: 0, y: 0 }, { id: "n2", kind: "rect", x: 0, y: 0 }],
      edges: [],
      groups: [{ id: "g1", kind: "group", children: ["n1", "n2"] }],
    };
    const r = applyPatch(s, [{ op: "delete", target: "node", id: "n1" }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.groups[0].children).toEqual(["n2"]);
  });

  test("cascade: delete group keeps children", () => {
    const s: CanvasState = {
      version: 1,
      nodes: [{ id: "n1", kind: "rect", x: 0, y: 0 }],
      edges: [],
      groups: [{ id: "g1", kind: "group", children: ["n1"] }],
    };
    const r = applyPatch(s, [{ op: "delete", target: "group", id: "g1" }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.state.groups).toHaveLength(0);
      expect(r.state.nodes).toHaveLength(1); // node остался плавающим
    }
  });
});
```

- [ ] **Step 2: Run — FAIL**

```bash
cd apps/backend && bun test tests/patch.test.ts
```

- [ ] **Step 3: Implement `apps/backend/src/patch.ts`**

```ts
import type { CanvasState, PatchOp, Node, Edge, Group } from "./types";

export type ApplyResult =
  | { ok: true; state: CanvasState }
  | { ok: false; state: CanvasState; error: string };

export function applyPatch(state: CanvasState, ops: PatchOp[]): ApplyResult {
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
    if (s.nodes.some((n) => n.id === op.value.id)) return { ok: false, state: s, error: `node ${op.value.id} exists` };
    return { ok: true, state: { ...s, nodes: [...s.nodes, op.value] } };
  }
  if (op.target === "edge") {
    if (s.edges.some((e) => e.id === op.value.id)) return { ok: false, state: s, error: `edge ${op.value.id} exists` };
    const err = checkEndpoint(s, op.value.from, "from") ?? checkEndpoint(s, op.value.to, "to");
    if (err) return { ok: false, state: s, error: err };
    return { ok: true, state: { ...s, edges: [...s.edges, op.value] } };
  }
  if (op.target === "group") {
    if (s.groups.some((g) => g.id === op.value.id)) return { ok: false, state: s, error: `group ${op.value.id} exists` };
    return { ok: true, state: { ...s, groups: [...s.groups, op.value] } };
  }
  return { ok: false, state: s, error: "unknown add target" };
}

function checkEndpoint(s: CanvasState, ep: Edge["from"], side: string): string | null {
  if (ep.kind === "node" && !s.nodes.some((n) => n.id === ep.id)) return `edge.${side} references unknown node ${ep.id}`;
  return null;
}

function updateOp(s: CanvasState, op: Extract<PatchOp, { op: "update" }>): ApplyResult {
  if (op.target === "node") {
    const idx = s.nodes.findIndex((n) => n.id === op.id);
    if (idx === -1) return { ok: false, state: s, error: `node ${op.id} not found` };
    const merged = mergeRecord(s.nodes[idx], op.set, ["style", "meta"]) as Node;
    const nodes = [...s.nodes]; nodes[idx] = merged;
    return { ok: true, state: { ...s, nodes } };
  }
  if (op.target === "edge") {
    const idx = s.edges.findIndex((e) => e.id === op.id);
    if (idx === -1) return { ok: false, state: s, error: `edge ${op.id} not found` };
    const merged = mergeRecord(s.edges[idx], op.set, ["style", "meta"]) as Edge;
    const edges = [...s.edges]; edges[idx] = merged;
    return { ok: true, state: { ...s, edges } };
  }
  if (op.target === "group") {
    const idx = s.groups.findIndex((g) => g.id === op.id);
    if (idx === -1) return { ok: false, state: s, error: `group ${op.id} not found` };
    const merged = mergeRecord(s.groups[idx], op.set, ["style"]) as Group;
    const groups = [...s.groups]; groups[idx] = merged;
    return { ok: true, state: { ...s, groups } };
  }
  return { ok: false, state: s, error: "unknown update target" };
}

function deleteOp(s: CanvasState, op: Extract<PatchOp, { op: "delete" }>): ApplyResult {
  if (op.target === "node") {
    // cascade: убрать edges, ссылающиеся на node; убрать id из всех group.children
    const refsNode = (ep: { kind: string; id?: string }) => ep.kind === "node" && (ep as any).id === op.id;
    return {
      ok: true,
      state: {
        ...s,
        nodes: s.nodes.filter((n) => n.id !== op.id),
        edges: s.edges.filter((e) => !refsNode(e.from as any) && !refsNode(e.to as any)),
        groups: s.groups.map((g) => g.children.includes(op.id) ? { ...g, children: g.children.filter((c) => c !== op.id) } : g),
      },
    };
  }
  if (op.target === "edge") {
    return { ok: true, state: { ...s, edges: s.edges.filter((e) => e.id !== op.id) } };
  }
  if (op.target === "group") {
    // group удаляется; дети остаются "плавающими"
    return { ok: true, state: { ...s, groups: s.groups.filter((g) => g.id !== op.id) } };
  }
  return { ok: false, state: s, error: "unknown delete target" };
}

function mergeRecord<T extends Record<string, unknown>>(
  base: T, patch: Partial<T>, deepKeys: (keyof T)[],
): T {
  const out: Record<string, unknown> = { ...base };
  for (const k of Object.keys(patch) as (keyof T)[]) {
    const v = patch[k];
    if (deepKeys.includes(k) && isObject(v) && isObject(base[k])) {
      const sub: Record<string, unknown> = { ...(base[k] as Record<string, unknown>) };
      for (const sk of Object.keys(v as object)) {
        const sv = (v as Record<string, unknown>)[sk];
        if (sv === undefined) delete sub[sk]; else sub[sk] = sv;
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

- [ ] **Step 4: Run — PASS**

```bash
cd apps/backend && bun test tests/patch.test.ts
```
Expected: 7 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/patch.ts apps/backend/tests/patch.test.ts
git commit -m "feat(backend): applyPatch with deep-merge for style/meta and atomic rollback"
```

---

## Task 7: Rooms manager

**Files:**
- Create: `apps/backend/src/rooms.ts`
- Create: `apps/backend/tests/rooms.test.ts`

- [ ] **Step 1: Failing tests**

```ts
// apps/backend/tests/rooms.test.ts
import { describe, test, expect, beforeEach } from "bun:test";
import { Rooms, makeRoomState } from "../src/rooms";

describe("Rooms", () => {
  let rooms: Rooms;
  beforeEach(() => { rooms = new Rooms({ load: async () => null, save: async () => {} }); });

  test("get returns fresh empty room", async () => {
    const r = await rooms.get("a");
    expect(r.canvas.nodes).toEqual([]);
    expect(r.version).toBe(0);
  });

  test("different ids isolated", async () => {
    const a = await rooms.get("a");
    const b = await rooms.get("b");
    a.canvas.nodes.push({ id: "x", kind: "rect", x: 0, y: 0 });
    expect(b.canvas.nodes).toEqual([]);
  });

  test("same id returns same instance", async () => {
    const r1 = await rooms.get("a");
    const r2 = await rooms.get("a");
    expect(r1).toBe(r2);
  });

  test("loads from store if available", async () => {
    const preset = makeRoomState();
    preset.canvas.nodes.push({ id: "pre", kind: "rect", x: 0, y: 0 });
    const rooms = new Rooms({ load: async (id) => (id === "x" ? preset : null), save: async () => {} });
    const r = await rooms.get("x");
    expect(r.canvas.nodes[0].id).toBe("pre");
  });

  test("evictIdle saves dirty rooms and removes", async () => {
    let saved = 0;
    const rooms = new Rooms({ load: async () => null, save: async () => { saved++; } });
    const r = await rooms.get("a"); r.dirty = true; r.lastTouched = Date.now() - 10_000;
    const n = await rooms.evictIdle(5_000);
    expect(n).toBe(1); expect(saved).toBe(1); expect(rooms.has("a")).toBe(false);
  });
});
```

- [ ] **Step 2: Run — FAIL, then implement `apps/backend/src/rooms.ts`**

```ts
import type { RoomId, RoomState } from "./types";

export type RoomStore = {
  load: (id: RoomId) => Promise<RoomState | null>;
  save: (id: RoomId, state: RoomState) => Promise<void>;
};

export function makeRoomState(): RoomState {
  return {
    canvas: { version: 1, nodes: [], edges: [], groups: [] },
    opLog: [], prompts: [], version: 0, dirty: false, lastTouched: Date.now(),
  };
}

export class Rooms {
  private map = new Map<RoomId, RoomState>();
  private loading = new Map<RoomId, Promise<RoomState>>();
  constructor(private store: RoomStore) {}

  async get(id: RoomId): Promise<RoomState> {
    const existing = this.map.get(id);
    if (existing) { existing.lastTouched = Date.now(); return existing; }
    const pending = this.loading.get(id);
    if (pending) return pending;
    const p = (async () => {
      const loaded = await this.store.load(id);
      const s = loaded ?? makeRoomState();
      this.map.set(id, s); this.loading.delete(id);
      return s;
    })();
    this.loading.set(id, p);
    return p;
  }

  touch(id: RoomId) { const s = this.map.get(id); if (s) s.lastTouched = Date.now(); }
  has(id: RoomId) { return this.map.has(id); }
  ids() { return [...this.map.keys()]; }

  async evictIdle(maxIdleMs: number): Promise<number> {
    const cutoff = Date.now() - maxIdleMs; let n = 0;
    for (const [id, s] of this.map) {
      if (s.lastTouched < cutoff) {
        if (s.dirty) await this.store.save(id, s);
        this.map.delete(id); n++;
      }
    }
    return n;
  }
}
```

- [ ] **Step 3: Run — PASS, commit**

```bash
cd apps/backend && bun test tests/rooms.test.ts
git add apps/backend/src/rooms.ts apps/backend/tests/rooms.test.ts
git commit -m "feat(backend): Rooms manager with lazy-load and LRU eviction"
```

---

## Task 8: FilePersistence with debounced autosave

**Files:**
- Create: `apps/backend/src/persistence.ts`
- Create: `apps/backend/tests/persistence.test.ts`

- [ ] **Step 1: Failing tests**

```ts
// apps/backend/tests/persistence.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { FilePersistence } from "../src/persistence";
import { makeRoomState } from "../src/rooms";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "didraw-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("FilePersistence", () => {
  test("load missing returns null", async () => {
    expect(await new FilePersistence(dir).load("none")).toBeNull();
  });

  test("save + load round-trip", async () => {
    const p = new FilePersistence(dir);
    const s = makeRoomState();
    s.canvas.nodes.push({ id: "n1", kind: "rect", x: 5, y: 10 });
    s.version = 3;
    await p.save("t", s);
    const loaded = await p.load("t");
    expect(loaded?.canvas.nodes[0].id).toBe("n1");
    expect(loaded?.version).toBe(3);
  });

  test("opLog and dirty NOT persisted", async () => {
    const p = new FilePersistence(dir);
    const s = makeRoomState();
    s.opLog.push({ ops: [], source: "user", version: 1, at: 0 });
    s.dirty = true;
    await p.save("o", s);
    const l = await p.load("o");
    expect(l?.opLog).toEqual([]);
    expect(l?.dirty).toBe(false);
  });

  test("scheduleSave debounces", async () => {
    const p = new FilePersistence(dir);
    let writes = 0;
    const orig = p.save.bind(p);
    p.save = async (id, s) => { writes++; return orig(id, s); };
    p.scheduleSave("d", makeRoomState());
    p.scheduleSave("d", makeRoomState());
    await new Promise((r) => setTimeout(r, 50));
    expect(writes).toBe(0);
    await new Promise((r) => setTimeout(r, 320));
    expect(writes).toBe(1);
  });

  test("flushAll writes pending immediately", async () => {
    const p = new FilePersistence(dir);
    const s = makeRoomState();
    s.canvas.nodes.push({ id: "n1", kind: "rect", x: 0, y: 0 });
    p.scheduleSave("urgent", s);
    // sub-debounce — yet flushAll должен записать
    await p.flushAll();
    const loaded = await p.load("urgent");
    expect(loaded?.canvas.nodes[0].id).toBe("n1");
  });
});
```

- [ ] **Step 2: Implement `apps/backend/src/persistence.ts`**

```ts
import { existsSync, mkdirSync, promises as fs } from "node:fs";
import { join } from "node:path";
import type { RoomId, RoomState } from "./types";
import { config } from "./config";

export class FilePersistence {
  // pending хранит и timer, и сами данные — без этого flushAll не сможет записать debounce'нутые состояния
  private pending = new Map<RoomId, { timer: ReturnType<typeof setTimeout>; state: RoomState }>();
  constructor(private dir: string) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  async load(id: RoomId): Promise<RoomState | null> {
    const path = join(this.dir, `${sanitize(id)}.json`);
    try {
      const raw = await fs.readFile(path, "utf8");
      const j = JSON.parse(raw) as Partial<RoomState>;
      return {
        canvas: j.canvas ?? { version: 1, nodes: [], edges: [], groups: [] },
        prompts: j.prompts ?? [],
        version: j.version ?? 0,
        opLog: [], dirty: false, lastTouched: Date.now(),
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async save(id: RoomId, s: RoomState): Promise<void> {
    const path = join(this.dir, `${sanitize(id)}.json`);
    const dump = JSON.stringify({ canvas: s.canvas, prompts: s.prompts, version: s.version }, null, 2);
    await fs.writeFile(path, dump, "utf8");
  }

  scheduleSave(id: RoomId, s: RoomState): void {
    const existing = this.pending.get(id);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      this.pending.delete(id);
      void this.save(id, s).catch((e) => console.error("[persistence]", e));
    }, config.autosaveDebounceMs);
    this.pending.set(id, { timer, state: s });
  }

  /**
   * Immediately write all pending saves and clear the queue.
   * Called on graceful shutdown (SIGTERM/SIGINT) so debounce-300ms losses don't happen.
   */
  async flushAll(): Promise<void> {
    const entries = [...this.pending.entries()];
    for (const [, { timer }] of entries) clearTimeout(timer);
    this.pending.clear();
    await Promise.all(entries.map(([id, { state }]) => this.save(id, state).catch((e) => console.error("[persistence] flush", id, e))));
  }
}

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}
```

- [ ] **Step 3: Run — PASS, commit**

```bash
cd apps/backend && bun test tests/persistence.test.ts
git add apps/backend/src/persistence.ts apps/backend/tests/persistence.test.ts
git commit -m "feat(backend): FilePersistence with debounced autosave"
```

---

## Task 9: REST routes — /api/state, /api/patch

**Files:**
- Create: `apps/backend/src/routes/{health,state,patch}.ts`
- Modify: `apps/backend/src/index.ts`
- Create: `apps/backend/tests/routes.{state,patch}.test.ts`

- [ ] **Step 1: Failing tests for state**

```ts
// apps/backend/tests/routes.state.test.ts
import { describe, test, expect } from "bun:test";
import { makeApp } from "../src/index";

describe("GET /api/state", () => {
  test("empty room", async () => {
    const { app } = makeApp({ inMemory: true });
    const r = await app.fetch(new Request("http://x/api/state?room=a"));
    const b = await r.json();
    expect(b.canvas.nodes).toEqual([]);
    expect(b.version).toBe(0);
  });

  test("returns diff with since=", async () => {
    const { app } = makeApp({ inMemory: true });
    await app.fetch(new Request("http://x/api/patch?room=a", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ops: [{ op: "add", target: "node", value: { id: "n1", kind: "rect", x: 0, y: 0 } }], source: "user" }),
    }));
    const r = await app.fetch(new Request("http://x/api/state?room=a&since=0"));
    const b = await r.json();
    expect(b.diff).toHaveLength(1);
  });

  test("compact omits empty style/meta", async () => {
    const { app } = makeApp({ inMemory: true });
    await app.fetch(new Request("http://x/api/patch?room=a", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ops: [{ op: "add", target: "node", value: { id: "n1", kind: "rect", x: 0, y: 0 } }], source: "user" }),
    }));
    const r = await app.fetch(new Request("http://x/api/state?room=a&fmt=compact"));
    const b = await r.json();
    expect(b.canvas.nodes[0]).not.toHaveProperty("style");
  });
});
```

- [ ] **Step 2: Failing tests for patch**

```ts
// apps/backend/tests/routes.patch.test.ts
import { describe, test, expect } from "bun:test";
import { makeApp } from "../src/index";

const post = (app: any, room: string, body: unknown) =>
  app.fetch(new Request(`http://x/api/patch?room=${room}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));

describe("POST /api/patch", () => {
  test("ok + version increments", async () => {
    const { app } = makeApp({ inMemory: true });
    const r = await post(app, "a", { ops: [{ op: "add", target: "node", value: { id: "n1", kind: "rect", x: 0, y: 0 } }], source: "ai" });
    const b = await r.json();
    expect(b.ok).toBe(true); expect(b.version).toBe(1);
  });

  test("422 on validation error, version unchanged", async () => {
    const { app } = makeApp({ inMemory: true });
    const r = await post(app, "a", { ops: [{ op: "add", target: "edge", value: { id: "e", from: { kind: "node", id: "missing" }, to: { kind: "node", id: "n" } } }], source: "ai" });
    expect(r.status).toBe(422);
  });

  test("idempotency by clientOpId", async () => {
    const { app } = makeApp({ inMemory: true });
    const body = { ops: [{ op: "add", target: "node", value: { id: "n1", kind: "rect", x: 0, y: 0 } }], source: "user", clientOpId: "abc" };
    const r1 = await post(app, "a", body); const b1 = await r1.json();
    const r2 = await post(app, "a", body); const b2 = await r2.json();
    expect(b1.version).toBe(1); expect(b2.version).toBe(1); expect(b2.idempotent).toBe(true);
  });

  test("rooms isolated", async () => {
    const { app } = makeApp({ inMemory: true });
    await post(app, "a", { ops: [{ op: "add", target: "node", value: { id: "n1", kind: "rect", x: 0, y: 0 } }], source: "user" });
    const r = await app.fetch(new Request("http://x/api/state?room=b"));
    expect((await r.json()).canvas.nodes).toEqual([]);
  });
});
```

- [ ] **Step 3: Implement routes**

```ts
// apps/backend/src/routes/health.ts
import { Hono } from "hono";
export const healthRoutes = new Hono().get("/healthz", (c) => c.json({ ok: true }));
```

```ts
// apps/backend/src/routes/state.ts
import { Hono } from "hono";
import type { Rooms } from "../rooms";
import type { CanvasState, Node, Edge, Group } from "../types";

export function stateRoutes(rooms: Rooms) {
  return new Hono().get("/api/state", async (c) => {
    const id = c.req.query("room") ?? "default";
    const sinceRaw = c.req.query("since");
    const fmt = c.req.query("fmt") ?? "full";
    const r = await rooms.get(id); rooms.touch(id);

    if (sinceRaw !== undefined && !Number.isNaN(Number(sinceRaw))) {
      const since = Number(sinceRaw);
      return c.json({ since, version: r.version, diff: r.opLog.filter((e) => e.version > since) });
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
    groups: s.groups,
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
function round(n: number) { return Math.round(n * 10) / 10; }
```

```ts
// apps/backend/src/routes/patch.ts
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
    if (!body || !Array.isArray(body.ops)) return c.json({ ok: false, error: "expected {ops,source}" }, 400);

    const ops = body.ops as PatchOp[];
    const source = (body.source ?? "user") as "ai" | "user";
    const clientOpId: string | undefined = body.clientOpId;
    const r = await rooms.get(id); rooms.touch(id);

    if (clientOpId && r.opLog.some((e) => e.clientOpId === clientOpId)) {
      return c.json({ ok: true, version: r.version, idempotent: true });
    }

    const result = applyPatch(r.canvas, ops);
    if (!result.ok) return c.json({ ok: false, error: result.error }, 422);

    r.canvas = result.state;
    r.version += 1;
    r.opLog.push({ ops, source, version: r.version, at: Date.now(), clientOpId });
    if (r.opLog.length > config.opLogMaxSize) r.opLog.splice(0, r.opLog.length - config.opLogMaxSize);
    r.dirty = true;
    opts.onDirty?.(id);
    bus.publish(id, { ops, source, version: r.version, originClientId: clientOpId });

    return c.json({ ok: true, version: r.version });
  });
}
```

- [ ] **Step 4: Wire `apps/backend/src/index.ts`**

```ts
import { Hono } from "hono";
import { config } from "./config";
import { Rooms, type RoomStore } from "./rooms";
import { FilePersistence } from "./persistence";
import { stateRoutes } from "./routes/state";
import { patchRoutes, type PatchBus } from "./routes/patch";
import { healthRoutes } from "./routes/health";
import { join } from "node:path";

export type AppOpts = { inMemory?: boolean; storageDir?: string };

export function makeApp(opts: AppOpts = {}) {
  const storageDir = opts.storageDir ?? join(config.storageDir, "default-project", "canvas");
  const persistence = opts.inMemory ? null : new FilePersistence(storageDir);
  const store: RoomStore = persistence
    ? { load: (id) => persistence.load(id), save: (id, s) => persistence.save(id, s) }
    : { load: async () => null, save: async () => {} };
  const rooms = new Rooms(store);
  const bus: PatchBus = { publish: () => {} };
  const app = new Hono();
  app.route("/", healthRoutes);
  app.route("/", stateRoutes(rooms));
  app.route("/", patchRoutes(rooms, bus, {
    onDirty: persistence ? (id) => { void rooms.get(id).then((s) => persistence.scheduleSave(id, s)); } : undefined,
  }));
  return { app, rooms, bus };
}
```

- [ ] **Step 5: Run all tests — PASS**

```bash
cd apps/backend && bun test
```

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/routes apps/backend/src/index.ts apps/backend/tests/routes.*.test.ts
git commit -m "feat(backend): /api/state and /api/patch with multi-room, idempotency, compact format"
```

---

## Task 10: WebSocket per-room broadcast

**Files:**
- Create: `apps/backend/src/ws.ts`
- Modify: `apps/backend/src/index.ts` (replace with `startServer` returning port)
- Create: `apps/backend/tests/ws.test.ts`

- [ ] **Step 1: Failing test**

```ts
// apps/backend/tests/ws.test.ts
import { describe, test, expect } from "bun:test";
import { startServer } from "../src/index";

describe("WS /ws", () => {
  test("client receives patch broadcast for its room", async () => {
    const srv = await startServer({ inMemory: true, port: 0 });
    const ws = new WebSocket(`ws://localhost:${srv.port}/ws?room=a`);
    const msgs: any[] = [];
    await new Promise<void>((r) => { ws.onopen = () => r(); });
    ws.onmessage = (e) => msgs.push(JSON.parse(e.data as string));
    await new Promise((r) => setTimeout(r, 30));
    await fetch(`http://localhost:${srv.port}/api/patch?room=a`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ops: [{ op: "add", target: "node", value: { id: "n1", kind: "rect", x: 0, y: 0 } }], source: "ai" }),
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(msgs.some((m) => m.kind === "hello")).toBe(true);
    expect(msgs.some((m) => m.kind === "patch" && m.version === 1)).toBe(true);
    ws.close(); await srv.close();
  });

  test("rooms isolated on WS", async () => {
    const srv = await startServer({ inMemory: true, port: 0 });
    const ws = new WebSocket(`ws://localhost:${srv.port}/ws?room=a`);
    const msgs: any[] = [];
    await new Promise<void>((r) => { ws.onopen = () => r(); });
    ws.onmessage = (e) => msgs.push(JSON.parse(e.data as string));
    await fetch(`http://localhost:${srv.port}/api/patch?room=b`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ops: [{ op: "add", target: "node", value: { id: "n", kind: "rect", x: 0, y: 0 } }], source: "ai" }),
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(msgs.find((m) => m.kind === "patch")).toBeUndefined();
    ws.close(); await srv.close();
  });
});
```

- [ ] **Step 2: Implement `apps/backend/src/ws.ts`**

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
  detach(room: string, sock: Sock) { this.rooms.get(room)?.delete(sock); }

  publish(room: string, msg: { ops: PatchOp[]; source: "ai" | "user"; version: number; originClientId?: string }) {
    this.broadcast(room, { kind: "patch", ...msg });
  }
  publishPrompt(room: string, prompt: Prompt) { this.broadcast(room, { kind: "prompt-created", prompt }); }
  publishPromptResolved(room: string, id: string, response?: string) {
    this.broadcast(room, { kind: "prompt-resolved", id, response });
  }

  private broadcast(room: string, msg: WsMessage) {
    const set = this.rooms.get(room); if (!set) return;
    const data = JSON.stringify(msg);
    for (const s of set) if (s.readyState === OPEN) s.send(data);
  }
}
```

- [ ] **Step 3: Replace `apps/backend/src/index.ts` with WS-aware server**

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
  return { app, rooms, bus, persistence };
}

export async function startServer(opts: AppOpts = {}) {
  const { app, bus, persistence } = makeApp(opts);
  const server = Bun.serve({
    port: opts.port ?? config.port,
    fetch: (req, srv) => {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        const room = url.searchParams.get("room") ?? "default";
        if (srv.upgrade(req, { data: { room } })) return;
        return new Response("upgrade failed", { status: 500 });
      }
      return app.fetch(req);
    },
    websocket: {
      open(ws) {
        const { room } = ws.data as { room: string };
        bus.attach(room, ws as any);
        ws.send(JSON.stringify({ kind: "hello", version: 0 }));
      },
      message() {},
      close(ws) {
        const { room } = ws.data as { room: string };
        bus.detach(room, ws as any);
      },
    },
  });

  const shutdown = async (signal: string) => {
    console.log(`[didraw] ${signal} received, flushing…`);
    server.stop();
    if (persistence) await persistence.flushAll();
    process.exit(0);
  };
  if (import.meta.main) {
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
  }

  return {
    port: server.port,
    close: async () => {
      server.stop();
      if (persistence) await persistence.flushAll();
    },
  };
}

if (import.meta.main) {
  void startServer().then((s) => console.log(`[didraw] listening on :${s.port} (profile=${config.profile})`));
}
```

- [ ] **Step 4: Run, commit**

```bash
cd apps/backend && bun test
git add apps/backend
git commit -m "feat(backend): per-room WebSocket broadcast"
```

---

## Task 11: Autosave integration test

**Files:**
- Create: `apps/backend/tests/autosave.test.ts`

- [ ] **Step 1: Test**

```ts
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/index";

describe("autosave", () => {
  test("patch → canvas.json on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "didraw-as-"));
    const srv = await startServer({ port: 0, storageDir: dir });
    await fetch(`http://localhost:${srv.port}/api/patch?room=tst`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ops: [{ op: "add", target: "node", value: { id: "n1", kind: "rect", x: 5, y: 10 } }], source: "user" }),
    });
    await new Promise((r) => setTimeout(r, 500));
    const path = join(dir, "tst.json");
    expect(existsSync(path)).toBe(true);
    const dump = JSON.parse(readFileSync(path, "utf8"));
    expect(dump.canvas.nodes[0].id).toBe("n1");
    await srv.close(); rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run — PASS, commit**

```bash
cd apps/backend && bun test tests/autosave.test.ts
git add apps/backend/tests/autosave.test.ts
git commit -m "test(backend): autosave integration"
```

---

## Task 12: Frontend — load state, render shapes

**Files:**
- Create: `apps/frontend/src/transport/api.ts`
- Create: `apps/frontend/src/canvas/kinds.ts`
- Create: `apps/frontend/src/canvas/from-canvas-state.ts`
- Modify: `apps/frontend/src/App.tsx`

- [ ] **Step 1: `transport/api.ts`**

```ts
export const room = new URLSearchParams(location.search).get("room") ?? "default";

export async function getState(): Promise<{ version: number; canvas: any; prompts: any[] }> {
  const r = await fetch(`/api/state?room=${encodeURIComponent(room)}`);
  if (!r.ok) throw new Error(`getState ${r.status}`);
  return r.json();
}

export async function sendPatch(ops: unknown[], clientOpId: string) {
  const r = await fetch(`/api/patch?room=${encodeURIComponent(room)}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ops, source: "user", clientOpId }),
  });
  return r.json();
}
```

- [ ] **Step 2: `canvas/kinds.ts`**

```ts
export function kindToTldraw(kind: string): "rectangle" | "ellipse" | "diamond" | "note" | "text" | "draw" {
  if (kind === "rect") return "rectangle";
  if (kind === "ellipse") return "ellipse";
  if (kind === "diamond") return "diamond";
  if (kind === "sticky") return "note";
  if (kind === "text") return "text";
  if (kind === "freeform") return "draw";
  return "rectangle";
}
```

- [ ] **Step 3: `canvas/from-canvas-state.ts`**

```ts
import type { TLShapePartial } from "tldraw";
import { kindToTldraw } from "./kinds";

export function nodeToShape(n: { id: string; kind: string; x: number; y: number; w?: number; h?: number; label?: string }): TLShapePartial {
  const tld = kindToTldraw(n.kind);
  if (tld === "note") {
    return { id: `shape:${n.id}` as any, type: "note", x: n.x, y: n.y, props: { text: n.label ?? "" }, meta: { canvasId: n.id, kind: n.kind } };
  }
  if (tld === "text") {
    return { id: `shape:${n.id}` as any, type: "text", x: n.x, y: n.y, props: { text: n.label ?? "" }, meta: { canvasId: n.id, kind: n.kind } };
  }
  if (tld === "draw") {
    return { id: `shape:${n.id}` as any, type: "draw", x: n.x, y: n.y, meta: { canvasId: n.id, kind: n.kind } };
  }
  return {
    id: `shape:${n.id}` as any, type: "geo", x: n.x, y: n.y,
    props: { geo: tld, w: n.w ?? 120, h: n.h ?? 60, text: n.label ?? "" },
    meta: { canvasId: n.id, kind: n.kind },
  };
}
```

> **Note:** Exact tldraw 5.x shape `type`/`props` field names need verifying against `node_modules/tldraw/dist/types/index.d.ts` once installed. Names `geo`/`note`/`draw`/`text` reflect npm tldraw@3.x (= SDK 5.x).

- [ ] **Step 4: Replace `App.tsx`**

```tsx
import { useEffect, useState } from "react";
import { Tldraw, type Editor } from "tldraw";
import "tldraw/tldraw.css";
import { getState } from "./transport/api";
import { nodeToShape } from "./canvas/from-canvas-state";

export function App({ room }: { room: string }) {
  const [editor, setEditor] = useState<Editor | null>(null);
  useEffect(() => {
    if (!editor) return;
    let active = true;
    (async () => {
      const s = await getState();
      if (!active) return;
      const shapes = s.canvas.nodes.map(nodeToShape);
      if (shapes.length) editor.createShapes(shapes);
    })();
    return () => { active = false; };
  }, [editor]);

  return (
    <div style={{ height: "100vh" }}>
      <div style={{ position: "fixed", top: 8, left: 8, zIndex: 1000 }}>room: <code>{room}</code></div>
      <Tldraw onMount={setEditor} />
    </div>
  );
}
```

- [ ] **Step 5: Smoke test**

```bash
# t1
cd apps/backend && bun src/index.ts
# t2
cd apps/frontend && bun run dev
# t3
curl -X POST 'localhost:8787/api/patch?room=test' -H 'content-type: application/json' \
  -d '{"ops":[{"op":"add","target":"node","value":{"id":"n1","kind":"rect","x":50,"y":50,"label":"hi"}}],"source":"ai"}'
# открой http://localhost:5173/?room=test
```
Expected: rectangle "hi" виден.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend
git commit -m "feat(frontend): load CanvasState and render initial shapes"
```

---

## Task 13: Frontend — WS subscription with echo-guard

**Files:**
- Create: `apps/frontend/src/transport/ws.ts`
- Create: `apps/frontend/src/canvas/echo-guard.ts`
- Modify: `apps/frontend/src/App.tsx`

- [ ] **Step 1: `transport/ws.ts`**

```ts
import { room } from "./api";

export type WsMessage =
  | { kind: "hello"; version: number }
  | { kind: "patch"; source: "ai" | "user"; ops: any[]; version: number; originClientId?: string }
  | { kind: "prompt-created"; prompt: any }
  | { kind: "prompt-resolved"; id: string; response?: string };

export function openWs(handlers: { onPatch?: (m: any) => void; onPromptCreated?: (m: any) => void; onPromptResolved?: (m: any) => void }) {
  let ws: WebSocket | null = null;
  let attempt = 0;
  let stopped = false;
  const connect = () => {
    ws = new WebSocket(`ws://${location.host}/ws?room=${encodeURIComponent(room)}`);
    ws.onopen = () => { attempt = 0; };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data as string) as WsMessage;
      if (m.kind === "patch") handlers.onPatch?.(m);
      if (m.kind === "prompt-created") handlers.onPromptCreated?.(m);
      if (m.kind === "prompt-resolved") handlers.onPromptResolved?.(m);
    };
    ws.onclose = () => {
      if (stopped) return;
      const d = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6)); attempt++;
      setTimeout(connect, d);
    };
    ws.onerror = () => ws?.close();
  };
  connect();
  return () => { stopped = true; ws?.close(); };
}
```

- [ ] **Step 2: `canvas/echo-guard.ts`**

```ts
const seen = new Set<string>();
export function rememberOurOpId(id: string) { seen.add(id); setTimeout(() => seen.delete(id), 10_000); }
export function isOurOp(id?: string) { return !!id && seen.has(id); }
```

- [ ] **Step 3: Update `App.tsx` to subscribe**

Add inside `useEffect`:

```tsx
import { openWs } from "./transport/ws";
import { isOurOp } from "./canvas/echo-guard";

// after initial state load:
const close = openWs({
  onPatch: (m) => {
    if (isOurOp(m.originClientId)) return;
    for (const op of m.ops) {
      if (op.op === "add" && op.target === "node") editor.createShapes([nodeToShape(op.value)]);
      else if (op.op === "delete" && op.target === "node") editor.deleteShapes([`shape:${op.id}` as any]);
      else if (op.op === "update" && op.target === "node") {
        editor.updateShapes([{ id: `shape:${op.id}` as any, type: "geo", x: op.set.x, y: op.set.y }]);
      }
    }
  },
});
return () => { active = false; close(); };
```

- [ ] **Step 4: Smoke (browser doesn't refresh)**

```bash
curl -X POST 'localhost:8787/api/patch?room=test' -H 'content-type: application/json' \
  -d '{"ops":[{"op":"add","target":"node","value":{"id":"x1","kind":"ellipse","x":200,"y":100,"label":"live"}}],"source":"ai"}'
```

- [ ] **Step 5: Commit**

```bash
git add apps/frontend
git commit -m "feat(frontend): WebSocket subscription with echo-guard"
```

---

## Task 14: Frontend — user edits → POST /api/patch

**Files:**
- Create: `apps/frontend/src/canvas/to-patch.ts`
- Modify: `apps/frontend/src/App.tsx`

- [ ] **Step 1: `canvas/to-patch.ts`**

```ts
import type { TLShape, TLShapeId } from "tldraw";

export type SimpleOp =
  | { op: "add"; target: "node"; value: { id: string; kind: string; x: number; y: number; w?: number; h?: number; label?: string } }
  | { op: "update"; target: "node"; id: string; set: { x?: number; y?: number; label?: string } }
  | { op: "delete"; target: "node"; id: string };

const idFrom = (id: TLShapeId) => (id as unknown as string).replace(/^shape:/, "");

export function shapeToNode(s: TLShape): SimpleOp["value"] | null {
  if (s.type === "geo") {
    return {
      id: idFrom(s.id),
      kind: geoToKind((s as any).props?.geo ?? "rectangle"),
      x: s.x, y: s.y,
      w: (s as any).props?.w, h: (s as any).props?.h,
      label: (s as any).props?.text ?? undefined,
    };
  }
  if (s.type === "note") return { id: idFrom(s.id), kind: "sticky", x: s.x, y: s.y, label: (s as any).props?.text ?? "" };
  if (s.type === "text") return { id: idFrom(s.id), kind: "text", x: s.x, y: s.y, label: (s as any).props?.text ?? "" };
  if (s.type === "draw") return { id: idFrom(s.id), kind: "freeform", x: s.x, y: s.y };
  return null;
}

function geoToKind(g: string) { return g === "rectangle" ? "rect" : g === "ellipse" ? "ellipse" : g === "diamond" ? "diamond" : "rect"; }

export function diffToOps(prev: Map<string, TLShape>, next: Map<string, TLShape>): SimpleOp[] {
  const ops: SimpleOp[] = [];
  for (const [id, s] of next) {
    const before = prev.get(id);
    if (!before) { const v = shapeToNode(s); if (v) ops.push({ op: "add", target: "node", value: v }); }
    else if (s.x !== before.x || s.y !== before.y) ops.push({ op: "update", target: "node", id: idFrom(s.id), set: { x: s.x, y: s.y } });
  }
  for (const [id, s] of prev) if (!next.has(id)) ops.push({ op: "delete", target: "node", id: idFrom(s.id) });
  return ops;
}
```

- [ ] **Step 2: Subscribe in `App.tsx`**

```tsx
import { diffToOps } from "./canvas/to-patch";
import { rememberOurOpId } from "./canvas/echo-guard";
import { sendPatch } from "./transport/api";
import type { TLShape } from "tldraw";

// inside same useEffect after the WS setup:
const snap = new Map<string, TLShape>(editor.getCurrentPageShapes().map((s) => [s.id as unknown as string, s]));
const unsubStore = editor.store.listen(() => {
  const cur = new Map(editor.getCurrentPageShapes().map((s) => [s.id as unknown as string, s]));
  const ops = diffToOps(snap, cur);
  snap.clear(); for (const [k, v] of cur) snap.set(k, v);
  if (ops.length === 0) return;
  const cid = crypto.randomUUID();
  rememberOurOpId(cid);
  void sendPatch(ops as any, cid);
}, { source: "user", scope: "document" });

return () => { active = false; close(); unsubStore(); };
```

- [ ] **Step 3: Smoke**

В браузере: создай прямоугольник, двигай, удали. В DevTools Network — `POST /api/patch` каждый раз.
Открой вторую вкладку с тем же `?room=` — изменения видны.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend
git commit -m "feat(frontend): user edits emit PatchOp with echo-prevention"
```

---

## Task 15: didraw-client — shared HTTP client

**Files:**
- Create: `packages/didraw-client/package.json`
- Create: `packages/didraw-client/src/index.ts`
- Create: `packages/didraw-client/tests/index.test.ts`

- [ ] **Step 1: `package.json`**

```json
{
  "name": "@didraw/client",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": { "test": "bun test" }
}
```

- [ ] **Step 2: Failing test**

```ts
// packages/didraw-client/tests/index.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { CanvasClient } from "../src/index";
import { startServer } from "../../../apps/backend/src/index";

let srv: { port: number; close: () => Promise<void> };
beforeAll(async () => { srv = await startServer({ inMemory: true, port: 0 }); });
afterAll(async () => { await srv.close(); });

describe("CanvasClient", () => {
  test("uses CLAUDE_SESSION_ID from env as default room", () => {
    process.env.CLAUDE_SESSION_ID = "abc";
    const c = new CanvasClient({ baseUrl: `http://localhost:${srv.port}` });
    expect(c.room).toBe("abc");
    delete process.env.CLAUDE_SESSION_ID;
  });

  test("getState returns empty for new room", async () => {
    const c = new CanvasClient({ baseUrl: `http://localhost:${srv.port}`, room: "test1" });
    const s = await c.getState();
    expect(s.canvas.nodes).toEqual([]);
  });

  test("applyPatch + getState round-trip", async () => {
    const c = new CanvasClient({ baseUrl: `http://localhost:${srv.port}`, room: "test2" });
    const r = await c.applyPatch([{ op: "add", target: "node", value: { id: "n1", kind: "rect", x: 0, y: 0 } }]);
    expect(r.ok).toBe(true); expect(r.version).toBe(1);
    const s = await c.getState();
    expect(s.canvas.nodes[0].id).toBe("n1");
  });
});
```

- [ ] **Step 3: Implement `packages/didraw-client/src/index.ts`**

```ts
export type ClientOpts = { baseUrl?: string; room?: string };

export class CanvasClient {
  readonly room: string;
  private base: string;

  constructor(opts: ClientOpts = {}) {
    this.room = opts.room ?? process.env.CLAUDE_SESSION_ID ?? "default";
    this.base = opts.baseUrl ?? `http://localhost:${process.env.DIDRAW_PORT ?? 8787}`;
  }

  private q(extra: Record<string, string | number | undefined> = {}) {
    const params = new URLSearchParams({ room: this.room });
    for (const [k, v] of Object.entries(extra)) if (v !== undefined) params.set(k, String(v));
    return params.toString();
  }

  async getState(opts: { fmt?: "full" | "compact"; since?: number } = {}) {
    const r = await fetch(`${this.base}/api/state?${this.q({ fmt: opts.fmt ?? "compact", since: opts.since })}`);
    return r.json();
  }

  async applyPatch(ops: unknown[], opts: { clientOpId?: string; source?: "ai" | "user" } = {}) {
    const r = await fetch(`${this.base}/api/patch?${this.q()}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ops, source: opts.source ?? "ai", clientOpId: opts.clientOpId }),
    });
    return r.json();
  }

  async importMermaid(source: string, layout: "elk" | "keep" = "elk") {
    const r = await fetch(`${this.base}/api/import/mermaid?${this.q()}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ source, layout }),
    });
    return r.json();
  }

  async layout(algorithm: "elk-layered" | "dagre", nodeIds?: string[]) {
    const r = await fetch(`${this.base}/api/layout?${this.q()}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ algorithm, nodeIds }),
    });
    return r.json();
  }

  async getPrompts(status: "pending" | "resolved" | "dismissed" | "all" = "pending") {
    const r = await fetch(`${this.base}/api/prompts?${this.q({ status })}`);
    return r.json();
  }

  async resolvePrompt(id: string, response?: string) {
    const r = await fetch(`${this.base}/api/prompt/${id}/resolve?${this.q()}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ response }),
    });
    return r.json();
  }

  async dismissPrompt(id: string) {
    const r = await fetch(`${this.base}/api/prompt/${id}/dismiss?${this.q()}`, { method: "POST" });
    return r.json();
  }

  async clear() {
    const s = await this.getState({ fmt: "full" });
    const ops = [
      ...s.canvas.edges.map((e: any) => ({ op: "delete", target: "edge", id: e.id })),
      ...s.canvas.nodes.map((n: any) => ({ op: "delete", target: "node", id: n.id })),
      ...s.canvas.groups.map((g: any) => ({ op: "delete", target: "group", id: g.id })),
    ];
    return this.applyPatch(ops);
  }

  async health(): Promise<boolean> {
    try { return (await fetch(`${this.base}/healthz`)).ok; } catch { return false; }
  }
}
```

- [ ] **Step 4: Run — PASS, commit**

```bash
cd packages/didraw-client && bun test
git add packages/didraw-client
git commit -m "feat(client): shared CanvasClient HTTP wrapper for CLI/MCP/tests"
```

---

## Task 16: didraw CLI — lifecycle (daemon, self-spawn architecture)

**Files:**
- Create: `packages/didraw-cli/package.json`
- Create: `packages/didraw-cli/src/profile.ts`
- Create: `packages/didraw-cli/src/daemon.ts`
- Create: `packages/didraw-cli/src/index.ts`

**Архитектура (важно — это решает release-binary проблему):**

CLI и backend живут в **одном бинарнике** в release-сборке. `didraw daemon start` НЕ спавнит путь к `apps/backend/src/index.ts` (в release-binary такого файла нет). Вместо этого daemon spawn'ит **сам себя** (`process.execPath`) с командой `internal-server`. Эта команда импортирует `startServer()` из `@didraw/backend` и держит процесс. Так работает и для dev (запуск через `bun src/index.ts internal-server`), и для compiled binary (`./didraw internal-server`).

PID-файл — **profile-specific** (`.didraw-${profile}.pid`), чтобы dev и release могли работать параллельно.

- [ ] **Step 1: `package.json`** (depends on backend для импорта `startServer`)

```json
{
  "name": "didraw",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "bin": { "didraw": "src/index.ts" },
  "scripts": { "test": "bun test" },
  "dependencies": {
    "@didraw/client": "workspace:*",
    "@didraw/backend": "workspace:*"
  }
}
```

> **Note:** Workspace import позволяет `bun build --compile` (Task 34) вшить весь backend, frontend-dist и CLI в один binary.

- [ ] **Step 2: `profile.ts`** (vendor-style helper, чтобы избежать import цикла)

```ts
import { homedir } from "node:os";
import { join } from "node:path";

export type Profile = "dev" | "release" | "debug";

export function parseProfile(argv: string[]): Profile {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--profile") return argv[i + 1] as Profile;
  }
  return (process.env.DIDRAW_PROFILE ?? "release") as Profile;
}

export function applyProfile(p: Profile) {
  process.env.DIDRAW_PROFILE = p;
}

export function pidFile(p: Profile): string {
  return join(homedir(), ".claude", `.didraw-${p}.pid`);
}

export function portFor(p: Profile): number {
  if (process.env.DIDRAW_PORT) return Number(process.env.DIDRAW_PORT);
  return p === "dev" ? 8788 : 8787;
}
```

- [ ] **Step 3: `daemon.ts`** (self-spawn, profile-aware)

```ts
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { CanvasClient } from "@didraw/client";
import { type Profile, pidFile, portFor } from "./profile";
import { getConfig } from "@didraw/backend/src/config";

async function isAlive(pid: number): Promise<boolean> {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function isHealthy(port: number): Promise<boolean> {
  try { return (await fetch(`http://localhost:${port}/healthz`)).ok; } catch { return false; }
}

export async function status(profile: Profile) {
  const port = portFor(profile);
  const file = pidFile(profile);
  if (!existsSync(file)) return { running: false, profile, port };
  const pid = Number(readFileSync(file, "utf8"));
  if (!(await isAlive(pid))) return { running: false, profile, port };
  return { running: await isHealthy(port), pid, profile, port };
}

export async function start(profile: Profile) {
  const s = await status(profile);
  if (s.running) { console.log(JSON.stringify({ ok: true, already: true, ...s })); return; }
  const port = portFor(profile);
  // Self-spawn: тот же binary, с командой `internal-server` и явным --profile
  const child = spawn(process.execPath, [process.argv[1], "internal-server", "--profile", profile], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, DIDRAW_PROFILE: profile, DIDRAW_PORT: String(port) },
  });
  child.unref();
  writeFileSync(pidFile(profile), String(child.pid));
  console.log(JSON.stringify({ ok: true, pid: child.pid, profile, port }));
}

export async function ensure(profile: Profile) {
  const s = await status(profile);
  if (s.running) { console.log(JSON.stringify({ ok: true, already: true, ...s })); return; }
  await start(profile);
  const port = portFor(profile);
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await isHealthy(port)) return;
  }
  console.error(JSON.stringify({ ok: false, error: `didraw: not healthy within 5s on :${port}` }));
  process.exit(3);
}

export async function stop(profile: Profile) {
  const file = pidFile(profile);
  if (!existsSync(file)) { console.log(JSON.stringify({ ok: true, already: true, profile })); return; }
  const pid = Number(readFileSync(file, "utf8"));
  try { process.kill(pid, "SIGTERM"); } catch {}
  // Ждём graceful exit до 2 секунд (синхронно с config.gracefulShutdownMs)
  const deadline = Date.now() + getConfig().gracefulShutdownMs;
  while (Date.now() < deadline) {
    if (!(await isAlive(pid))) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (await isAlive(pid)) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  unlinkSync(file);
  console.log(JSON.stringify({ ok: true, stopped: pid, profile }));
}
```

- [ ] **Step 4: `index.ts`** (dispatcher with internal-server)

```ts
#!/usr/bin/env bun
import { ensure, start, status, stop } from "./daemon";
import { parseProfile, applyProfile } from "./profile";

const argv = process.argv.slice(2);
// Profile applied as early as possible, ДО import'ов config-зависимых модулей
const profile = parseProfile(argv);
applyProfile(profile);

const cmd = argv[0];
const sub = argv[1];

async function main() {
  // internal-server — приватная команда: spawn'ится из self при `daemon start`
  if (cmd === "internal-server") {
    const { startServer } = await import("@didraw/backend/src/index");
    const { getConfig } = await import("@didraw/backend/src/config");
    const c = getConfig();
    const srv = await startServer({ port: c.port });
    console.log(`[didraw] listening on :${srv.port} (profile=${c.profile})`);
    // Hold process — SIGTERM handler в startServer обработает graceful shutdown
    await new Promise(() => {});
    return;
  }

  if (cmd === "daemon") {
    if (sub === "start") return start(profile);
    if (sub === "stop") return stop(profile);
    if (sub === "status") return console.log(JSON.stringify(await status(profile), null, 2));
    if (sub === "ensure" || sub === "--ensure") return ensure(profile);
    usage(); process.exit(1);
  }
  usage(); process.exit(cmd ? 1 : 0);
}

function usage() {
  console.log(`didraw <command> [--profile dev|release|debug]

Lifecycle:
  daemon start|stop|status|ensure
  open <room>
  list
  export <room> --to <path>
  rm <room>

Data:
  state    --room <id> [--compact] [--since <v>]
  patch    --room <id> --stdin
  import   mermaid --room <id> --stdin | --file <path>
  layout   --room <id> --algorithm elk-layered [--node-ids <id,...>]
  prompts  list --room <id> [--status pending|resolved|dismissed|all]
  prompts  resolve <id> --room <id> [--response <text>]
  prompts  dismiss <id> --room <id>
  clear    --room <id> --confirm

Versioning:
  version
  update [--check] [--channel stable|nightly|dev]

(internal-server: private subcommand used by daemon self-spawn)
`);
}

main().catch((e) => { console.error(JSON.stringify({ ok: false, error: String(e) })); process.exit(1); });
```

- [ ] **Step 5: Manual smoke (parallel dev + release)**

```bash
cd packages/didraw-cli

# Release on 8787
bun src/index.ts daemon ensure
bun src/index.ts daemon status
# Dev on 8788
bun src/index.ts daemon ensure --profile dev
bun src/index.ts daemon status --profile dev

curl -s localhost:8787/healthz   # release
curl -s localhost:8788/healthz   # dev

bun src/index.ts daemon stop
bun src/index.ts daemon stop --profile dev
```
Expected: оба профиля работают одновременно, не конфликтуют по pid-файлу или порту.

- [ ] **Step 6: Commit**

```bash
git add packages/didraw-cli
git commit -m "feat(cli): didraw daemon with self-spawn + profile-specific pid (release-binary ready)"
```

---

## Task 17: didraw CLI — open, list, export, rm

**Files:**
- Create: `packages/didraw-cli/src/lifecycle.ts`
- Modify: `packages/didraw-cli/src/index.ts`

- [ ] **Step 1: `lifecycle.ts`** (profile-aware paths и port)

```ts
import { readdirSync, copyFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ensure } from "./daemon";
import { getConfig } from "@didraw/backend/src/config";
import type { Profile } from "./profile";
import { portFor } from "./profile";

const canvasDir = () => getConfig().storageDir;   // уважает текущий profile (canvas vs canvas-dev)

export async function open(room: string, profile: Profile) {
  await ensure(profile);
  const url = `http://localhost:${portFor(profile)}/?room=${encodeURIComponent(room)}`;
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
  console.log(JSON.stringify({ ok: true, url, profile }));
}

export function list() {
  const dir = canvasDir();
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    console.log(JSON.stringify({ ok: true, rooms: files.map((f) => f.replace(/\.json$/, "")), dir }));
  } catch {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    console.log(JSON.stringify({ ok: true, rooms: [], dir }));
  }
}

export function exportRoom(room: string, to: string) {
  const src = `${canvasDir()}/${room}.json`;
  if (!existsSync(src)) { console.error(JSON.stringify({ ok: false, error: "not found" })); process.exit(2); }
  copyFileSync(src, to);
  console.log(JSON.stringify({ ok: true, from: src, to }));
}

export async function rmRoom(room: string) {
  const p = `${canvasDir()}/${room}.json`;
  if (!existsSync(p)) { console.error(JSON.stringify({ ok: false, error: "not found" })); process.exit(2); }
  const rl = createInterface({ input: stdin, output: stdout });
  const ans = await rl.question(`Delete ${room} (profile=${getConfig().profile})? [y/N] `);
  rl.close();
  if (ans.toLowerCase() === "y") { unlinkSync(p); console.log(JSON.stringify({ ok: true, deleted: room })); }
  else console.log(JSON.stringify({ ok: false, error: "cancelled" }));
}
```

- [ ] **Step 2: Wire into `index.ts`**

After daemon handling:

```ts
import { open, list, exportRoom, rmRoom } from "./lifecycle";

// inside main (profile уже применён в начале файла):
if (cmd === "open") { if (!argv[1]) { usage(); process.exit(1); } return open(argv[1], profile); }
if (cmd === "list") return list();
if (cmd === "export") {
  const [, room, flag, to] = argv;
  if (!room || flag !== "--to" || !to) { usage(); process.exit(1); }
  return exportRoom(room, to);
}
if (cmd === "rm") { if (!argv[1]) { usage(); process.exit(1); } return rmRoom(argv[1]); }
```

- [ ] **Step 3: Manual smoke**

```bash
bun src/index.ts open scratch
bun src/index.ts list
```

- [ ] **Step 4: Commit**

```bash
git add packages/didraw-cli
git commit -m "feat(cli): didraw open/list/export/rm"
```

---

## Task 18: didraw CLI — data commands (state, patch, clear)

**Files:**
- Create: `packages/didraw-cli/src/data.ts`
- Create: `packages/didraw-cli/tests/data.test.ts`
- Modify: `packages/didraw-cli/src/index.ts`

- [ ] **Step 1: Failing test (CLI in → JSON out)**

```ts
// packages/didraw-cli/tests/data.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startServer } from "../../../apps/backend/src/index";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

let srv: { port: number; close: () => Promise<void> };
const CLI = join(import.meta.dir, "..", "src", "index.ts");
const env = (room: string) => ({ ...process.env, DIDRAW_PORT: String(srv.port), CLAUDE_SESSION_ID: room });

beforeAll(async () => { srv = await startServer({ inMemory: true, port: 0 }); });
afterAll(async () => { await srv.close(); });

describe("didraw data commands", () => {
  test("state --compact on empty room", () => {
    const r = spawnSync("bun", [CLI, "state", "--compact"], { env: env("d1"), encoding: "utf8" });
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.canvas.nodes).toEqual([]);
  });

  test("patch --stdin applies ops", () => {
    const body = JSON.stringify({
      ops: [{ op: "add", target: "node", value: { id: "n1", kind: "rect", x: 0, y: 0 } }],
      source: "ai",
    });
    const r = spawnSync("bun", [CLI, "patch", "--stdin"], { env: env("d2"), input: body, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, version: 1 });
  });

  test("patch with invalid ops → exit 1, error in stdout", () => {
    const body = JSON.stringify({ ops: [{ op: "add", target: "edge", value: { id: "e", from: { kind: "node", id: "missing" }, to: { kind: "node", id: "x" } } }], source: "ai" });
    const r = spawnSync("bun", [CLI, "patch", "--stdin"], { env: env("d3"), input: body, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).ok).toBe(false);
  });

  test("clear empties room", () => {
    const env4 = env("d4");
    spawnSync("bun", [CLI, "patch", "--stdin"], {
      env: env4,
      input: JSON.stringify({ ops: [{ op: "add", target: "node", value: { id: "n1", kind: "rect", x: 0, y: 0 } }], source: "ai" }),
      encoding: "utf8",
    });
    const r = spawnSync("bun", [CLI, "clear", "--confirm"], { env: env4, encoding: "utf8" });
    expect(r.status).toBe(0);
    const after = spawnSync("bun", [CLI, "state"], { env: env4, encoding: "utf8" });
    expect(JSON.parse(after.stdout).canvas.nodes).toEqual([]);
  });
});
```

- [ ] **Step 2: Implement `data.ts`**

```ts
import { CanvasClient } from "@didraw/client";

type Args = { room?: string; compact?: boolean; since?: number; confirm?: boolean };

export function parseArgs(argv: string[]): Args {
  const a: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--room") a.room = argv[++i];
    else if (k === "--compact") a.compact = true;
    else if (k === "--since") a.since = Number(argv[++i]);
    else if (k === "--confirm") a.confirm = true;
  }
  return a;
}

export async function cmdState(argv: string[]) {
  const a = parseArgs(argv);
  const c = new CanvasClient({ room: a.room });
  try {
    const r = await c.getState({ fmt: a.compact ? "compact" : "full", since: a.since });
    console.log(JSON.stringify(r));
  } catch (e) { fail(e); }
}

export async function cmdPatch(argv: string[]) {
  const a = parseArgs(argv);
  if (!argv.includes("--stdin")) { console.error(JSON.stringify({ ok: false, error: "expected --stdin" })); process.exit(1); }
  const raw = await readStdin();
  let body: any;
  try { body = JSON.parse(raw); } catch { console.error(JSON.stringify({ ok: false, error: "invalid JSON on stdin" })); process.exit(1); }
  const c = new CanvasClient({ room: a.room });
  try {
    const r = await c.applyPatch(body.ops, { source: body.source ?? "ai", clientOpId: body.clientOpId });
    console.log(JSON.stringify(r));
    if (r.ok === false) process.exit(1);
  } catch (e) { fail(e); }
}

export async function cmdClear(argv: string[]) {
  const a = parseArgs(argv);
  if (!a.confirm) { console.error(JSON.stringify({ ok: false, error: "expected --confirm" })); process.exit(1); }
  const c = new CanvasClient({ room: a.room });
  try { console.log(JSON.stringify(await c.clear())); } catch (e) { fail(e); }
}

async function readStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) data += String(chunk);
  return data;
}

function fail(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  const status = msg.includes("ECONNREFUSED") ? 3 : 1;
  console.error(JSON.stringify({ ok: false, error: msg }));
  process.exit(status);
}
```

- [ ] **Step 3: Wire into `index.ts`**

```ts
import { cmdState, cmdPatch, cmdClear } from "./data";

// inside main, before daemon:
if (cmd === "state") return cmdState(argv.slice(1));
if (cmd === "patch") return cmdPatch(argv.slice(1));
if (cmd === "clear") return cmdClear(argv.slice(1));
```

- [ ] **Step 4: Run — PASS, commit**

```bash
cd packages/didraw-cli && bun test
git add packages/didraw-cli
git commit -m "feat(cli): didraw state, patch --stdin, clear with integration tests"
```

---

## Task 19: draw skill — SKILL.md with didraw cheat-sheet

**Files:**
- Create: `.claude/skills/draw/SKILL.md`

- [ ] **Step 1: Create**

```markdown
---
name: draw
description: Use when user mentions canvas, drawing, schemas, architecture diagrams, or says "нарисуй", "доска", "схема", "обнови canvas", or invokes /draw. Injects current canvas state and pending user prompts; AI uses didraw CLI through Bash to update the board.
---

# draw

You have a live canvas board for this Claude Code session. State below is auto-injected; use the `didraw` CLI through Bash to read and modify it.

## Current canvas state (compact JSON)

!`didraw state --compact 2>/dev/null || echo '{"canvas":{"nodes":[],"edges":[],"groups":[]},"version":0}'`

## Pending user prompts

!`didraw prompts list --status pending 2>/dev/null || echo '{"prompts":[]}'`

## Commands (use the Bash tool)

Read:
```
didraw state --compact                          # full snapshot
didraw state --since <last_version>             # diff only
```

Write:
```
echo '{"ops":[...],"source":"ai","clientOpId":"<uuid>"}' | didraw patch --stdin
didraw clear --confirm                          # wipe canvas (destructive!)
```

Bulk-import a graph (Mermaid):
```
didraw import mermaid --stdin <<EOF
graph LR
  app --> server --> db
EOF
```
Auto-layout new nodes:
```
didraw layout --algorithm elk-layered
didraw layout --node-ids n1,n2          # only specific
```

Targeted prompts (user-attached questions on objects):
```
didraw prompts list --status pending
didraw prompts resolve <id> --response "text"
didraw prompts dismiss <id>
```

## PatchOp format

- `{op:"add", target:"node"|"edge"|"group", value:{...}}` — create
- `{op:"update", target, id, set:{...}}` — partial; `style`/`meta` deep-merge
- `{op:"delete", target, id}` — remove

## Node fields

- `id` (UUID), `kind` (`rect|ellipse|diamond|sticky|text|freeform`), `x`, `y`
- Optional: `w`, `h` (default 120×60; sticky 200×120), `label`, `style{color,fill,stroke,fontSize}`, `meta`

## Edge fields

- `id`, `from`, `to` — endpoints are `{kind:"node",id}` (anchored) or `{kind:"point",x,y}` (free in space)
- Optional: `label`, `style{color,dashed,arrow:"none"|"to"|"both"}`

## Coordinates

Pixels, centre of canvas ≈ (0,0). Spacing 150–250px between nodes feels natural.

## If you reply to a pending user prompt

Always call `didraw prompts resolve <id> --response "what you did"` after — so the marker on the canvas updates and the user sees your response.
```

- [ ] **Step 2: Manual test**

In Claude Code: backend running, sat `/draw нарисуй простой web app: client → api → db`.
Expected: skill body inserted, AI runs `echo '{...}' | didraw patch --stdin` через Bash, browser обновляется.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/draw
git commit -m "feat(.claude): draw skill with didraw cheat-sheet and state injection"
```

---

## Task 20: SessionStart hook

**Files:**
- Create: `.claude/settings.json`

- [ ] **Step 1: Create**

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

Start fresh Claude Code session:
```bash
# inside session, immediately
curl -s localhost:8787/healthz
```
Expected: `{"ok":true}`. Backend поднят автоматически.

- [ ] **Step 3: Commit**

```bash
git add .claude/settings.json
git commit -m "feat(.claude): SessionStart hook starts didraw daemon"
```

---

## Task 21: Backend — stub /api/import/mermaid and /api/layout

**Files:**
- Create: `apps/backend/src/routes/import-mermaid.ts`
- Create: `apps/backend/src/routes/layout.ts`
- Modify: `apps/backend/src/index.ts`

- [ ] **Step 1: Stubs**

```ts
// apps/backend/src/routes/import-mermaid.ts
import { Hono } from "hono";
export const importMermaidRoutes = new Hono().post("/api/import/mermaid", (c) =>
  c.json({ ok: false, error: "not implemented (Task 22)" }, 501));
```

```ts
// apps/backend/src/routes/layout.ts
import { Hono } from "hono";
export const layoutRoutes = new Hono().post("/api/layout", (c) =>
  c.json({ ok: false, error: "not implemented (Task 24)" }, 501));
```

- [ ] **Step 2: Wire in `makeApp`**

```ts
app.route("/", importMermaidRoutes);
app.route("/", layoutRoutes);
```

- [ ] **Step 3: Commit**

```bash
git add apps/backend
git commit -m "feat(backend): stub /api/import/mermaid and /api/layout (501)"
```

---

## Task 22: Backend — Mermaid import (per ADR-0001)

Read `docs/decisions/0001-mermaid-import-location.md`. Implement Variant A (backend) or Variant B (frontend) accordingly.

### Variant A: backend

**Files:**
- Create: `apps/backend/src/mermaid-import.ts`
- Modify: `apps/backend/src/routes/import-mermaid.ts`
- Create: `apps/backend/tests/mermaid-import.test.ts`

- [ ] **Step A1: Test**

```ts
// apps/backend/tests/mermaid-import.test.ts
import { describe, test, expect } from "bun:test";
import { mermaidToOps } from "../src/mermaid-import";

describe("mermaidToOps", () => {
  test("graph LR a-->b → 2 nodes + 1 edge", async () => {
    const ops = await mermaidToOps("graph LR\n a --> b");
    expect(ops.filter((o) => o.op === "add" && o.target === "node")).toHaveLength(2);
    expect(ops.filter((o) => o.op === "add" && o.target === "edge")).toHaveLength(1);
  });

  test("invalid throws", async () => {
    await expect(mermaidToOps("not mermaid at all!!!")).rejects.toThrow();
  });
});
```

- [ ] **Step A2: Implement**

```ts
import type { PatchOp } from "./types";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
// @ts-ignore
globalThis.window ??= dom.window;
// @ts-ignore
globalThis.document ??= dom.window.document;

const mod = await import("@tldraw/mermaid");

export async function mermaidToOps(source: string): Promise<PatchOp[]> {
  // @ts-expect-error — runtime API verified during Task 4 spike
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

- [ ] **Step A3: Replace route**

```ts
import { Hono } from "hono";
import { mermaidToOps } from "../mermaid-import";
import { applyPatch } from "../patch";
import type { Rooms } from "../rooms";
import type { WsHub } from "../ws";

export function importMermaidRoutes(rooms: Rooms, hub: WsHub) {
  return new Hono().post("/api/import/mermaid", async (c) => {
    const id = c.req.query("room") ?? "default";
    const body = await c.req.json().catch(() => null);
    if (!body?.source) return c.json({ ok: false, error: "missing source" }, 400);
    let ops;
    try { ops = await mermaidToOps(body.source); }
    catch (e) { return c.json({ ok: false, error: (e as Error).message }, 422); }

    const r = await rooms.get(id);
    const result = applyPatch(r.canvas, ops);
    if (!result.ok) return c.json({ ok: false, error: result.error }, 422);
    r.canvas = result.state; r.version += 1;
    r.opLog.push({ ops, source: "ai", version: r.version, at: Date.now() });
    r.dirty = true;
    hub.publish(id, { ops, source: "ai", version: r.version });
    return c.json({ ok: true, version: r.version, count: ops.length });
  });
}
```

### Variant B: frontend

Backend route accepts `{source}`, stores into `pendingImports[]`, broadcasts `{kind:"import-mermaid-request", source}`. Frontend listens, parses via `@tldraw/mermaid` client-side, then POSTs PatchOp[] as a normal patch. Skeleton in spec §4 fallback.

- [ ] **Common: tests pass, commit**

```bash
cd apps/backend && bun test tests/mermaid-import.test.ts
git add apps/backend
git commit -m "feat(backend): mermaid import per ADR-0001"
```

---

## Task 23: didraw CLI — import mermaid

**Files:**
- Create: `packages/didraw-cli/src/import.ts`
- Modify: `packages/didraw-cli/src/index.ts`
- Add: `packages/didraw-cli/tests/import.test.ts`

- [ ] **Step 1: Test**

```ts
// packages/didraw-cli/tests/import.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startServer } from "../../../apps/backend/src/index";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

let srv: { port: number; close: () => Promise<void> };
const CLI = join(import.meta.dir, "..", "src", "index.ts");
beforeAll(async () => { srv = await startServer({ inMemory: true, port: 0 }); });
afterAll(async () => { await srv.close(); });

test("didraw import mermaid --stdin", () => {
  const env = { ...process.env, DIDRAW_PORT: String(srv.port), CLAUDE_SESSION_ID: "im1" };
  const r = spawnSync("bun", [CLI, "import", "mermaid", "--stdin"], {
    env, input: "graph LR\n a --> b", encoding: "utf8",
  });
  expect(r.status).toBe(0);
  expect(JSON.parse(r.stdout).ok).toBe(true);
});
```

- [ ] **Step 2: Implement**

```ts
// packages/didraw-cli/src/import.ts
import { CanvasClient } from "@didraw/client";
import { promises as fs } from "node:fs";

export async function cmdImport(argv: string[]) {
  const sub = argv[0];
  if (sub !== "mermaid") { console.error(JSON.stringify({ ok: false, error: "only 'mermaid' supported" })); process.exit(1); }
  const rest = argv.slice(1);
  let room: string | undefined; let source: string | undefined; let useStdin = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--room") room = rest[++i];
    else if (rest[i] === "--stdin") useStdin = true;
    else if (rest[i] === "--file") source = await fs.readFile(rest[++i], "utf8");
  }
  if (useStdin) {
    source = "";
    for await (const chunk of process.stdin) source += String(chunk);
  }
  if (!source) { console.error(JSON.stringify({ ok: false, error: "no source provided" })); process.exit(1); }
  const c = new CanvasClient({ room });
  try {
    const r = await c.importMermaid(source);
    console.log(JSON.stringify(r));
    if (r.ok === false) process.exit(1);
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: String(e) })); process.exit(1);
  }
}
```

- [ ] **Step 3: Wire**

```ts
import { cmdImport } from "./import";
// in main:
if (cmd === "import") return cmdImport(argv.slice(1));
```

- [ ] **Step 4: Run, commit**

```bash
cd packages/didraw-cli && bun test tests/import.test.ts
git add packages/didraw-cli
git commit -m "feat(cli): didraw import mermaid --stdin/--file"
```

---

## Task 24: Backend — elkjs layout endpoint

**Files:**
- Create: `apps/backend/src/layout-engine.ts`
- Modify: `apps/backend/src/routes/layout.ts`
- Create: `apps/backend/tests/layout.test.ts`

- [ ] **Step 1: Test**

```ts
import { describe, test, expect } from "bun:test";
import { layoutNodes } from "../src/layout-engine";

test("layered layout assigns distinct x for chained nodes", async () => {
  const positions = await layoutNodes(
    [{ id: "a", w: 80, h: 40 }, { id: "b", w: 80, h: 40 }],
    [{ id: "e", from: { kind: "node", id: "a" }, to: { kind: "node", id: "b" } }],
  );
  expect(positions.a.x).not.toBe(positions.b.x);
});
```

- [ ] **Step 2: Implement**

```ts
// apps/backend/src/layout-engine.ts
import ELK from "elkjs/lib/elk.bundled.js";
import type { Edge, Node } from "./types";

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
  const res = await elk.layout(graph as any);
  const out: Record<string, { x: number; y: number }> = {};
  for (const c of res.children ?? []) out[c.id!] = { x: c.x ?? 0, y: c.y ?? 0 };
  return out;
}
```

- [ ] **Step 3: Replace `routes/layout.ts`**

```ts
import { Hono } from "hono";
import { layoutNodes } from "../layout-engine";
import { applyPatch } from "../patch";
import type { Rooms } from "../rooms";
import type { WsHub } from "../ws";
import type { PatchOp } from "../types";

export function layoutRoutes(rooms: Rooms, hub: WsHub) {
  return new Hono().post("/api/layout", async (c) => {
    const id = c.req.query("room") ?? "default";
    const { algorithm = "elk-layered", nodeIds } = await c.req.json().catch(() => ({}));
    const r = await rooms.get(id);
    const nodes = nodeIds ? r.canvas.nodes.filter((n) => nodeIds.includes(n.id)) : r.canvas.nodes;
    const positions = await layoutNodes(nodes, r.canvas.edges, algorithm);
    const ops: PatchOp[] = Object.entries(positions).map(([nid, p]) => ({
      op: "update", target: "node", id: nid, set: { x: p.x, y: p.y } as any,
    }));
    const result = applyPatch(r.canvas, ops);
    if (!result.ok) return c.json({ ok: false, error: result.error }, 422);
    r.canvas = result.state; r.version += 1;
    r.opLog.push({ ops, source: "ai", version: r.version, at: Date.now() });
    r.dirty = true;
    hub.publish(id, { ops, source: "ai", version: r.version });
    return c.json({ ok: true, version: r.version, count: ops.length });
  });
}
```

- [ ] **Step 4: Run, commit**

```bash
cd apps/backend && bun test
git add apps/backend
git commit -m "feat(backend): elkjs auto-layout endpoint"
```

---

## Task 25: didraw CLI — layout

**Files:**
- Create: `packages/didraw-cli/src/layout.ts`
- Modify: `packages/didraw-cli/src/index.ts`

- [ ] **Step 1: Implement**

```ts
import { CanvasClient } from "@didraw/client";

export async function cmdLayout(argv: string[]) {
  let room: string | undefined; let algorithm: "elk-layered" | "dagre" = "elk-layered"; let nodeIds: string[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--room") room = argv[++i];
    else if (argv[i] === "--algorithm") algorithm = argv[++i] as any;
    else if (argv[i] === "--node-ids") nodeIds = argv[++i].split(",");
  }
  const c = new CanvasClient({ room });
  try {
    const r = await c.layout(algorithm, nodeIds);
    console.log(JSON.stringify(r));
    if (r.ok === false) process.exit(1);
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: String(e) })); process.exit(1);
  }
}
```

- [ ] **Step 2: Wire and commit**

```ts
import { cmdLayout } from "./layout";
if (cmd === "layout") return cmdLayout(argv.slice(1));
```

```bash
git add packages/didraw-cli
git commit -m "feat(cli): didraw layout"
```

---

## Task 26: PreToolUse hook with additionalContext

**Files:**
- Create: `.claude/hooks/draw-prehook.sh`
- Modify: `.claude/settings.json`

- [ ] **Step 1: Hook script**

```bash
#!/usr/bin/env bash
set -euo pipefail

INPUT="$(cat)"
COMMAND="$(echo "$INPUT" | jq -r '.tool_input.command // ""')"

# No-op if not a canvas command
if [[ "$COMMAND" != *"didraw"* ]] && [[ "$COMMAND" != *"localhost:8787"* ]]; then
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":""}}\n'
  exit 0
fi

ROOM="${CLAUDE_SESSION_ID:-default}"
STATE_FILE="${HOME}/.claude/.draw-state-${ROOM}"
LAST=0
[[ -f "$STATE_FILE" ]] && LAST=$(cat "$STATE_FILE")

DIFF=$(didraw state --since "$LAST" 2>/dev/null || echo '{"diff":[],"version":0}')
NEW=$(echo "$DIFF" | jq -r '.version // 0')
echo "$NEW" > "$STATE_FILE"

D=$(echo "$DIFF" | jq -c '.diff // []')
if [[ "$D" == "[]" ]]; then
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":""}}\n'
else
  jq -n --arg ctx "## Canvas diff since v${LAST}\n\`\`\`json\n${D}\n\`\`\`" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$ctx}}'
fi
```

- [ ] **Step 2: chmod + register in settings.json**

```bash
chmod +x .claude/hooks/draw-prehook.sh
```

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "bun run --cwd ${CLAUDE_PROJECT_DIR:-.}/packages/didraw-cli src/index.ts daemon ensure" }] }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/draw-prehook.sh" }]
      }
    ]
  }
}
```

- [ ] **Step 3: Manual test**

In Claude Code: open canvas in browser, move a shape. Then ask AI to read canvas (which triggers `didraw state`). Verify AI sees the position change в `additionalContext`.

Also: run `git status` — verify hook does NOT inject anything (no-op).

- [ ] **Step 4: Commit**

```bash
git add .claude/hooks .claude/settings.json
git commit -m "feat(.claude): PreToolUse hook injects canvas diff for didraw Bash commands"
```

---

## Task 27: Backend — prompts endpoints

**Files:**
- Create: `apps/backend/src/routes/prompts.ts`
- Modify: `apps/backend/src/index.ts`
- Create: `apps/backend/tests/routes.prompts.test.ts`

- [ ] **Step 1: Test**

```ts
import { describe, test, expect } from "bun:test";
import { startServer } from "../src/index";

const json = (port: number, path: string, init?: RequestInit) =>
  fetch(`http://localhost:${port}${path}`, init).then((r) => r.json());

describe("prompts", () => {
  test("POST /api/prompt creates pending", async () => {
    const srv = await startServer({ inMemory: true, port: 0 });
    const b = await json(srv.port, "/api/prompt?room=a", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ selection: ["n1"], text: "?" }),
    });
    expect(b.id).toBeDefined(); expect(b.status).toBe("pending");
    await srv.close();
  });

  test("resolve + list", async () => {
    const srv = await startServer({ inMemory: true, port: 0 });
    const p = await json(srv.port, "/api/prompt?room=a", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ selection: [], text: "x" }),
    });
    await json(srv.port, `/api/prompt/${p.id}/resolve?room=a`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: "ok" }),
    });
    const r = await json(srv.port, "/api/prompts?room=a&status=resolved");
    expect(r.prompts[0].response).toBe("ok");
    await srv.close();
  });
});
```

- [ ] **Step 2: Implement**

```ts
// apps/backend/src/routes/prompts.ts
import { Hono } from "hono";
import type { Rooms } from "../rooms";
import type { WsHub } from "../ws";
import type { Prompt } from "../types";

export function promptRoutes(rooms: Rooms, hub: WsHub) {
  const r = new Hono();

  r.post("/api/prompt", async (c) => {
    const id = c.req.query("room") ?? "default";
    const body = await c.req.json();
    const p: Prompt = {
      id: crypto.randomUUID(), selection: body.selection ?? [],
      text: String(body.text ?? ""), createdAt: Date.now(), status: "pending",
    };
    const room = await rooms.get(id);
    room.prompts.push(p); room.dirty = true;
    hub.publishPrompt(id, p);
    return c.json(p);
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

- [ ] **Step 3: Wire in index.ts**

```ts
app.route("/", promptRoutes(rooms, bus));
```

- [ ] **Step 4: Run, commit**

```bash
cd apps/backend && bun test
git add apps/backend
git commit -m "feat(backend): prompts endpoints (create/list/resolve/dismiss) with WS broadcast"
```

---

## Task 28: Frontend — prompts UI

**Files:**
- Create: `apps/frontend/src/transport/prompts.ts`
- Create: `apps/frontend/src/prompts/PromptInput.tsx`
- Create: `apps/frontend/src/prompts/PromptDrawer.tsx`
- Modify: `apps/frontend/src/App.tsx`

- [ ] **Step 1: `transport/prompts.ts`**

```ts
import { room } from "./api";

export async function postPrompt(selection: string[], text: string) {
  const r = await fetch(`/api/prompt?room=${encodeURIComponent(room)}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ selection, text }),
  });
  return r.json();
}

export async function fetchPrompts(status = "all") {
  const r = await fetch(`/api/prompts?room=${encodeURIComponent(room)}&status=${status}`);
  return r.json();
}
```

- [ ] **Step 2: `PromptInput.tsx`**

```tsx
import { useState } from "react";
import { postPrompt } from "../transport/prompts";

export function PromptInput({ selection }: { selection: string[] }) {
  const [text, setText] = useState("");
  if (selection.length === 0) return null;
  const send = async () => { if (text.trim()) { await postPrompt(selection, text); setText(""); } };
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
        onKeyDown={(e) => { if (e.key === "Enter") void send(); }}
      />
      <button onClick={() => void send()}>Send</button>
    </div>
  );
}
```

- [ ] **Step 3: `PromptDrawer.tsx`**

```tsx
import { useEffect, useState } from "react";
import { fetchPrompts } from "../transport/prompts";

export function PromptDrawer({ tick }: { tick: number }) {
  const [items, setItems] = useState<any[]>([]);
  useEffect(() => { fetchPrompts("all").then((r) => setItems(r.prompts ?? [])); }, [tick]);
  return (
    <div style={{
      position: "fixed", top: 60, right: 8, width: 320, maxHeight: "70vh",
      overflow: "auto", background: "white", border: "1px solid #ccc", borderRadius: 6,
      padding: 8, fontSize: 12, zIndex: 999,
    }}>
      <div style={{ fontWeight: "bold", marginBottom: 8 }}>Prompts ({items.length})</div>
      {items.length === 0 && <div>(empty)</div>}
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

- [ ] **Step 4: Wire into `App.tsx`**

```tsx
import { PromptInput } from "./prompts/PromptInput";
import { PromptDrawer } from "./prompts/PromptDrawer";

// inside component:
const [selection, setSelection] = useState<string[]>([]);
const [promptsTick, setPromptsTick] = useState(0);

// in editor useEffect after WS setup:
const unsubSel = editor.store.listen(() => {
  const ids = editor.getSelectedShapeIds().map((id) => (id as unknown as string).replace(/^shape:/, ""));
  setSelection(ids);
}, { source: "user", scope: "session" });

// in openWs handlers:
onPromptCreated: () => setPromptsTick((x) => x + 1),
onPromptResolved: () => setPromptsTick((x) => x + 1),

// in cleanup: unsubSel()
// in JSX:
<PromptInput selection={selection} />
<PromptDrawer tick={promptsTick} />
```

- [ ] **Step 5: Smoke + commit**

```bash
git add apps/frontend
git commit -m "feat(frontend): targeted prompts UI (input on selection, drawer with history)"
```

---

## Task 29: didraw CLI — prompts list/resolve/dismiss

**Files:**
- Create: `packages/didraw-cli/src/prompts.ts`
- Modify: `packages/didraw-cli/src/index.ts`

- [ ] **Step 1: Implement**

```ts
import { CanvasClient } from "@didraw/client";

export async function cmdPrompts(argv: string[]) {
  const sub = argv[0];
  const rest = argv.slice(1);
  let room: string | undefined; let status: any; let response: string | undefined; let id: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--room") room = rest[++i];
    else if (rest[i] === "--status") status = rest[++i];
    else if (rest[i] === "--response") response = rest[++i];
    else if (!id && !rest[i].startsWith("--")) id = rest[i];
  }
  const c = new CanvasClient({ room });
  try {
    if (sub === "list") console.log(JSON.stringify(await c.getPrompts(status ?? "pending")));
    else if (sub === "resolve") { if (!id) throw new Error("missing id"); console.log(JSON.stringify(await c.resolvePrompt(id, response))); }
    else if (sub === "dismiss") { if (!id) throw new Error("missing id"); console.log(JSON.stringify(await c.dismissPrompt(id))); }
    else { console.error(JSON.stringify({ ok: false, error: `unknown prompts subcommand: ${sub}` })); process.exit(1); }
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: String(e) })); process.exit(1);
  }
}
```

- [ ] **Step 2: Wire and commit**

```ts
import { cmdPrompts } from "./prompts";
if (cmd === "prompts") return cmdPrompts(argv.slice(1));
```

```bash
git add packages/didraw-cli
git commit -m "feat(cli): didraw prompts list/resolve/dismiss"
```

---

## Task 30: Update skill — inject pending prompts

Already done in Task 19 (skill body includes `didraw prompts list`). Verify once more in a manual Claude Code session that AI sees prompts and calls resolve.

- [ ] **Step 1: Manual e2e**

1. Open canvas in browser, select a node, write "what is this?", Send.
2. In Claude Code session: `что я тебя только что спросил на канвасе?` (or just continue the dialog).
3. Expected: AI читает `didraw prompts list` (через cheat-sheet), отвечает в чате и вызывает `didraw prompts resolve <id> --response "..."`.

If skill body needs tweaks for clarity, update.

- [ ] **Step 2: Commit (if changes)**

```bash
git add .claude/skills/draw
git commit -m "fix(skill): clarify prompt-resolution workflow"
```

---

## Task 31: Runtime profiles — verification and isolation tests

**Most of the profile mechanics already implemented:**
- Task 2 Step 3 — profile-aware `getConfig()` + Proxy-config (lazy reads).
- Task 3 Step 3 — Vite proxy читает `DIDRAW_PORT` (default 8788 → dev backend).
- Task 1 Step 1 — root `dev` script запускает backend с `DIDRAW_PROFILE=dev`.
- Task 16 — `parseProfile`/`applyProfile`, profile-specific pid-files, self-spawn architecture.
- Task 17 — `lifecycle.ts` использует `getConfig().storageDir` (per-profile).

This task ensures end-to-end isolation works.

**Files:**
- Create: `packages/didraw-cli/tests/profile.test.ts`

- [ ] **Step 1: Integration test — parallel dev + release**

```ts
// packages/didraw-cli/tests/profile.test.ts
import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "index.ts");

describe("runtime profiles", () => {
  test("dev and release have different default ports", () => {
    // Не запускаем настоящие daemons (вместо этого проверяем portFor)
    const r = spawnSync("bun", ["-e", `
      import { portFor } from "${join(import.meta.dir, "..", "src", "profile")}";
      console.log(JSON.stringify({ dev: portFor("dev"), release: portFor("release") }));
    `], { encoding: "utf8" });
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.dev).toBe(8788);
    expect(j.release).toBe(8787);
  });

  test("pid files are profile-specific", () => {
    const r = spawnSync("bun", ["-e", `
      import { pidFile } from "${join(import.meta.dir, "..", "src", "profile")}";
      console.log(JSON.stringify({ dev: pidFile("dev"), release: pidFile("release") }));
    `], { encoding: "utf8" });
    const j = JSON.parse(r.stdout);
    expect(j.dev).not.toBe(j.release);
    expect(j.dev).toContain("didraw-dev");
    expect(j.release).toContain("didraw-release");
  });

  test("storage directory differs per profile", () => {
    const r1 = spawnSync("bun", ["-e", `
      process.env.DIDRAW_PROFILE = "dev";
      const { getConfig } = await import("${join(import.meta.dir, "..", "..", "..", "apps", "backend", "src", "config")}");
      console.log(getConfig().storageDir);
    `], { encoding: "utf8" });
    const r2 = spawnSync("bun", ["-e", `
      process.env.DIDRAW_PROFILE = "release";
      const { getConfig } = await import("${join(import.meta.dir, "..", "..", "..", "apps", "backend", "src", "config")}");
      console.log(getConfig().storageDir);
    `], { encoding: "utf8" });
    expect(r1.stdout.trim()).toContain("canvas-dev");
    expect(r2.stdout.trim()).toContain("canvas");
    expect(r1.stdout).not.toBe(r2.stdout);
  });
});
```

- [ ] **Step 2: Manual smoke — parallel daemons**

```bash
# Release on 8787
bun packages/didraw-cli/src/index.ts daemon ensure
# Dev on 8788 — должен подняться независимо
bun packages/didraw-cli/src/index.ts daemon ensure --profile dev

curl -s localhost:8787/api/version  # profile=release
curl -s localhost:8788/api/version  # profile=dev
ls ~/.claude/.didraw-*.pid          # два разных pid-файла

bun packages/didraw-cli/src/index.ts daemon stop
bun packages/didraw-cli/src/index.ts daemon stop --profile dev
```

- [ ] **Step 3: Commit**

```bash
git add packages/didraw-cli/tests/profile.test.ts
git commit -m "test: parallel dev+release daemons, profile-isolated pid/port/storage"
```

---

## Task 32: Version metadata + GET /api/version

**Files:**
- Create: `apps/backend/src/version.ts`
- Create: `apps/backend/src/routes/version.ts`
- Create: `apps/backend/src/update-check.ts`
- Modify: `apps/backend/src/index.ts`
- Create: `apps/backend/tests/version.test.ts`

- [ ] **Step 1: `version.ts` (read at build/runtime)**

```ts
// Filled by `bun build --compile --define DIDRAW_VERSION=... DIDRAW_GIT_SHA=... etc.`
// At dev time falls back to package.json + git.
import pkg from "../../../package.json" assert { type: "json" };

export const VERSION = {
  version: process.env.DIDRAW_VERSION ?? pkg.version ?? "0.0.0-dev",
  channel: (process.env.DIDRAW_CHANNEL ?? "dev") as "dev" | "stable" | "nightly",
  gitSha: process.env.DIDRAW_GIT_SHA ?? "unknown",
  buildDate: process.env.DIDRAW_BUILD_DATE ?? new Date().toISOString(),
} as const;
```

- [ ] **Step 2: `update-check.ts` (lazy manifest fetch)**

```ts
import { VERSION } from "./version";

export const MANIFEST_URL = process.env.DIDRAW_MANIFEST_URL
  ?? "https://github.com/example/di.draw/releases/download/latest/release-manifest.json";

type CacheEntry = { at: number; latest: string | null };
let cache: CacheEntry | null = null;
const TTL = 60 * 60 * 1000;

export async function checkLatest(): Promise<{ updateAvailable: boolean; latest: string | null }> {
  if (cache && Date.now() - cache.at < TTL) {
    return { latest: cache.latest, updateAvailable: !!cache.latest && cache.latest !== VERSION.version };
  }
  try {
    const r = await fetch(MANIFEST_URL);
    if (!r.ok) throw new Error(`manifest ${r.status}`);
    const m = await r.json() as { channels?: Record<string, { version?: string }> };
    const latest = m.channels?.[VERSION.channel]?.version ?? null;
    cache = { at: Date.now(), latest };
    return { latest, updateAvailable: !!latest && latest !== VERSION.version };
  } catch {
    cache = { at: Date.now(), latest: null };
    return { latest: null, updateAvailable: false };
  }
}
```

- [ ] **Step 3: `routes/version.ts`**

```ts
import { Hono } from "hono";
import { VERSION } from "../version";
import { checkLatest } from "../update-check";
import { config } from "../config";

export const versionRoutes = new Hono().get("/api/version", async (c) => {
  const upd = await checkLatest();
  return c.json({ ...VERSION, profile: config.profile, ...upd });
});
```

- [ ] **Step 4: Wire in `index.ts`**

```ts
import { versionRoutes } from "./routes/version";
// in makeApp:
app.route("/", versionRoutes);
```

- [ ] **Step 5: Failing test**

```ts
// apps/backend/tests/version.test.ts
import { describe, test, expect } from "bun:test";
import { startServer } from "../src/index";

describe("GET /api/version", () => {
  test("returns version fields", async () => {
    const srv = await startServer({ inMemory: true, port: 0 });
    const b = await fetch(`http://localhost:${srv.port}/api/version`).then((r) => r.json());
    expect(b).toHaveProperty("version");
    expect(b).toHaveProperty("channel");
    expect(b).toHaveProperty("profile");
    expect(b).toHaveProperty("updateAvailable");
    await srv.close();
  });
});
```

- [ ] **Step 6: Run — PASS, commit**

```bash
cd apps/backend && bun test tests/version.test.ts
git add apps/backend
git commit -m "feat(backend): /api/version with build metadata and lazy update-check"
```

---

## Task 33: didraw version CLI

**Files:**
- Create: `packages/didraw-cli/src/version-cmd.ts`
- Modify: `packages/didraw-cli/src/index.ts`

- [ ] **Step 1: Implement**

```ts
// packages/didraw-cli/src/version-cmd.ts
import { CanvasClient } from "@didraw/client";

export async function cmdVersion() {
  const c = new CanvasClient();
  try {
    const r = await fetch(`${(c as any).base}/api/version`);
    if (r.ok) { console.log(JSON.stringify(await r.json())); return; }
  } catch {}
  // Fallback: daemon not running — show what's in env
  console.log(JSON.stringify({
    version: process.env.DIDRAW_VERSION ?? "unknown",
    channel: process.env.DIDRAW_CHANNEL ?? "dev",
    gitSha: process.env.DIDRAW_GIT_SHA ?? "unknown",
    daemonRunning: false,
  }));
}
```

- [ ] **Step 2: Wire and commit**

```ts
import { cmdVersion } from "./version-cmd";
if (cmd === "version") return cmdVersion();
```

```bash
git add packages/didraw-cli
git commit -m "feat(cli): didraw version (reads /api/version, falls back to env)"
```

---

## Task 34: Release packaging — bun build --compile with embedded frontend

**Files:**
- Create: `scripts/build-release.sh`
- Modify: `apps/backend/src/index.ts` (serve embedded frontend in release mode)
- Modify: `.gitignore` (add `release/`)

- [ ] **Step 1: Static-asset serving in backend**

In `apps/backend/src/index.ts`, in `Bun.serve` fetch handler, before `app.fetch`:

```ts
// release-mode: serve embedded frontend from frontend-dist/
if (config.profile === "release" || config.profile === "debug") {
  if (url.pathname === "/" || !url.pathname.startsWith("/api") && url.pathname !== "/ws") {
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(`${import.meta.dir}/frontend-dist${path}`);
    if (await file.exists()) {
      return new Response(file);
    }
  }
}
```

> **Note:** `bun build --compile` embeds files referenced via `Bun.file(import.meta.dir + ...)` if they're under the entry's directory tree. The script (Step 2) copies frontend dist into `apps/backend/src/frontend-dist/` before compile.

- [ ] **Step 2: `scripts/build-release.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-$(jq -r .version package.json)}"
CHANNEL="${2:-stable}"
GIT_SHA="$(git rev-parse --short HEAD)"
BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "Building frontend…"
bun --cwd apps/frontend run build
rm -rf apps/backend/src/frontend-dist
cp -r apps/frontend/dist apps/backend/src/frontend-dist

mkdir -p release
TARGETS=(
  "bun-darwin-arm64:didraw-darwin-arm64"
  "bun-darwin-x64:didraw-darwin-x64"
  "bun-linux-x64:didraw-linux-x64"
)

for entry in "${TARGETS[@]}"; do
  IFS=':' read -r target out <<< "$entry"
  echo "Building $out…"
  bun build packages/didraw-cli/src/index.ts \
    --compile \
    --target="$target" \
    --outfile="release/$out" \
    --define "process.env.DIDRAW_VERSION='$VERSION'" \
    --define "process.env.DIDRAW_CHANNEL='$CHANNEL'" \
    --define "process.env.DIDRAW_GIT_SHA='$GIT_SHA'" \
    --define "process.env.DIDRAW_BUILD_DATE='$BUILD_DATE'"
done

echo "Release builds ready in release/"
ls -lh release/
```

- [ ] **Step 3: `.gitignore` add**

```
release/
apps/backend/src/frontend-dist/
```

- [ ] **Step 4: Smoke test**

```bash
chmod +x scripts/build-release.sh
./scripts/build-release.sh 0.0.1 stable
./release/didraw-darwin-arm64 version
./release/didraw-darwin-arm64 daemon &
curl -s localhost:8787/healthz
open http://localhost:8787/        # должен открыть встроенный UI
kill %1
```
Expected: binary стартует, /healthz отвечает, browser показывает tldraw без отдельного Vite.

- [ ] **Step 5: Commit**

```bash
git add scripts/ apps/backend/src/index.ts .gitignore
git commit -m "feat(release): bun build --compile with embedded frontend assets"
```

---

## Task 35: Release manifest generator + publish script

**Files:**
- Create: `scripts/generate-manifest.sh`
- Create: `scripts/publish-release.sh`

- [ ] **Step 1: `generate-manifest.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:?usage: $0 <version> [channel]}"
CHANNEL="${2:-stable}"
BASE_URL="${MANIFEST_BASE_URL:-https://github.com/example/di.draw/releases/download/v$VERSION}"

cd release

declare -A platforms=(
  [darwin-arm64]="didraw-darwin-arm64"
  [darwin-x64]="didraw-darwin-x64"
  [linux-x64]="didraw-linux-x64"
)

assets="["
first=1
for plat in "${!platforms[@]}"; do
  file="${platforms[$plat]}"
  [[ ! -f "$file" ]] && { echo "missing $file"; exit 1; }
  sha=$(shasum -a 256 "$file" | awk '{print $1}')
  [[ $first -eq 0 ]] && assets="$assets,"
  assets="$assets{\"platform\":\"$plat\",\"url\":\"$BASE_URL/$file\",\"sha256\":\"$sha\"}"
  first=0
done
assets="$assets]"

cat > release-manifest.json <<JSON
{
  "channels": {
    "$CHANNEL": {
      "version": "$VERSION",
      "released": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
      "notes": "$BASE_URL",
      "assets": $assets
    }
  }
}
JSON

echo "manifest written → release/release-manifest.json"
cat release-manifest.json
```

- [ ] **Step 2: `publish-release.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:?usage: $0 <version> [channel]}"
CHANNEL="${2:-stable}"

./scripts/build-release.sh "$VERSION" "$CHANNEL"
./scripts/generate-manifest.sh "$VERSION" "$CHANNEL"

if ! command -v gh &>/dev/null; then
  echo "gh CLI not found — skipping GitHub Release upload"
  echo "Manual upload: release/didraw-*  release/release-manifest.json"
  exit 0
fi

git tag "v$VERSION" -m "Release v$VERSION ($CHANNEL)"
git push --tags

gh release create "v$VERSION" \
  --title "v$VERSION" \
  --notes "Release v$VERSION on channel $CHANNEL" \
  release/didraw-* release/release-manifest.json

echo "Published v$VERSION"
```

- [ ] **Step 3: chmod**

```bash
chmod +x scripts/generate-manifest.sh scripts/publish-release.sh
```

- [ ] **Step 4: Dry-run smoke**

```bash
./scripts/build-release.sh 0.0.1 stable
./scripts/generate-manifest.sh 0.0.1 stable
jq . release/release-manifest.json
```

- [ ] **Step 5: Commit**

```bash
git add scripts/
git commit -m "feat(release): manifest generator and publish script"
```

---

## Task 36: didraw update --check

**Files:**
- Create: `packages/didraw-cli/src/update.ts`
- Modify: `packages/didraw-cli/src/index.ts`

- [ ] **Step 1: Implement `--check`**

```ts
// packages/didraw-cli/src/update.ts
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const MANIFEST_URL = process.env.DIDRAW_MANIFEST_URL
  ?? "https://github.com/example/di.draw/releases/download/latest/release-manifest.json";

const CONFIG_FILE = join(homedir(), ".claude", ".didraw-config.json");

function readConfig(): { channel?: string } {
  if (!existsSync(CONFIG_FILE)) return {};
  try { return JSON.parse(readFileSync(CONFIG_FILE, "utf8")); } catch { return {}; }
}

function writeConfig(cfg: object) {
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function semverCmp(a: string, b: string): number {
  const pa = a.split(".").map(Number); const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

export async function cmdUpdateCheck(argv: string[]) {
  const channel = readConfig().channel ?? process.env.DIDRAW_CHANNEL ?? "stable";
  const current = process.env.DIDRAW_VERSION ?? "0.0.0";
  try {
    const r = await fetch(MANIFEST_URL);
    const m = await r.json();
    const latest = m.channels?.[channel]?.version ?? null;
    const available = latest && semverCmp(latest, current) > 0;
    console.log(JSON.stringify({ current, latest, available: !!available, channel }));
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: String(e) }));
    process.exit(3);
  }
}

export async function cmdUpdate(argv: string[]) {
  // implemented in Task 37
  console.error(JSON.stringify({ ok: false, error: "didraw update implemented in Task 37" }));
  process.exit(1);
}

export async function cmdUpdateSetChannel(channel: string) {
  if (!["stable", "nightly", "dev"].includes(channel)) {
    console.error(JSON.stringify({ ok: false, error: `unknown channel ${channel}` })); process.exit(1);
  }
  const cfg = readConfig(); cfg.channel = channel; writeConfig(cfg);
  console.log(JSON.stringify({ ok: true, channel }));
}
```

- [ ] **Step 2: Wire in `index.ts`**

```ts
import { cmdUpdate, cmdUpdateCheck, cmdUpdateSetChannel } from "./update";

if (cmd === "update") {
  if (argv[1] === "--check") return cmdUpdateCheck(argv.slice(1));
  if (argv[1] === "--channel" && argv[2]) return cmdUpdateSetChannel(argv[2]);
  return cmdUpdate(argv.slice(1));
}
```

- [ ] **Step 3: Smoke**

```bash
bun packages/didraw-cli/src/index.ts update --check
```
Expected: JSON `{current,latest,available,channel}` (latest=null if manifest unreachable — that's OK for now).

- [ ] **Step 4: Commit**

```bash
git add packages/didraw-cli
git commit -m "feat(cli): didraw update --check and --channel"
```

---

## Task 37: didraw update (download + sha256 + atomic swap + restart)

**Files:**
- Modify: `packages/didraw-cli/src/update.ts`

- [ ] **Step 1: Implement full update flow**

Replace stub `cmdUpdate` with:

```ts
import { promises as fs, createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir, platform, arch } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { stop, ensure } from "./daemon";
import { parseProfile } from "./profile";

function platformKey(): string {
  const p = platform(); const a = arch();
  if (p === "darwin" && a === "arm64") return "darwin-arm64";
  if (p === "darwin" && a === "x64") return "darwin-x64";
  if (p === "linux" && a === "x64") return "linux-x64";
  throw new Error(`unsupported platform ${p}-${a}`);
}

async function downloadAndVerify(url: string, sha256Expected: string): Promise<string> {
  const tmp = join(tmpdir(), `didraw-${Date.now()}.bin`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${r.status}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  await fs.writeFile(tmp, buf);
  const sha = createHash("sha256").update(buf).digest("hex");
  if (sha !== sha256Expected) {
    await fs.unlink(tmp).catch(() => {});
    throw new Error(`sha256 mismatch: expected ${sha256Expected}, got ${sha}`);
  }
  await fs.chmod(tmp, 0o755);
  return tmp;
}

export async function cmdUpdate(argv: string[]) {
  const channel = readConfig().channel ?? process.env.DIDRAW_CHANNEL ?? "stable";
  const current = process.env.DIDRAW_VERSION ?? "0.0.0";
  let manifest: any;
  try { manifest = await (await fetch(MANIFEST_URL)).json(); }
  catch (e) { fail(`fetch manifest: ${e}`); return; }

  const chData = manifest.channels?.[channel];
  if (!chData) fail(`channel ${channel} not in manifest`);

  if (semverCmp(chData.version, current) <= 0) {
    console.log(JSON.stringify({ ok: true, alreadyLatest: true, version: current })); return;
  }

  const key = platformKey();
  const asset = chData.assets.find((a: any) => a.platform === key);
  if (!asset) fail(`no asset for ${key}`);

  // execPath = current binary path
  const target = process.execPath;
  const dir = dirname(target);

  let tmpfile: string;
  try { tmpfile = await downloadAndVerify(asset.url, asset.sha256); }
  catch (e) { fail(`download/verify: ${e}`); return; }

  const newPath = join(dir, "didraw.new");
  const oldPath = join(dir, "didraw.old");

  try {
    await fs.rename(tmpfile, newPath);
    try { await fs.rename(target, oldPath); } catch {}
    await fs.rename(newPath, target);
  } catch (e) {
    fail(`atomic swap failed: ${e}`);
    return;
  }

  // graceful stop → flushAll сработает в backend на SIGTERM
  const profile = parseProfile(argv);
  await stop(profile).catch(() => {});
  // ensure поднимет новый binary (текущий процесс — старый CLI, новый binary уже на target path)
  await ensure(profile);

  console.log(JSON.stringify({
    ok: true, from: current, to: chData.version, channel, profile,
    rollback: `rename ${oldPath} → ${target}`,
  }));
}

function fail(msg: string) {
  console.error(JSON.stringify({ ok: false, error: msg }));
  process.exit(1);
}
```

- [ ] **Step 2: Manual e2e test**

```bash
# 1. Build v0.0.1 stable
./scripts/build-release.sh 0.0.1 stable
./scripts/generate-manifest.sh 0.0.1 stable
# 2. Put release/* in a local HTTP server (python -m http.server) and set MANIFEST_URL
python3 -m http.server 9999 --directory release &
DIDRAW_MANIFEST_URL=http://localhost:9999/release-manifest.json ./release/didraw-darwin-arm64 version

# 3. Build v0.0.2 stable
./scripts/build-release.sh 0.0.2 stable
./scripts/generate-manifest.sh 0.0.2 stable
# 4. Run v0.0.1 binary
cp release/didraw-darwin-arm64-v001 /tmp/didraw   # if you renamed, otherwise reuse
DIDRAW_MANIFEST_URL=http://localhost:9999/release-manifest.json /tmp/didraw update --check
DIDRAW_MANIFEST_URL=http://localhost:9999/release-manifest.json /tmp/didraw update
/tmp/didraw version    # должна быть 0.0.2
kill %1
```

- [ ] **Step 3: Commit**

```bash
git add packages/didraw-cli/src/update.ts
git commit -m "feat(cli): didraw update — download + sha256 + atomic swap + daemon restart"
```

---

## Task 38: Frontend version footer + update banner

**Files:**
- Create: `apps/frontend/src/components/VersionFooter.tsx`
- Create: `apps/frontend/src/components/UpdateBanner.tsx`
- Create: `apps/frontend/src/transport/version.ts`
- Modify: `apps/frontend/src/App.tsx`

- [ ] **Step 1: `transport/version.ts`**

```ts
export async function fetchVersion() {
  const r = await fetch("/api/version");
  return r.json();
}
```

- [ ] **Step 2: `VersionFooter.tsx`**

```tsx
import { useEffect, useState } from "react";
import { fetchVersion } from "../transport/version";

export function VersionFooter() {
  const [v, setV] = useState<any>(null);
  useEffect(() => { fetchVersion().then(setV); }, []);
  if (!v) return null;
  const badge = v.profile === "dev" ? "DEV" : v.profile === "debug" ? "DEBUG" : null;
  return (
    <div style={{
      position: "fixed", bottom: 4, right: 8, zIndex: 999,
      fontSize: 11, color: "#666", fontFamily: "monospace",
    }}>
      v{v.version} · {v.channel} · profile: {v.profile}
      {badge && <span style={{
        marginLeft: 8, background: "#fc6", color: "#000",
        padding: "1px 6px", borderRadius: 3, fontWeight: "bold",
      }}>{badge}</span>}
    </div>
  );
}
```

- [ ] **Step 3: `UpdateBanner.tsx`**

```tsx
import { useEffect, useState } from "react";
import { fetchVersion } from "../transport/version";

export function UpdateBanner() {
  const [v, setV] = useState<any>(null);
  useEffect(() => { fetchVersion().then(setV); }, []);
  if (!v?.updateAvailable) return null;
  return (
    <div style={{
      position: "fixed", top: 0, left: 0, right: 0, zIndex: 1000,
      background: "#fef3c7", borderBottom: "1px solid #f59e0b",
      padding: "6px 12px", fontSize: 13, textAlign: "center",
    }}>
      <strong>v{v.latest}</strong> available — run <code style={{ background: "#fbbf24", padding: "1px 4px" }}>didraw update</code> to upgrade
    </div>
  );
}
```

- [ ] **Step 4: Wire into `App.tsx`**

```tsx
import { VersionFooter } from "./components/VersionFooter";
import { UpdateBanner } from "./components/UpdateBanner";

// in JSX:
<UpdateBanner />
<VersionFooter />
```

- [ ] **Step 5: Smoke test**

Stub `/api/version` to return `{updateAvailable: true, latest: "9.9.9"}` (modify backend temporarily or use proxy). Open browser → banner появляется. Reset stub → banner исчезает.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend
git commit -m "feat(frontend): version footer and update banner"
```

---

## Task 39: Playwright golden-path

**Files:**
- Create: `apps/frontend/playwright.config.ts`
- Create: `apps/frontend/tests/golden.spec.ts`
- Modify: `apps/frontend/package.json` (add playwright)

- [ ] **Step 1: Install + config**

```bash
cd apps/frontend
bun add -D @playwright/test
bunx playwright install chromium
```

```ts
// playwright.config.ts
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  use: { baseURL: "http://localhost:5173" },
});
```

- [ ] **Step 2: Test**

```ts
import { test, expect } from "@playwright/test";

test("AI patch → canvas; user move → backend", async ({ page }) => {
  await page.goto("/?room=golden");

  await fetch("http://localhost:8787/api/patch?room=golden", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ops: [{ op: "add", target: "node", value: { id: "n1", kind: "rect", x: 100, y: 100, label: "AI" } }],
      source: "ai",
    }),
  });
  await expect(page.locator("text=AI")).toBeVisible({ timeout: 3000 });

  await page.locator("text=AI").dragTo(page.locator("body"), { targetPosition: { x: 350, y: 250 } });
  await page.waitForTimeout(500);

  const state = await fetch("http://localhost:8787/api/state?room=golden").then((r) => r.json());
  const node = state.canvas.nodes.find((n: any) => n.id === "n1");
  expect(node.x).toBeGreaterThan(150);
});
```

- [ ] **Step 3: Run (need backend + frontend already running)**

```bash
cd apps/frontend && bunx playwright test
```

- [ ] **Step 4: Commit**

```bash
git add apps/frontend
git commit -m "test(frontend): Playwright golden-path AI→canvas→user→backend"
```

---

## Task 40: README + final polish

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write README**

```md
# di.draw

AI-driven canvas board for Claude Code sessions. tldraw 5.x frontend + Bun backend + `didraw` CLI + skill.

## Quick start (manual mode)

```bash
bun install
bun run --cwd packages/didraw-cli src/index.ts open scratch
```
Open `http://localhost:8787/?room=scratch` and draw.

## In a Claude Code session

`.claude/settings.json` SessionStart hook autostarts the backend. Then:
- `/draw нарисуй ...` — skill injects state + cheat-sheet, AI updates canvas via `didraw patch --stdin`.
- Browser auto-opens at `http://localhost:8787/?room=<CLAUDE_SESSION_ID>`.
- Select object(s) on canvas, type a prompt → it lands in dialog with object IDs attached.

## CLI

```
didraw daemon ensure | start | stop | status
didraw open <room>
didraw list | export <room> --to <path> | rm <room>
didraw state --compact [--since N]
echo '{"ops":[...]}' | didraw patch --stdin
didraw import mermaid --stdin
didraw layout --algorithm elk-layered
didraw prompts list|resolve|dismiss
didraw clear --confirm
```

## Architecture

See `docs/superpowers/specs/2026-05-14-di-draw-design.md`.

## Tests

```bash
bun run test   # backend + client + cli
cd apps/frontend && bunx playwright test
```
```

- [ ] **Step 2: Final full test run**

```bash
bun install
bun run test
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README with manual mode + Claude Code mode + CLI reference"
```

---

## Phase 2.1: MCP-adapter (thin wrapper over didraw-client)

### Task 41: canvas-mcp adapter

**Files:**
- Create: `packages/canvas-mcp/package.json`
- Create: `packages/canvas-mcp/src/index.ts`
- Create: `packages/canvas-mcp/src/tools.ts`

- [ ] **Step 1: Package**

```json
{
  "name": "@didraw/canvas-mcp",
  "private": true,
  "type": "module",
  "bin": { "canvas-mcp": "src/index.ts" },
  "dependencies": {
    "@didraw/client": "workspace:*",
    "@modelcontextprotocol/sdk": "^1.0.0"
  }
}
```

- [ ] **Step 2: Tools (thin proxy to client)**

```ts
// packages/canvas-mcp/src/tools.ts
import { CanvasClient } from "@didraw/client";

export function tools(client: CanvasClient) {
  return [
    {
      name: "canvas_get_state",
      description: "Get current canvas state (compact JSON by default).",
      inputSchema: { type: "object", properties: { fmt: { type: "string", enum: ["full", "compact"] }, since: { type: "number" } } },
      run: (a: any) => client.getState({ fmt: a.fmt ?? "compact", since: a.since }),
    },
    {
      name: "canvas_apply_patch",
      description: "Apply PatchOp[] {op:add|update|delete, target:node|edge|group, ...}.",
      inputSchema: { type: "object", properties: { ops: { type: "array" }, clientOpId: { type: "string" } }, required: ["ops"] },
      run: (a: any) => client.applyPatch(a.ops, { clientOpId: a.clientOpId }),
    },
    {
      name: "canvas_import_mermaid",
      description: "Convenience: import Mermaid as initial canvas content.",
      inputSchema: { type: "object", properties: { source: { type: "string" }, layout: { type: "string", enum: ["elk", "keep"] } }, required: ["source"] },
      run: (a: any) => client.importMermaid(a.source, a.layout ?? "elk"),
    },
    {
      name: "canvas_layout",
      description: "Re-layout nodes via elkjs.",
      inputSchema: { type: "object", properties: { algorithm: { type: "string", enum: ["elk-layered", "dagre"] }, nodeIds: { type: "array" } }, required: ["algorithm"] },
      run: (a: any) => client.layout(a.algorithm, a.nodeIds),
    },
    {
      name: "canvas_get_prompts",
      description: "List user prompts attached to canvas objects.",
      inputSchema: { type: "object", properties: { status: { type: "string", enum: ["pending", "resolved", "dismissed", "all"] } } },
      run: (a: any) => client.getPrompts(a.status ?? "pending"),
    },
    {
      name: "canvas_resolve_prompt",
      description: "Mark prompt as resolved with optional response.",
      inputSchema: { type: "object", properties: { id: { type: "string" }, response: { type: "string" } }, required: ["id"] },
      run: (a: any) => client.resolvePrompt(a.id, a.response),
    },
    {
      name: "canvas_dismiss_prompt",
      description: "Mark prompt as dismissed.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      run: (a: any) => client.dismissPrompt(a.id),
    },
  ] as const;
}
```

- [ ] **Step 3: Server**

```ts
#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CanvasClient } from "@didraw/client";
import { tools } from "./tools";

const client = new CanvasClient();
const registered = tools(client);

const server = new Server({ name: "canvas-mcp", version: "0.0.1" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: registered.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const t = registered.find((x) => x.name === req.params.name);
  if (!t) throw new Error(`unknown tool ${req.params.name}`);
  const result = await t.run(req.params.arguments as any);
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});

await server.connect(new StdioServerTransport());
```

- [ ] **Step 4: Register in `.claude/mcp.json`**

```json
{
  "mcpServers": {
    "canvas-mcp": { "command": "bun", "args": ["run", "packages/canvas-mcp/src/index.ts"] }
  }
}
```

- [ ] **Step 5: Verify**

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | bun packages/canvas-mcp/src/index.ts | jq '.result.tools | length'
```
Expected: 7.

- [ ] **Step 6: Commit**

```bash
git add packages/canvas-mcp .claude/mcp.json
git commit -m "feat: Phase 2.1 — canvas-mcp adapter (thin wrapper over didraw-client)"
```

---

## Phase 2.2: Channels-push canvas → Claude

### Task 42: canvas-channel-mcp

**Files:**
- Create: `packages/canvas-channel-mcp/package.json`
- Create: `packages/canvas-channel-mcp/src/index.ts`
- Modify: `.claude/settings.json` (add Channels invocation per docs)

- [ ] **Step 1: Package and skeleton**

```json
{
  "name": "@didraw/canvas-channel-mcp",
  "private": true,
  "type": "module",
  "bin": { "canvas-channel-mcp": "src/index.ts" },
  "dependencies": { "@modelcontextprotocol/sdk": "^1.0.0", "ws": "^8.0.0" }
}
```

```ts
#!/usr/bin/env bun
// Channels protocol — verify exact wire format with
// https://code.claude.com/docs/en/channels at implementation time.

import { WebSocket } from "ws";

const room = process.env.CLAUDE_SESSION_ID ?? "default";
const port = process.env.DIDRAW_PORT ?? "8787";
const ws = new WebSocket(`ws://localhost:${port}/ws?room=${encodeURIComponent(room)}`);

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.kind === "patch" && msg.source === "user") {
    const text = `User edited canvas: ${msg.ops.length} ops at v${msg.version}`;
    process.stdout.write(JSON.stringify({ event: "channel.message", text }) + "\n");
  }
  if (msg.kind === "prompt-created") {
    const text = `User prompted "${msg.prompt.text}" targeting ${msg.prompt.selection.join(",") || "(none)"}`;
    process.stdout.write(JSON.stringify({ event: "channel.message", text }) + "\n");
  }
});
```

- [ ] **Step 2: Register in settings.json per Claude Code Channels docs**

Verify exact integration mechanism at implementation time (`channels` field or CLI flag for Claude Code 2.1.80+).

- [ ] **Step 3: Smoke + commit**

```bash
git add packages/canvas-channel-mcp .claude/settings.json
git commit -m "feat: Phase 2.2 — canvas-channel-mcp pushes user edits to Claude Code"
```

---

## Phase 3: D2 import, SQLite, multi-user

### Task 43: D2 import

Mirror Task 22 (Variant A) but for D2:
- `apps/backend/src/d2-import.ts` with `@terrastruct/d2` WASM
- `apps/backend/src/routes/import-d2.ts`
- `packages/didraw-cli/src/import.ts` extended with `import d2` subcommand
- `packages/canvas-mcp/src/tools.ts` adds `canvas_import_d2`

### Task 44: SQLite persistence

`apps/backend/src/persistence-sqlite.ts` using `bun:sqlite`. Tables: `rooms(id PK, canvas, prompts, version)`, `op_log(room_id, version, ops, source, at)`. CLI flag `--storage=sqlite`. Migration script from JSON.

### Task 45: Multi-user merge

`POST /api/patch` accepts optional `since: number`. If `since !== current version` → 409 `{current}`. Frontend retry-with-rebase: fetch latest state, rebase user ops on top, retry once.

---

## Self-Review

**Spec coverage check (against `2026-05-14-di-draw-design.md` v3.6):**

| Spec §  | Requirement                                       | Plan task |
|---------|---------------------------------------------------|-----------|
| §2 #1   | JSON canvas-state SSOT                            | Task 5 |
| §2 #2   | tldraw SDK 5.x                                     | Task 3 |
| §2 #3   | Mermaid as import convenience (not SSOT)          | Tasks 22, 23 |
| §2 #4   | apply_patch (add/update/delete)                    | Tasks 6, 9 |
| §2 #5   | didraw CLI + skill + hook + Channels (Phase 2.2); MCP as Phase 2.1 adapter | Tasks 16-29 (MVP), 41-42 (Phase 2) |
| §2 #6   | Bun + Hono backend                                 | Task 2 |
| §2 #7   | React + tldraw 5.x frontend                        | Task 3 |
| §2 #8   | elkjs auto-layout                                  | Tasks 24, 25 |
| §2 #9   | Stable UUID                                        | Task 5 |
| §2 #10  | Port 8787 with DIDRAW_PORT override                | Tasks 2, 31 |
| §2 #11  | Multi-room + per-session storage                   | Tasks 7, 8, 17 |
| §2 #12  | Targeted prompts                                   | Tasks 27, 28, 29 |
| §2 #13  | Single-binary distribution                         | Tasks 34, 35 |
| §2 #14  | Runtime profiles (dev/release/debug)               | Task 31 |
| §3.1    | Data model (CanvasState, PatchOp, Prompt, Endpoint, Group, RoomState) | Task 5 |
| §3.2    | Backend rooms/REST/WS                              | Tasks 7-11, 27 |
| §3.2    | Frontend tldraw + transport + prompts UI           | Tasks 12-14, 28 |
| §3.2    | draw skill with didraw cheat-sheet                 | Task 19 |
| §3.2    | draw-prehook with additionalContext                | Task 26 |
| §3.5    | CLI lifecycle (daemon/open/list/export/rm)         | Tasks 16, 17 |
| §3.5    | CLI data (state/patch/import/layout/prompts/clear) | Tasks 18, 23, 25, 29 |
| §3.5    | CLI version/update                                  | Tasks 33, 36, 37 |
| §3.5    | SessionStart hook                                  | Task 20 |
| §3.5    | Storage layout `~/.claude/projects/<slug>/canvas/<room>.json` | Tasks 2, 8, 31 |
| §3.6    | Targeted prompts (backend + UI + CLI)              | Tasks 27, 28, 29 |
| §3.7.1  | Runtime profiles                                    | Task 31 |
| §3.7.2  | `bun build --compile` with embedded frontend       | Task 34 |
| §3.7.3  | Version metadata + `/api/version`                  | Task 32 |
| §3.7.4  | Release manifest                                    | Task 35 |
| §3.7.5  | Update flow (check + atomic swap + restart)        | Tasks 36, 37 |
| §3.7.6  | UI banner + version footer                          | Task 38 |
| §6 Phase 0.1 | Spike @tldraw/mermaid headless                | Task 4 |
| §6 Phase 1.9 | Release packaging                              | Tasks 31-34 |
| §6 Phase 1.10 | Update flow                                   | Tasks 35-38 |
| §6 Phase 2.1 | MCP adapter                                    | Task 41 |
| §6 Phase 2.2 | Channels-push                                  | Task 42 |
| §6 Phase 3   | D2 + SQLite + multi-user                       | Tasks 43-45 |
| §7      | Echo-loop protection                               | Task 13 |
| §7      | Race condition on session start                    | Task 16 (`ensure` blocks until healthz) |
| §7      | CLI as stable contract                              | Task 18 (integration tests) |
| §7      | Update interruption                                  | Task 37 (atomic swap + rollback) |
| §3.1    | Cascade-delete (node → edges, group.children)        | Task 6 (4 dedicated tests + impl) |
| §3.4    | Graceful shutdown (SIGTERM → flushAll)               | Tasks 8 (flushAll), 10 (signal handlers) |
| §3.4    | Daemon stop ≤ 2с graceful, fallback SIGKILL          | Task 16 (gracefulShutdownMs loop) |
| §3.7.1  | Profile-specific pid + parallel dev/release          | Tasks 16, 31 |
| §3.7.5  | Manual update + controlled daemon restart (stop→swap→start) | Task 37 |

All spec sections mapped.

**Placeholder scan:** No "TBD"/"TODO" remaining. Spike output and ADR-0001 are filled by the engineer during Task 4 (Step 5) — that's a documented action, not a placeholder.

**Type consistency:** `CanvasState`, `Node`, `Edge`, `Endpoint`, `Group`, `PatchOp`, `Prompt`, `RoomState` consistent across tasks 5-29. `CanvasClient` interface stable across tasks 15-41. `applyPatch` signature stable. `VERSION` shape and `/api/version` payload identical across tasks 32, 33, 38.

**Engineer notes** (verification points, not gaps):
- Task 3: confirm npm tldraw major maps to SDK 5.x at install time.
- Task 12: confirm exact tldraw 5.x shape `type`/`props` names against `.d.ts`.
- Task 22: code split per ADR-0001 (Task 4 result).
- Task 34: verify `bun build --compile --define` macro expansion works for runtime env-reads (alternative: write `version.ts` at build time instead of `--define`).
- Task 42: verify Channels wire format at implementation time.

Plan is complete, self-consistent, CLI-first, and distribution-ready.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-14-di-draw-implementation.md` (v2, CLI-first). Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, я ревьюю между задачами, быстрая итерация.

**2. Inline Execution** — выполняем задачи в этой же сессии через `executing-plans` с чекпойнтами.

Which approach?
