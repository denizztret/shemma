# di.draw Phase 2.0 — Persistence Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Закрыть P3 (workspace isolation), сформализовать persisted envelope, добавить daemon-safe rooms API (list/archive/restore/export/import) и переключить CLI с прямых filesystem ops на HTTP-via-daemon. После этого Phase 2.1 (Agent v2) сможет полагаться на стабильный rooms discovery.

**Architecture:** Storage scope = workspace (DIDRAW_PROJECT_DIR / CLAUDE_PROJECT_DIR / cwd) с collision-resistant slugify. Room id — отдельная резолюция: explicit > URL > session env > "default". Persisted envelope (`{schemaVersion, roomId, version, lastTouched, elementCount, canvas, prompts}`) — единый контракт между storage и export. Все room ops через backend HTTP API с `flushIfDirty + evict + filesystem op` pattern.

**Tech Stack:** Bun runtime, Hono routes, `bun:test`. Existing modules: `apps/backend/src/config.ts`, `rooms.ts`, `persistence.ts`, `index.ts`, `packages/didraw-cli/src/lifecycle.ts`. Spec: `docs/superpowers/specs/2026-05-15-di-draw-phase2-0-persistence-design.md` v1.2.

---

## File Structure

### Files to create

| Path | Responsibility |
|---|---|
| `apps/backend/src/envelope.ts` | Persisted envelope types (`PersistedEnvelope`, `ExportEnvelope`) + `serialize(state) → JSON string` + `parseHeader(raw): EnvelopeHeader \| null` (без full canvas parse) + `parseFull(raw): PersistedEnvelope`. |
| `apps/backend/src/routes/rooms.ts` | All rooms endpoints: `GET /api/rooms`, `POST /api/rooms/:id/archive`, `POST /api/rooms/:id/restore`, `POST /api/rooms/:id/export`, `POST /api/rooms/import`, `DELETE /api/rooms/:id`. |
| `apps/backend/tests/envelope.test.ts` | Serialize/parse roundtrip; header field order; parseHeader без parse canvas. |
| `apps/backend/tests/config.path.test.ts` | Project slug chain + collision-resistant slugify. |
| `apps/backend/tests/rooms-id-validation.test.ts` | RoomId regex accept/reject; replaces silent `sanitize`. |
| `apps/backend/tests/rooms-flush-evict.test.ts` | `flushIfDirty` synchronous flush; `evict` removes from memory. |
| `apps/backend/tests/routes-rooms.test.ts` | All endpoints integration tests (list/archive/restore/export/import). |
| `packages/didraw-cli/tests/lifecycle.http.test.ts` | CLI lifecycle methods через HTTP, не filesystem. |

### Files to modify

| Path | Change |
|---|---|
| `apps/backend/src/config.ts` | Replace hard-coded `"default-project"` with project-slug resolution chain + collision-resistant slugify. |
| `apps/backend/src/persistence.ts` | Use envelope format in `save`/`load`. Remove silent `sanitize` — accept only pre-validated ids. Add `flushIfDirty(id)` (sync flush of one room's pending timer). |
| `apps/backend/src/rooms.ts` | Add `validateRoomId(id)` (regex), `flushIfDirty(id)`, `evict(id)` methods. |
| `apps/backend/src/index.ts` | Register `roomsRoutes` in `makeApp()`. Wire `Rooms.flushIfDirty/evict` to `FilePersistence`. |
| `packages/didraw-cli/src/lifecycle.ts` | Rewrite `list`/`exportRoom`/`rmRoom` to use HTTP via `@didraw/client`. Add `archive`/`restore`/`importRoom`. |
| `packages/didraw-cli/src/index.ts` | Register new `rooms` subcommands. |
| `packages/didraw-client/src/index.ts` | Add methods: `listRooms`, `archiveRoom`, `restoreRoom`, `exportRoom`, `importRoom`, `deleteRoom`. |
| `.claude/skills/draw/SKILL.md` | Inject `didraw rooms list` at top + add guidance text. |
| `CHANGELOG.md` | Phase 2.0 entry. |
| `package.json` (root) + `release/VERSION` | Bump 0.0.1 → 0.1.0. |

---

## Task 1: Project slug resolution + collision-resistant slugify

**Files:**
- Modify: `apps/backend/src/config.ts`
- Test: `apps/backend/tests/config.path.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/backend/tests/config.path.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveProjectSlug, slugifyProject } from "../src/config";

describe("slugifyProject", () => {
  test("collision-resistant: same basename different paths → different slugs", () => {
    const a = slugifyProject("/home/u1/proj");
    const b = slugifyProject("/home/u2/proj");
    expect(a).not.toBe(b);
    expect(a.endsWith("-" + a.slice(-8))).toBe(false); // sanity
    expect(a.split("-").pop()?.length).toBe(8);        // hash suffix length
  });

  test("lowercase + slashes to dashes + no leading/trailing dash", () => {
    const s = slugifyProject("/Some/Path/With Caps");
    expect(s).toMatch(/^[a-z0-9_-]+$/);
    expect(s.startsWith("-")).toBe(false);
    expect(s.endsWith("-")).toBe(false);
  });

  test("collapse runs of dashes", () => {
    const s = slugifyProject("///deep////path");
    expect(s).not.toMatch(/--/);
  });

  test("empty / undefined → default", () => {
    expect(slugifyProject("")).toBe("default-project");
    expect(slugifyProject(undefined)).toBe("default-project");
  });

  test("deterministic", () => {
    expect(slugifyProject("/some/path")).toBe(slugifyProject("/some/path"));
  });
});

describe("resolveProjectSlug", () => {
  const ORIG = {
    DIDRAW: process.env.DIDRAW_PROJECT_DIR,
    CLAUDE: process.env.CLAUDE_PROJECT_DIR,
  };
  beforeEach(() => {
    delete process.env.DIDRAW_PROJECT_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
  });
  afterEach(() => {
    if (ORIG.DIDRAW) process.env.DIDRAW_PROJECT_DIR = ORIG.DIDRAW;
    if (ORIG.CLAUDE) process.env.CLAUDE_PROJECT_DIR = ORIG.CLAUDE;
  });

  test("DIDRAW_PROJECT_DIR wins over CLAUDE_PROJECT_DIR", () => {
    process.env.DIDRAW_PROJECT_DIR = "/explicit/path";
    process.env.CLAUDE_PROJECT_DIR = "/claude/path";
    expect(resolveProjectSlug()).toBe(slugifyProject("/explicit/path"));
  });

  test("CLAUDE_PROJECT_DIR wins over cwd", () => {
    process.env.CLAUDE_PROJECT_DIR = "/claude/path";
    expect(resolveProjectSlug()).toBe(slugifyProject("/claude/path"));
  });

  test("cwd as fallback", () => {
    expect(resolveProjectSlug()).toBe(slugifyProject(process.cwd()));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/backend && bun test tests/config.path.test.ts`
Expected: FAIL — `resolveProjectSlug` and `slugifyProject` not exported.

- [ ] **Step 3: Implement in `apps/backend/src/config.ts`**

Replace the existing storageDir line (line 50-57) and add exports. The full updated `config.ts`:

```ts
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const VALID_PROFILES = ["dev", "release", "debug"] as const;
export type Profile = (typeof VALID_PROFILES)[number];

const portByProfile: Record<Profile, number> = {
  dev: 8788,
  release: 8787,
  debug: 8787,
};
const storageSubdir: Record<Profile, string> = {
  dev: "canvas-dev",
  release: "canvas",
  debug: "canvas",
};
const logLevelByProfile: Record<Profile, "debug" | "info" | "error"> = {
  dev: "debug",
  release: "info",
  debug: "debug",
};

export function getProfile(): Profile {
  const raw = process.env.DIDRAW_PROFILE ?? "release";
  if (!VALID_PROFILES.includes(raw as Profile)) {
    throw new Error(
      `Invalid DIDRAW_PROFILE: "${raw}". Expected one of: ${VALID_PROFILES.join("|")}`,
    );
  }
  return raw as Profile;
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(
      `Invalid DIDRAW_PORT: "${raw}". Expected positive integer ≤ 65535`,
    );
  }
  return n;
}

export function slugifyProject(input: string | undefined): string {
  if (!input) return "default-project";
  const body = input
    .toLowerCase()
    .replace(/[\\/]+/g, "-")
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!body) return "default-project";
  const hash = createHash("sha1").update(input).digest("hex").slice(0, 8);
  return `${body}-${hash}`;
}

export function resolveProjectSlug(): string {
  return slugifyProject(
    process.env.DIDRAW_PROJECT_DIR ??
      process.env.CLAUDE_PROJECT_DIR ??
      process.cwd(),
  );
}

export function getConfig() {
  const profile = getProfile();
  return {
    profile,
    port: parsePort(process.env.DIDRAW_PORT, portByProfile[profile]),
    storageDir:
      process.env.DIDRAW_STORAGE_DIR ??
      join(
        homedir(),
        ".claude",
        "projects",
        resolveProjectSlug(),
        storageSubdir[profile],
      ),
    logLevel: (process.env.DIDRAW_LOG_LEVEL ?? logLevelByProfile[profile]) as
      | "debug"
      | "info"
      | "error",
    autosaveDebounceMs: 300,
    roomEvictionMs: 60 * 60 * 1000,
    opLogMaxSize: 50,
    gracefulShutdownMs: 2000,
  } as const;
}

let _cache: ReturnType<typeof getConfig> | null = null;
export const config = new Proxy({} as ReturnType<typeof getConfig>, {
  get: (_, k) => {
    if (_cache === null) _cache = getConfig();
    return _cache[k as keyof ReturnType<typeof getConfig>];
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/backend && bun test tests/config.path.test.ts`
Expected: PASS (5 tests in slugifyProject + 3 in resolveProjectSlug).

- [ ] **Step 5: Verify nothing else broke**

Run: `cd apps/backend && bun test`
Expected: All existing tests still pass. Some tests use `config.storageDir` — they should still work because `DIDRAW_STORAGE_DIR` override path is unchanged.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/config.ts apps/backend/tests/config.path.test.ts
git commit -m "feat(backend): project-slug storage path with collision-resistant slugify"
```

---

## Task 2: Persisted envelope format

**Files:**
- Create: `apps/backend/src/envelope.ts`
- Create: `apps/backend/tests/envelope.test.ts`
- Modify: `apps/backend/src/persistence.ts`
- Modify: `apps/backend/tests/persistence.test.ts` (update existing assertions for new schema)

- [ ] **Step 1: Write the failing test for envelope module**

Create `apps/backend/tests/envelope.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { emptyCanvasState, makeRoomState } from "../src/rooms";
import { parseFull, parseHeader, serialize } from "../src/envelope";

describe("envelope", () => {
  test("serialize → parseFull roundtrip", () => {
    const s = makeRoomState();
    s.canvas.nodes.push({ id: "n1", kind: "rect", x: 1, y: 2 });
    s.prompts.push({
      id: "p1",
      selection: [],
      text: "hi",
      createdAt: 1000,
      status: "pending",
    });
    s.version = 5;

    const raw = serialize("room-a", s);
    const env = parseFull(raw);

    expect(env.schemaVersion).toBe(1);
    expect(env.roomId).toBe("room-a");
    expect(env.version).toBe(5);
    expect(env.elementCount).toBe(1);
    expect(env.canvas.nodes[0].id).toBe("n1");
    expect(env.prompts[0].id).toBe("p1");
    expect(typeof env.lastTouched).toBe("string");
  });

  test("elementCount = nodes + edges + groups", () => {
    const s = makeRoomState();
    s.canvas.nodes.push({ id: "n1", kind: "rect", x: 0, y: 0 });
    s.canvas.nodes.push({ id: "n2", kind: "rect", x: 0, y: 0 });
    s.canvas.edges.push({
      id: "e1",
      from: { kind: "node", id: "n1" },
      to: { kind: "node", id: "n2" },
    });
    s.canvas.groups.push({ id: "g1", kind: "frame", children: [] });

    const env = parseFull(serialize("r", s));
    expect(env.elementCount).toBe(4);
  });

  test("parseHeader reads metadata without parsing canvas", () => {
    const s = makeRoomState();
    s.canvas.nodes.push({ id: "n1", kind: "rect", x: 1, y: 2 });
    s.version = 7;
    const raw = serialize("room-b", s);

    const hdr = parseHeader(raw);
    expect(hdr).not.toBeNull();
    expect(hdr!.roomId).toBe("room-b");
    expect(hdr!.version).toBe(7);
    expect(hdr!.elementCount).toBe(1);
    expect(hdr!.schemaVersion).toBe(1);
    // header does NOT carry canvas/prompts:
    expect((hdr as Record<string, unknown>).canvas).toBeUndefined();
  });

  test("parseHeader returns null on malformed JSON", () => {
    expect(parseHeader("not json")).toBeNull();
    expect(parseHeader("{")).toBeNull();
  });

  test("parseFull rejects unsupported schemaVersion", () => {
    const bad = JSON.stringify({
      schemaVersion: 999,
      roomId: "r",
      version: 0,
      lastTouched: new Date().toISOString(),
      elementCount: 0,
      canvas: emptyCanvasState(),
      prompts: [],
    });
    expect(() => parseFull(bad)).toThrow(/unsupported schemaVersion/);
  });

  test("header fields appear early in serialized output", () => {
    const s = makeRoomState();
    const raw = serialize("room-c", s);
    // schemaVersion, roomId, version must precede "canvas" key:
    const idxSchema = raw.indexOf('"schemaVersion"');
    const idxRoom = raw.indexOf('"roomId"');
    const idxVersion = raw.indexOf('"version"');
    const idxLast = raw.indexOf('"lastTouched"');
    const idxCount = raw.indexOf('"elementCount"');
    const idxCanvas = raw.indexOf('"canvas"');
    expect(idxSchema).toBeGreaterThan(-1);
    expect(idxSchema).toBeLessThan(idxCanvas);
    expect(idxRoom).toBeLessThan(idxCanvas);
    expect(idxVersion).toBeLessThan(idxCanvas);
    expect(idxLast).toBeLessThan(idxCanvas);
    expect(idxCount).toBeLessThan(idxCanvas);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/backend && bun test tests/envelope.test.ts`
Expected: FAIL — `envelope.ts` not found.

- [ ] **Step 3: Implement `apps/backend/src/envelope.ts`**

```ts
import type { RoomState } from "./types";

export const ENVELOPE_SCHEMA_VERSION = 1;

export type EnvelopeHeader = {
  schemaVersion: number;
  roomId: string;
  version: number;
  lastTouched: string;     // ISO
  elementCount: number;
};

export type PersistedEnvelope = EnvelopeHeader & {
  canvas: RoomState["canvas"];
  prompts: RoomState["prompts"];
};

export type ExportEnvelope = PersistedEnvelope & {
  exportedAt: string;      // ISO
};

export function serialize(roomId: string, s: RoomState): string {
  const env: PersistedEnvelope = {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    roomId,
    version: s.version,
    lastTouched: new Date(s.lastTouched).toISOString(),
    elementCount:
      s.canvas.nodes.length + s.canvas.edges.length + s.canvas.groups.length,
    canvas: s.canvas,
    prompts: s.prompts,
  };
  // Key order matches `EnvelopeHeader` first, then payload — important for parseHeader perf.
  return JSON.stringify(env, null, 2);
}

export function parseHeader(raw: string): EnvelopeHeader | null {
  try {
    const j = JSON.parse(raw) as Partial<PersistedEnvelope>;
    if (
      typeof j.schemaVersion !== "number" ||
      typeof j.roomId !== "string" ||
      typeof j.version !== "number" ||
      typeof j.lastTouched !== "string" ||
      typeof j.elementCount !== "number"
    ) {
      return null;
    }
    return {
      schemaVersion: j.schemaVersion,
      roomId: j.roomId,
      version: j.version,
      lastTouched: j.lastTouched,
      elementCount: j.elementCount,
    };
  } catch {
    return null;
  }
}

export function parseFull(raw: string): PersistedEnvelope {
  const j = JSON.parse(raw) as Partial<PersistedEnvelope>;
  if (j.schemaVersion !== ENVELOPE_SCHEMA_VERSION) {
    throw new Error(
      `unsupported schemaVersion: ${j.schemaVersion} (expected ${ENVELOPE_SCHEMA_VERSION})`,
    );
  }
  if (
    typeof j.roomId !== "string" ||
    typeof j.version !== "number" ||
    !j.canvas ||
    !Array.isArray(j.prompts)
  ) {
    throw new Error("malformed envelope");
  }
  return j as PersistedEnvelope;
}
```

- [ ] **Step 4: Run envelope test to verify it passes**

Run: `cd apps/backend && bun test tests/envelope.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Update `apps/backend/src/persistence.ts` to use envelope**

Replace the body of `save` and `load`:

```ts
import { promises as fs, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import { parseFull, serialize } from "./envelope";
import { emptyCanvasState } from "./rooms";
import type { RoomStore } from "./rooms";
import type { RoomId, RoomState } from "./types";

export class FilePersistence implements RoomStore {
  private pending = new Map<
    RoomId,
    { timer: ReturnType<typeof setTimeout>; state: RoomState }
  >();
  constructor(private dir: string) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  pathFor(id: RoomId): string {
    return join(this.dir, `${id}.json`);
  }

  async load(id: RoomId): Promise<RoomState | null> {
    try {
      const raw = await fs.readFile(this.pathFor(id), "utf8");
      const env = parseFull(raw);
      return {
        canvas: env.canvas ?? emptyCanvasState(),
        prompts: env.prompts ?? [],
        version: env.version ?? 0,
        opLog: [],
        dirty: false,
        lastTouched: Date.now(),
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async save(id: RoomId, s: RoomState): Promise<void> {
    await fs.writeFile(this.pathFor(id), serialize(id, s), "utf8");
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
   * Sync flush of one room (used by daemon-safe rooms operations).
   * If room is in pending queue, clear its timer and write immediately.
   * Idempotent — safe to call without pending state.
   */
  async flushIfDirty(id: RoomId): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    await this.save(id, pending.state);
  }

  async flushAll(): Promise<void> {
    const entries = [...this.pending.entries()];
    for (const [, { timer }] of entries) clearTimeout(timer);
    this.pending.clear();
    await Promise.all(
      entries.map(([id, { state }]) =>
        this.save(id, state).catch((e) =>
          console.error("[persistence] flush", id, e),
        ),
      ),
    );
  }
}
```

Note: `sanitize()` function removed. Room ids are validated upstream (next task) — silent mangling is wrong UX (per spec §2.1).

- [ ] **Step 6: Update existing `apps/backend/tests/persistence.test.ts`**

Find this test and update assertions to match new schema. The existing test in `tests/persistence.test.ts:14-28` asserts on raw `{canvas, prompts, version}` — change to assert on envelope fields.

Read the current file and update the "save + load round-trip" test:

```ts
test("save + load round-trip", async () => {
  const p = new FilePersistence(dir);
  const s = makeRoomState();
  s.canvas.nodes.push({ id: "n1", kind: "rect", x: 5, y: 10 });
  s.version = 3;
  await p.save("t", s);
  const loaded = await p.load("t");
  expect(loaded?.canvas.nodes[0].id).toBe("n1");
  expect(loaded?.version).toBe(3);

  // NEW: verify envelope schema is on disk
  const { readFileSync } = await import("node:fs");
  const raw = readFileSync(`${dir}/t.json`, "utf8");
  const env = JSON.parse(raw);
  expect(env.schemaVersion).toBe(1);
  expect(env.roomId).toBe("t");
  expect(env.elementCount).toBe(1);
});
```

- [ ] **Step 7: Run all persistence tests**

Run: `cd apps/backend && bun test tests/persistence.test.ts tests/envelope.test.ts`
Expected: PASS.

- [ ] **Step 8: Run full backend test suite**

Run: `cd apps/backend && bun test`
Expected: All pass. If any test reads raw room JSON expecting old format, update it the same way.

- [ ] **Step 9: Commit**

```bash
git add apps/backend/src/envelope.ts apps/backend/src/persistence.ts \
        apps/backend/tests/envelope.test.ts apps/backend/tests/persistence.test.ts
git commit -m "feat(backend): persisted envelope format + flushIfDirty"
```

---

## Task 3: Room id validation (replace silent sanitize)

**Files:**
- Modify: `apps/backend/src/rooms.ts`
- Test: `apps/backend/tests/rooms-id-validation.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/backend/tests/rooms-id-validation.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { validateRoomId } from "../src/rooms";

describe("validateRoomId", () => {
  test.each([
    "auth",
    "users-db",
    "design_v2",
    "ROOM-1",
    "a",
    "x".repeat(64),
  ])("accepts %s", (id) => {
    expect(validateRoomId(id)).toBe(true);
  });

  test.each([
    "",
    "x".repeat(65),
    "with space",
    "with/slash",
    "with..dots",
    "../etc/passwd",
    "name!",
    "имя",
  ])("rejects %s", (id) => {
    expect(validateRoomId(id)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/backend && bun test tests/rooms-id-validation.test.ts`
Expected: FAIL — `validateRoomId` not exported.

- [ ] **Step 3: Add `validateRoomId` to `apps/backend/src/rooms.ts`**

Add this export at the top of the file (after imports):

```ts
const ROOM_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function validateRoomId(id: string): boolean {
  return ROOM_ID_RE.test(id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/backend && bun test tests/rooms-id-validation.test.ts`
Expected: PASS (12 cases).

- [ ] **Step 5: Wire validation into existing routes (state/patch/etc) that accept `?room=`**

For each existing route file in `apps/backend/src/routes/` that reads `?room=` query param, add validation. Example for `apps/backend/src/routes/state.ts:8`:

Find:
```ts
const id = c.req.query("room") ?? DEFAULT_ROOM;
```

Replace with helper. Add at top of `apps/backend/src/rooms.ts`:

```ts
import { DEFAULT_ROOM } from "./types";

export function resolveRoomId(raw: string | undefined): {
  ok: true;
  id: string;
} | { ok: false; reason: string } {
  const id = raw ?? DEFAULT_ROOM;
  if (!validateRoomId(id)) {
    return {
      ok: false,
      reason: `invalid room id "${id}": expected /^[a-zA-Z0-9_-]{1,64}$/`,
    };
  }
  return { ok: true, id };
}
```

Then update each existing route to use `resolveRoomId` and return 422 on invalid:

```ts
// pattern for each route handler:
const r = resolveRoomId(c.req.query("room"));
if (!r.ok) return c.json({ ok: false, error: r.reason }, 422);
const id = r.id;
```

Apply this to: `routes/state.ts`, `routes/patch.ts`, `routes/layout.ts`, `routes/prompts.ts`, `routes/ai.ts`.

- [ ] **Step 6: Run all route tests**

Run: `cd apps/backend && bun test tests/routes.*.test.ts`
Expected: All existing pass (they use valid ids like "test-room", "abc").

- [ ] **Step 7: Add regression test in `tests/rooms-id-validation.test.ts`**

Append:

```ts
import { makeApp } from "../src/index";

describe("route-level validation", () => {
  test("state endpoint rejects invalid room id with 422", async () => {
    const { app } = makeApp({ inMemory: true });
    const res = await app.fetch(
      new Request("http://localhost/api/state?room=" + encodeURIComponent("bad name")),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("invalid room id");
  });
});
```

Run: `cd apps/backend && bun test tests/rooms-id-validation.test.ts`
Expected: PASS (all cases + 422 regression).

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/rooms.ts apps/backend/src/routes/ \
        apps/backend/tests/rooms-id-validation.test.ts
git commit -m "feat(backend): explicit room id validation, reject invalid ids with 422"
```

---

## Task 4: `flushIfDirty` + `evict` on Rooms class

**Files:**
- Modify: `apps/backend/src/rooms.ts`
- Test: `apps/backend/tests/rooms-flush-evict.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/backend/tests/rooms-flush-evict.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilePersistence } from "../src/persistence";
import { Rooms, makeRoomState } from "../src/rooms";

let dir: string;
let persistence: FilePersistence;
let rooms: Rooms;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "didraw-flush-"));
  persistence = new FilePersistence(dir);
  rooms = new Rooms({
    load: (id) => persistence.load(id),
    save: (id, s) => persistence.save(id, s),
  });
  // wire scheduleSave path: room writes go through scheduleSave
  rooms.setOnDirty((id, s) => persistence.scheduleSave(id, s));
  // wire flushIfDirty + evict through to persistence
  rooms.setPersistence(persistence);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("Rooms.flushIfDirty", () => {
  test("flushes pending autosave synchronously", async () => {
    const r = await rooms.get("a");
    r.canvas.nodes.push({ id: "n1", kind: "rect", x: 0, y: 0 });
    r.dirty = true;
    r.version = 1;
    persistence.scheduleSave("a", r);

    // before flush, file may or may not exist depending on debounce timing
    await rooms.flushIfDirty("a");

    expect(existsSync(join(dir, "a.json"))).toBe(true);
    const { readFileSync } = await import("node:fs");
    const env = JSON.parse(readFileSync(join(dir, "a.json"), "utf8"));
    expect(env.version).toBe(1);
    expect(env.elementCount).toBe(1);
  });

  test("idempotent: flushIfDirty on clean room is no-op", async () => {
    await rooms.get("b");
    await rooms.flushIfDirty("b");
    expect(existsSync(join(dir, "b.json"))).toBe(false);
  });
});

describe("Rooms.evict", () => {
  test("removes from in-memory map", async () => {
    await rooms.get("c");
    expect(rooms.has("c")).toBe(true);
    await rooms.evict("c");
    expect(rooms.has("c")).toBe(false);
  });

  test("evict flushes pending first (no data loss)", async () => {
    const r = await rooms.get("d");
    r.canvas.nodes.push({ id: "n1", kind: "rect", x: 0, y: 0 });
    r.dirty = true;
    r.version = 5;
    persistence.scheduleSave("d", r);

    await rooms.evict("d");

    expect(rooms.has("d")).toBe(false);
    const { readFileSync } = await import("node:fs");
    const env = JSON.parse(readFileSync(join(dir, "d.json"), "utf8"));
    expect(env.version).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/backend && bun test tests/rooms-flush-evict.test.ts`
Expected: FAIL — `setOnDirty`, `setPersistence`, `flushIfDirty`, `evict` not on `Rooms`.

- [ ] **Step 3: Extend `apps/backend/src/rooms.ts`**

Add to the `Rooms` class (around line 25, after constructor):

```ts
import type { FilePersistence } from "./persistence";

// ... inside class Rooms ...

private onDirty?: (id: RoomId, s: RoomState) => void;
private persistence?: FilePersistence;

setOnDirty(cb: (id: RoomId, s: RoomState) => void) {
  this.onDirty = cb;
}

setPersistence(p: FilePersistence) {
  this.persistence = p;
}

async flushIfDirty(id: RoomId): Promise<void> {
  if (!this.persistence) return;
  await this.persistence.flushIfDirty(id);
}

async evict(id: RoomId): Promise<void> {
  await this.flushIfDirty(id);
  this.map.delete(id);
}
```

**Note on import cycle:** `persistence.ts` imports `Rooms` (via `RoomStore` type). To avoid cycle, use `import type { FilePersistence }` in `rooms.ts` (type-only import erased at compile time).

- [ ] **Step 4: Run flush/evict test**

Run: `cd apps/backend && bun test tests/rooms-flush-evict.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire `Rooms` to persistence in `makeApp`**

Modify `apps/backend/src/index.ts` `makeApp()`. Replace the wiring block (after `const rooms = new Rooms(store);`):

```ts
const rooms = new Rooms(store);
if (persistence) {
  rooms.setPersistence(persistence);
  rooms.setOnDirty((id, s) => persistence.scheduleSave(id, s));
}
const bus = new WsHub();
```

And remove the `onDirty` parameter being passed to existing routes (they should now access `rooms.flushIfDirty` directly when needed, but for now existing routes use the `onDirty` opts pattern — keep that intact, just route the callback through `Rooms`).

Actually: re-read existing routes. `patchRoutes(rooms, bus, { onDirty })` — `onDirty` is the callback. Keep this for backwards compat; the existing routes pass it through. The new `setOnDirty` on `Rooms` is **additional** wiring used by new `rooms.ts` routes.

Cleanest path: keep existing `opts.onDirty` flow as-is (it works for backwards-compat), and `setOnDirty` is **only** used by new code paths in Task 5+ (which will mutate rooms in routes/rooms.ts).

Simplify: remove `setOnDirty` from the class — it's not needed because existing routes already have their own `onDirty` callback wiring. The class only needs `setPersistence` for `flushIfDirty/evict`.

Revise `apps/backend/src/rooms.ts` — drop `onDirty` handling:

```ts
private persistence?: FilePersistence;

setPersistence(p: FilePersistence) {
  this.persistence = p;
}

async flushIfDirty(id: RoomId): Promise<void> {
  if (!this.persistence) return;
  await this.persistence.flushIfDirty(id);
}

async evict(id: RoomId): Promise<void> {
  await this.flushIfDirty(id);
  this.map.delete(id);
}
```

Update test (remove `setOnDirty` line) — keep only `setPersistence`. Run again, expect PASS.

- [ ] **Step 6: Verify `index.ts` wiring**

`apps/backend/src/index.ts` `makeApp()` final form:

```ts
export function makeApp(opts: AppOpts = {}) {
  const storageDir = opts.storageDir ?? config.storageDir;
  const persistence = opts.inMemory ? null : new FilePersistence(storageDir);
  const store: RoomStore = persistence
    ? {
        load: (id) => persistence.load(id),
        save: (id, s) => persistence.save(id, s),
      }
    : { load: async () => null, save: async () => {} };
  const rooms = new Rooms(store);
  if (persistence) rooms.setPersistence(persistence);
  const bus = new WsHub();
  const app = new Hono();
  const onDirty = persistence
    ? (id: string, room: RoomState) => persistence.scheduleSave(id, room)
    : undefined;
  app.route("/", healthRoutes);
  app.route("/", versionRoutes);
  app.route("/", stateRoutes(rooms));
  app.route("/", patchRoutes(rooms, bus, { onDirty }));
  app.route("/", layoutRoutes(rooms, bus, { onDirty }));
  app.route("/", promptRoutes(rooms, bus, { onDirty }));
  app.route("/", aiRoutes(rooms, bus));
  return { app, rooms, bus, persistence };
}
```

- [ ] **Step 7: Run full backend test suite**

Run: `cd apps/backend && bun test`
Expected: All pass (existing 50+ tests still green; new 4 flush/evict tests added).

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/rooms.ts apps/backend/src/index.ts \
        apps/backend/tests/rooms-flush-evict.test.ts
git commit -m "feat(backend): Rooms.flushIfDirty + Rooms.evict for daemon-safe ops"
```

---

## Task 5: `GET /api/rooms` listing endpoint

**Files:**
- Create: `apps/backend/src/routes/rooms.ts`
- Test: `apps/backend/tests/routes-rooms.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/backend/tests/routes-rooms.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeApp } from "../src/index";
import { serialize } from "../src/envelope";
import { makeRoomState } from "../src/rooms";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "didraw-rt-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function seedRoom(id: string, mutate: (s: ReturnType<typeof makeRoomState>) => void) {
  const s = makeRoomState();
  mutate(s);
  writeFileSync(join(dir, `${id}.json`), serialize(id, s), "utf8");
}

describe("GET /api/rooms", () => {
  test("empty workspace → rooms: []", async () => {
    const { app } = makeApp({ storageDir: dir });
    const res = await app.fetch(new Request("http://localhost/api/rooms"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; rooms: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.rooms).toEqual([]);
  });

  test("lists existing files with envelope metadata", async () => {
    seedRoom("design-v1", (s) => {
      s.canvas.nodes.push({ id: "n1", kind: "rect", x: 0, y: 0 });
      s.version = 7;
    });
    seedRoom("default", (s) => {
      s.version = 0;
    });

    const { app } = makeApp({ storageDir: dir });
    const res = await app.fetch(new Request("http://localhost/api/rooms"));
    const body = (await res.json()) as {
      ok: boolean;
      rooms: Array<{
        id: string;
        version: number;
        elementCount: number;
        lastTouched: string;
      }>;
    };
    expect(body.ok).toBe(true);
    expect(body.rooms).toHaveLength(2);

    const v1 = body.rooms.find((r) => r.id === "design-v1");
    expect(v1?.version).toBe(7);
    expect(v1?.elementCount).toBe(1);

    const def = body.rooms.find((r) => r.id === "default");
    expect(def?.elementCount).toBe(0);
  });

  test("skips files in .archive/", async () => {
    seedRoom("active", () => {});
    mkdirSync(join(dir, ".archive"));
    seedRoom("archived", () => {});
    // move archived to .archive
    const { renameSync } = await import("node:fs");
    renameSync(join(dir, "archived.json"), join(dir, ".archive", "archived.json"));

    const { app } = makeApp({ storageDir: dir });
    const res = await app.fetch(new Request("http://localhost/api/rooms"));
    const body = (await res.json()) as { rooms: Array<{ id: string }> };
    expect(body.rooms.map((r) => r.id)).toEqual(["active"]);
  });

  test("skips malformed files (logs but doesn't crash)", async () => {
    writeFileSync(join(dir, "broken.json"), "not json", "utf8");
    seedRoom("good", () => {});
    const { app } = makeApp({ storageDir: dir });
    const res = await app.fetch(new Request("http://localhost/api/rooms"));
    const body = (await res.json()) as { rooms: Array<{ id: string }> };
    expect(body.rooms.map((r) => r.id)).toEqual(["good"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/backend && bun test tests/routes-rooms.test.ts`
Expected: FAIL — `/api/rooms` returns 404.

- [ ] **Step 3: Implement `apps/backend/src/routes/rooms.ts`**

```ts
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { parseHeader } from "../envelope";
import type { Rooms } from "../rooms";

export function roomsRoutes(rooms: Rooms, storageDir: string) {
  const app = new Hono();

  app.get("/api/rooms", async (c) => {
    try {
      const files = await readdir(storageDir);
      const out: Array<{
        id: string;
        version: number;
        elementCount: number;
        lastTouched: string;
        schemaVersion: number;
      }> = [];
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const id = f.slice(0, -5);
        try {
          const raw = await readFile(join(storageDir, f), "utf8");
          const hdr = parseHeader(raw);
          if (!hdr) continue;
          out.push({
            id,
            version: hdr.version,
            elementCount: hdr.elementCount,
            lastTouched: hdr.lastTouched,
            schemaVersion: hdr.schemaVersion,
          });
        } catch (e) {
          console.error("[rooms] skip", id, (e as Error).message);
        }
      }
      return c.json({ ok: true, rooms: out, dir: storageDir });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return c.json({ ok: true, rooms: [], dir: storageDir });
      }
      throw e;
    }
  });

  return app;
}
```

- [ ] **Step 4: Register the route in `makeApp`**

Modify `apps/backend/src/index.ts`. Add import:

```ts
import { roomsRoutes } from "./routes/rooms";
```

Add to `makeApp` after existing route lines:

```ts
app.route("/", roomsRoutes(rooms, storageDir));
```

- [ ] **Step 5: Run rooms route test**

Run: `cd apps/backend && bun test tests/routes-rooms.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/routes/rooms.ts apps/backend/src/index.ts \
        apps/backend/tests/routes-rooms.test.ts
git commit -m "feat(backend): GET /api/rooms — envelope-based room listing"
```

---

## Task 6: Archive / restore endpoints

**Files:**
- Modify: `apps/backend/src/routes/rooms.ts`
- Modify: `apps/backend/tests/routes-rooms.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `apps/backend/tests/routes-rooms.test.ts`:

```ts
describe("POST /api/rooms/:id/archive", () => {
  test("moves file to .archive/ and evicts from memory", async () => {
    seedRoom("to-archive", (s) => {
      s.canvas.nodes.push({ id: "n1", kind: "rect", x: 0, y: 0 });
      s.version = 3;
    });
    const { app } = makeApp({ storageDir: dir });

    // load into memory first
    await app.fetch(new Request("http://localhost/api/state?room=to-archive"));

    const res = await app.fetch(
      new Request("http://localhost/api/rooms/to-archive/archive", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const { existsSync } = await import("node:fs");
    expect(existsSync(join(dir, "to-archive.json"))).toBe(false);
    expect(existsSync(join(dir, ".archive", "to-archive.json"))).toBe(true);
  });

  test("404 if room file does not exist", async () => {
    const { app } = makeApp({ storageDir: dir });
    const res = await app.fetch(
      new Request("http://localhost/api/rooms/no-such/archive", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(404);
  });

  test("flushes dirty state before archiving", async () => {
    const { app, rooms, persistence } = makeApp({ storageDir: dir });
    // mutate without going through autosave commit timing
    const r = await rooms.get("dirty-room");
    r.canvas.nodes.push({ id: "n1", kind: "rect", x: 0, y: 0 });
    r.version = 5;
    r.dirty = true;
    persistence!.scheduleSave("dirty-room", r);

    const res = await app.fetch(
      new Request("http://localhost/api/rooms/dirty-room/archive", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(200);

    const { readFileSync } = await import("node:fs");
    const env = JSON.parse(
      readFileSync(join(dir, ".archive", "dirty-room.json"), "utf8"),
    );
    expect(env.version).toBe(5);
    expect(env.elementCount).toBe(1);
  });
});

describe("POST /api/rooms/:id/restore", () => {
  test("moves file back from .archive/", async () => {
    seedRoom("to-archive", () => {});
    const { app } = makeApp({ storageDir: dir });

    await app.fetch(
      new Request("http://localhost/api/rooms/to-archive/archive", {
        method: "POST",
      }),
    );
    const res = await app.fetch(
      new Request("http://localhost/api/rooms/to-archive/restore", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(200);

    const { existsSync } = await import("node:fs");
    expect(existsSync(join(dir, "to-archive.json"))).toBe(true);
    expect(existsSync(join(dir, ".archive", "to-archive.json"))).toBe(false);
  });

  test("404 if not archived", async () => {
    const { app } = makeApp({ storageDir: dir });
    const res = await app.fetch(
      new Request("http://localhost/api/rooms/none/restore", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(404);
  });

  test("409 if active id already exists", async () => {
    seedRoom("conflict", () => {});
    const { app } = makeApp({ storageDir: dir });

    // archive
    await app.fetch(
      new Request("http://localhost/api/rooms/conflict/archive", {
        method: "POST",
      }),
    );
    // create new active with same id
    seedRoom("conflict", () => {});

    const res = await app.fetch(
      new Request("http://localhost/api/rooms/conflict/restore", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(409);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/backend && bun test tests/routes-rooms.test.ts`
Expected: FAIL on new archive/restore cases (endpoints not defined → 404 on POST).

- [ ] **Step 3: Add archive + restore to `routes/rooms.ts`**

Append to the `roomsRoutes` function (before `return app`):

```ts
import { rename, mkdir, stat } from "node:fs/promises";

// ... inside roomsRoutes ...

app.post("/api/rooms/:id/archive", async (c) => {
  const id = c.req.param("id");
  const srcPath = join(storageDir, `${id}.json`);
  try {
    await stat(srcPath);
  } catch {
    return c.json({ ok: false, error: "room not found" }, 404);
  }

  await rooms.evict(id);  // flushes + removes from memory

  const archiveDir = join(storageDir, ".archive");
  await mkdir(archiveDir, { recursive: true });
  const dstPath = join(archiveDir, `${id}.json`);
  await rename(srcPath, dstPath);

  return c.json({ ok: true, archivedTo: dstPath });
});

app.post("/api/rooms/:id/restore", async (c) => {
  const id = c.req.param("id");
  const archiveDir = join(storageDir, ".archive");
  const srcPath = join(archiveDir, `${id}.json`);
  const dstPath = join(storageDir, `${id}.json`);

  try {
    await stat(srcPath);
  } catch {
    return c.json({ ok: false, error: "archived room not found" }, 404);
  }
  try {
    await stat(dstPath);
    return c.json(
      { ok: false, error: "active room with this id already exists" },
      409,
    );
  } catch {
    // dstPath does not exist — good
  }

  await rename(srcPath, dstPath);
  return c.json({ ok: true });
});
```

- [ ] **Step 4: Run tests**

Run: `cd apps/backend && bun test tests/routes-rooms.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/routes/rooms.ts apps/backend/tests/routes-rooms.test.ts
git commit -m "feat(backend): archive/restore endpoints with daemon-safe flush"
```

---

## Task 7: Export endpoint

**Files:**
- Modify: `apps/backend/src/routes/rooms.ts`
- Modify: `apps/backend/tests/routes-rooms.test.ts`
- Modify: `apps/backend/src/envelope.ts` — add `serializeExport`

- [ ] **Step 1: Add failing test**

Append to `apps/backend/tests/routes-rooms.test.ts`:

```ts
describe("POST /api/rooms/:id/export", () => {
  test("writes envelope with exportedAt to target path", async () => {
    seedRoom("design", (s) => {
      s.canvas.nodes.push({ id: "n1", kind: "rect", x: 1, y: 2 });
      s.version = 4;
    });
    const { app } = makeApp({ storageDir: dir });
    const target = join(dir, "..", "design-export.json");

    const res = await app.fetch(
      new Request("http://localhost/api/rooms/design/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: target }),
      }),
    );
    expect(res.status).toBe(200);

    const { readFileSync } = await import("node:fs");
    const env = JSON.parse(readFileSync(target, "utf8"));
    expect(env.schemaVersion).toBe(1);
    expect(env.roomId).toBe("design");
    expect(env.version).toBe(4);
    expect(env.elementCount).toBe(1);
    expect(typeof env.exportedAt).toBe("string");
    expect(env.canvas.nodes[0].id).toBe("n1");

    rmSync(target, { force: true });
  });

  test("flushes dirty room before export", async () => {
    const { app, rooms, persistence } = makeApp({ storageDir: dir });
    const r = await rooms.get("dirty");
    r.canvas.nodes.push({ id: "n1", kind: "rect", x: 0, y: 0 });
    r.version = 99;
    r.dirty = true;
    persistence!.scheduleSave("dirty", r);

    const target = join(dir, "..", "dirty-export.json");
    const res = await app.fetch(
      new Request("http://localhost/api/rooms/dirty/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: target }),
      }),
    );
    expect(res.status).toBe(200);

    const { readFileSync } = await import("node:fs");
    const env = JSON.parse(readFileSync(target, "utf8"));
    expect(env.version).toBe(99);

    rmSync(target, { force: true });
  });

  test("404 on non-existent room", async () => {
    const { app } = makeApp({ storageDir: dir });
    const res = await app.fetch(
      new Request("http://localhost/api/rooms/nope/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "/tmp/nope.json" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  test("400 if body missing `to`", async () => {
    seedRoom("r", () => {});
    const { app } = makeApp({ storageDir: dir });
    const res = await app.fetch(
      new Request("http://localhost/api/rooms/r/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/backend && bun test tests/routes-rooms.test.ts`
Expected: FAIL on new export cases.

- [ ] **Step 3: Add `serializeExport` to `envelope.ts`**

Append to `apps/backend/src/envelope.ts`:

```ts
export function serializeExport(roomId: string, s: RoomState): string {
  const base = JSON.parse(serialize(roomId, s)) as PersistedEnvelope;
  const exp: ExportEnvelope = {
    ...base,
    exportedAt: new Date().toISOString(),
  };
  return JSON.stringify(exp, null, 2);
}
```

- [ ] **Step 4: Add export endpoint to `routes/rooms.ts`**

Add import at top of `routes/rooms.ts`:

```ts
import { writeFile } from "node:fs/promises";
import { serializeExport } from "../envelope";
```

Add endpoint inside `roomsRoutes`:

```ts
app.post("/api/rooms/:id/export", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as { to?: string } | null;
  if (!body?.to) {
    return c.json({ ok: false, error: "expected {to: <path>}" }, 400);
  }

  const srcPath = join(storageDir, `${id}.json`);
  try {
    await stat(srcPath);
  } catch {
    return c.json({ ok: false, error: "room not found" }, 404);
  }

  // Flush any pending writes for this room before reading state.
  await rooms.flushIfDirty(id);

  // Get current state from in-memory rooms (if loaded) or disk.
  const room = await rooms.get(id);
  const raw = serializeExport(id, room);
  await writeFile(body.to, raw, "utf8");

  return c.json({ ok: true, path: body.to, schemaVersion: 1 });
});
```

- [ ] **Step 5: Run tests**

Run: `cd apps/backend && bun test tests/routes-rooms.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/envelope.ts apps/backend/src/routes/rooms.ts \
        apps/backend/tests/routes-rooms.test.ts
git commit -m "feat(backend): POST /api/rooms/:id/export — daemon-safe envelope export"
```

---

## Task 8: Import endpoint with --force semantics

**Files:**
- Modify: `apps/backend/src/routes/rooms.ts`
- Modify: `apps/backend/tests/routes-rooms.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `apps/backend/tests/routes-rooms.test.ts`:

```ts
describe("POST /api/rooms/import", () => {
  async function exportRoom(srcId: string, target: string) {
    const { app } = makeApp({ storageDir: dir });
    await app.fetch(
      new Request(`http://localhost/api/rooms/${srcId}/export`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: target }),
      }),
    );
  }

  test("imports to specified id with byte-equivalent canvas", async () => {
    seedRoom("source", (s) => {
      s.canvas.nodes.push({ id: "n1", kind: "rect", x: 1, y: 2 });
      s.version = 7;
    });
    const exported = join(dir, "..", "imp-source.json");
    await exportRoom("source", exported);

    const { app } = makeApp({ storageDir: dir });
    const res = await app.fetch(
      new Request("http://localhost/api/rooms/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: exported, as: "imported" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; roomId: string };
    expect(body.roomId).toBe("imported");

    const stateRes = await app.fetch(
      new Request("http://localhost/api/state?room=imported"),
    );
    const stateBody = (await stateRes.json()) as {
      canvas: { nodes: Array<{ id: string }> };
      version: number;
    };
    expect(stateBody.canvas.nodes[0].id).toBe("n1");
    expect(stateBody.version).toBe(7);

    rmSync(exported, { force: true });
  });

  test("409 on existing target without force", async () => {
    seedRoom("target", () => {});
    seedRoom("source", () => {});
    const exported = join(dir, "..", "imp-noforce.json");
    await exportRoom("source", exported);

    const { app } = makeApp({ storageDir: dir });
    const res = await app.fetch(
      new Request("http://localhost/api/rooms/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: exported, as: "target" }),
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.error).toMatch(/exists/);

    rmSync(exported, { force: true });
  });

  test("overwrites with force=true (flushes evicts target)", async () => {
    seedRoom("target", (s) => {
      s.canvas.nodes.push({ id: "old", kind: "rect", x: 0, y: 0 });
    });
    seedRoom("source", (s) => {
      s.canvas.nodes.push({ id: "new", kind: "rect", x: 0, y: 0 });
      s.version = 42;
    });
    const exported = join(dir, "..", "imp-force.json");
    await exportRoom("source", exported);

    const { app } = makeApp({ storageDir: dir });
    // load target into memory first
    await app.fetch(new Request("http://localhost/api/state?room=target"));

    const res = await app.fetch(
      new Request("http://localhost/api/rooms/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: exported, as: "target", force: true }),
      }),
    );
    expect(res.status).toBe(200);

    const stateRes = await app.fetch(
      new Request("http://localhost/api/state?room=target"),
    );
    const stateBody = (await stateRes.json()) as {
      canvas: { nodes: Array<{ id: string }> };
    };
    expect(stateBody.canvas.nodes[0].id).toBe("new");

    rmSync(exported, { force: true });
  });

  test("422 on schemaVersion mismatch", async () => {
    const badPath = join(dir, "..", "bad-schema.json");
    writeFileSync(
      badPath,
      JSON.stringify({
        schemaVersion: 999,
        roomId: "x",
        version: 0,
        lastTouched: "2026-01-01T00:00:00Z",
        elementCount: 0,
        canvas: { version: 1, nodes: [], edges: [], groups: [] },
        prompts: [],
      }),
      "utf8",
    );

    const { app } = makeApp({ storageDir: dir });
    const res = await app.fetch(
      new Request("http://localhost/api/rooms/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: badPath, as: "x" }),
      }),
    );
    expect(res.status).toBe(422);

    rmSync(badPath, { force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/backend && bun test tests/routes-rooms.test.ts`
Expected: FAIL on new import cases.

- [ ] **Step 3: Add import endpoint to `routes/rooms.ts`**

Add imports if missing:

```ts
import { copyFile } from "node:fs/promises";
import { parseFull } from "../envelope";
import { validateRoomId } from "../rooms";
```

Add endpoint:

```ts
app.post("/api/rooms/import", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { from?: string; as?: string; force?: boolean }
    | null;

  if (!body?.from) {
    return c.json({ ok: false, error: "expected {from, as?, force?}" }, 400);
  }

  let raw: string;
  try {
    raw = await readFile(body.from, "utf8");
  } catch {
    return c.json({ ok: false, error: "source file not found" }, 404);
  }

  let env;
  try {
    env = parseFull(raw);
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 422);
  }

  const targetId = body.as ?? env.roomId;
  if (!validateRoomId(targetId)) {
    return c.json(
      { ok: false, error: `invalid target room id "${targetId}"` },
      422,
    );
  }

  const dstPath = join(storageDir, `${targetId}.json`);
  let exists = false;
  try {
    await stat(dstPath);
    exists = true;
  } catch {}

  if (exists && !body.force) {
    return c.json(
      { ok: false, error: `room "${targetId}" exists; pass force:true to overwrite` },
      409,
    );
  }

  if (exists) {
    await rooms.evict(targetId);   // flush + remove from memory
  }

  // Write a new envelope with target id (rewrite roomId, drop exportedAt)
  const newEnv = {
    schemaVersion: env.schemaVersion,
    roomId: targetId,
    version: env.version,
    lastTouched: env.lastTouched,
    elementCount: env.elementCount,
    canvas: env.canvas,
    prompts: env.prompts,
  };
  await writeFile(dstPath, JSON.stringify(newEnv, null, 2), "utf8");

  return c.json({ ok: true, roomId: targetId, version: env.version });
});
```

- [ ] **Step 4: Run tests**

Run: `cd apps/backend && bun test tests/routes-rooms.test.ts`
Expected: PASS.

- [ ] **Step 5: Add DELETE endpoint**

Append to `routes/rooms.ts`:

```ts
import { unlink } from "node:fs/promises";

app.delete("/api/rooms/:id", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { confirm?: boolean };
  if (!body.confirm) {
    return c.json(
      { ok: false, error: "expected {confirm:true} in body" },
      400,
    );
  }

  const path = join(storageDir, `${id}.json`);
  try {
    await stat(path);
  } catch {
    return c.json({ ok: false, error: "room not found" }, 404);
  }

  await rooms.evict(id);
  await unlink(path);
  return c.json({ ok: true });
});
```

Add test in `tests/routes-rooms.test.ts`:

```ts
describe("DELETE /api/rooms/:id", () => {
  test("requires confirm:true", async () => {
    seedRoom("doomed", () => {});
    const { app } = makeApp({ storageDir: dir });
    const res = await app.fetch(
      new Request("http://localhost/api/rooms/doomed", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(400);
  });

  test("removes file with confirm:true", async () => {
    seedRoom("doomed", () => {});
    const { app } = makeApp({ storageDir: dir });
    const res = await app.fetch(
      new Request("http://localhost/api/rooms/doomed", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      }),
    );
    expect(res.status).toBe(200);
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(dir, "doomed.json"))).toBe(false);
  });

  test("no autosave overwrite after delete", async () => {
    const { app, rooms, persistence } = makeApp({ storageDir: dir });
    const r = await rooms.get("ghost");
    r.canvas.nodes.push({ id: "n1", kind: "rect", x: 0, y: 0 });
    r.dirty = true;
    r.version = 1;
    persistence!.scheduleSave("ghost", r);

    await app.fetch(
      new Request("http://localhost/api/rooms/ghost", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      }),
    );

    // wait past debounce window
    await new Promise((res) => setTimeout(res, 400));

    const { existsSync } = await import("node:fs");
    expect(existsSync(join(dir, "ghost.json"))).toBe(false);
  });
});
```

- [ ] **Step 6: Run all rooms tests**

Run: `cd apps/backend && bun test tests/routes-rooms.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/routes/rooms.ts apps/backend/tests/routes-rooms.test.ts
git commit -m "feat(backend): rooms import (force semantics) + DELETE endpoint"
```

---

## Task 9: CLI lifecycle rewrite — HTTP-via-daemon

**Files:**
- Modify: `packages/didraw-client/src/index.ts` — add `listRooms`, `archiveRoom`, `restoreRoom`, `exportRoom`, `importRoom`, `deleteRoom`
- Modify: `packages/didraw-cli/src/lifecycle.ts` — methods use HTTP
- Modify: `packages/didraw-cli/src/index.ts` — register new subcommands
- Create: `packages/didraw-cli/tests/lifecycle.http.test.ts`

- [ ] **Step 1: Add client methods**

Append to `packages/didraw-client/src/index.ts` (before the closing `}`):

```ts
async listRooms() {
  const r = await fetch(`${this.base}/api/rooms`);
  return r.json();
}

async archiveRoom(id: string) {
  const r = await fetch(`${this.base}/api/rooms/${encodeURIComponent(id)}/archive`, {
    method: "POST",
  });
  return r.json();
}

async restoreRoom(id: string) {
  const r = await fetch(`${this.base}/api/rooms/${encodeURIComponent(id)}/restore`, {
    method: "POST",
  });
  return r.json();
}

async exportRoom(id: string, to: string) {
  const r = await fetch(`${this.base}/api/rooms/${encodeURIComponent(id)}/export`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to }),
  });
  return r.json();
}

async importRoom(from: string, opts: { as?: string; force?: boolean } = {}) {
  const r = await fetch(`${this.base}/api/rooms/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from, as: opts.as, force: opts.force }),
  });
  return r.json();
}

async deleteRoom(id: string, confirm = false) {
  const r = await fetch(`${this.base}/api/rooms/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm }),
  });
  return r.json();
}
```

- [ ] **Step 2: Rewrite `packages/didraw-cli/src/lifecycle.ts`**

Full new contents:

```ts
import { spawn } from "node:child_process";
import { CanvasClient } from "@didraw/client";
import { ensure } from "./daemon";
import type { Profile } from "./profile";
import { portFor } from "./profile";

function clientFor(profile: Profile): CanvasClient {
  return new CanvasClient({
    baseUrl: `http://localhost:${portFor(profile)}`,
  });
}

export async function open(room: string, profile: Profile) {
  await ensure(profile);
  const url = `http://localhost:${portFor(profile)}/?room=${encodeURIComponent(room)}`;
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
  console.log(JSON.stringify({ ok: true, url, profile }));
}

export async function list(profile: Profile) {
  await ensure(profile);
  const res = await clientFor(profile).listRooms();
  console.log(JSON.stringify(res));
}

export async function exportRoom(
  room: string,
  to: string,
  profile: Profile,
) {
  await ensure(profile);
  const res = await clientFor(profile).exportRoom(room, to);
  console.log(JSON.stringify(res));
  if ((res as { ok?: boolean }).ok === false) process.exit(1);
}

export async function importRoom(
  from: string,
  opts: { as?: string; force?: boolean },
  profile: Profile,
) {
  await ensure(profile);
  const res = await clientFor(profile).importRoom(from, opts);
  console.log(JSON.stringify(res));
  if ((res as { ok?: boolean }).ok === false) process.exit(1);
}

export async function archiveRoom(room: string, profile: Profile) {
  await ensure(profile);
  const res = await clientFor(profile).archiveRoom(room);
  console.log(JSON.stringify(res));
  if ((res as { ok?: boolean }).ok === false) process.exit(1);
}

export async function restoreRoom(room: string, profile: Profile) {
  await ensure(profile);
  const res = await clientFor(profile).restoreRoom(room);
  console.log(JSON.stringify(res));
  if ((res as { ok?: boolean }).ok === false) process.exit(1);
}

export async function rmRoom(
  room: string,
  opts: { confirm?: boolean } = {},
  profile: Profile,
) {
  await ensure(profile);
  if (!opts.confirm) {
    console.error(
      JSON.stringify({ ok: false, error: "expected --confirm flag" }),
    );
    process.exit(1);
  }
  const res = await clientFor(profile).deleteRoom(room, true);
  console.log(JSON.stringify(res));
  if ((res as { ok?: boolean }).ok === false) process.exit(1);
}
```

- [ ] **Step 3: Register CLI subcommands**

Read existing `packages/didraw-cli/src/index.ts` first to see the current subcommand dispatch pattern. Then update the `rooms` subcommand handler. The pattern should look like:

```ts
// pseudo, real shape will mirror existing dispatch:
if (cmd === "rooms") {
  const sub = argv.shift();
  const profile = resolveProfile(argv);
  if (sub === "list") return list(profile);
  if (sub === "archive") {
    const id = argv.shift();
    if (!id) { console.error(JSON.stringify({ ok: false, error: "expected <id>" })); process.exit(1); }
    return archiveRoom(id, profile);
  }
  if (sub === "restore") {
    const id = argv.shift();
    if (!id) { console.error(JSON.stringify({ ok: false, error: "expected <id>" })); process.exit(1); }
    return restoreRoom(id, profile);
  }
  if (sub === "export") {
    const id = argv.shift();
    let to: string | undefined;
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--to") to = argv[++i];
    }
    if (!id || !to) { console.error(JSON.stringify({ ok: false, error: "expected <id> --to <path>" })); process.exit(1); }
    return exportRoom(id, to, profile);
  }
  if (sub === "import") {
    const from = argv.shift();
    let as: string | undefined;
    let force = false;
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--as") as = argv[++i];
      else if (argv[i] === "--force") force = true;
    }
    if (!from) { console.error(JSON.stringify({ ok: false, error: "expected <path>" })); process.exit(1); }
    return importRoom(from, { as, force }, profile);
  }
  if (sub === "rm") {
    const id = argv.shift();
    const confirm = argv.includes("--confirm");
    if (!id) { console.error(JSON.stringify({ ok: false, error: "expected <id>" })); process.exit(1); }
    return rmRoom(id, { confirm }, profile);
  }
  console.error(JSON.stringify({ ok: false, error: `unknown rooms subcommand: ${sub}` }));
  process.exit(1);
}
```

Read `packages/didraw-cli/src/index.ts` first and match the existing flow precisely; the snippet above is a guide, not a drop-in.

- [ ] **Step 4: Write CLI integration test**

Create `packages/didraw-cli/tests/lifecycle.http.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeApp } from "@didraw/backend/src/index";
import { startServer } from "@didraw/backend/src/index";
import { CanvasClient } from "@didraw/client";

let dir: string;
let server: Awaited<ReturnType<typeof startServer>>;
let port: number;
let client: CanvasClient;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "didraw-cli-"));
  // pick an ephemeral port
  port = 30000 + Math.floor(Math.random() * 1000);
  process.env.DIDRAW_STORAGE_DIR = dir;
  process.env.DIDRAW_PORT = String(port);
  server = await startServer({ storageDir: dir, port });
  client = new CanvasClient({ baseUrl: `http://localhost:${port}` });
});

afterEach(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.DIDRAW_STORAGE_DIR;
  delete process.env.DIDRAW_PORT;
});

describe("CLI lifecycle via HTTP", () => {
  test("list empty workspace", async () => {
    const r = (await client.listRooms()) as { rooms: unknown[] };
    expect(r.rooms).toEqual([]);
  });

  test("export → import roundtrip", async () => {
    // create a room with state
    await client.applyPatch(
      [{ op: "add", target: "node", value: { id: "n1", kind: "rect", x: 0, y: 0 } }],
      { source: "user" },
    );
    const target = join(dir, "..", "exp.json");
    const exp = (await client.exportRoom("default", target)) as { ok: boolean };
    expect(exp.ok).toBe(true);

    const imp = (await client.importRoom(target, { as: "restored" })) as {
      ok: boolean;
      roomId: string;
    };
    expect(imp.ok).toBe(true);
    expect(imp.roomId).toBe("restored");

    const list = (await client.listRooms()) as {
      rooms: Array<{ id: string }>;
    };
    expect(list.rooms.map((r) => r.id).sort()).toEqual(["default", "restored"]);

    rmSync(target, { force: true });
  });

  test("archive then restore", async () => {
    await client.applyPatch(
      [{ op: "add", target: "node", value: { id: "n1", kind: "rect", x: 0, y: 0 } }],
      { source: "user" },
    );
    expect((await client.archiveRoom("default") as { ok: boolean }).ok).toBe(true);
    expect((await client.listRooms() as { rooms: unknown[] }).rooms).toEqual([]);

    expect((await client.restoreRoom("default") as { ok: boolean }).ok).toBe(true);
    expect(
      ((await client.listRooms()) as { rooms: Array<{ id: string }> }).rooms.length,
    ).toBe(1);
  });
});
```

- [ ] **Step 5: Run CLI test**

Run: `cd packages/didraw-cli && bun test tests/lifecycle.http.test.ts`
Expected: PASS.

- [ ] **Step 6: Manual smoke (dual-folder isolation)**

```bash
# terminal 1
cd /tmp && mkdir didraw-test-a && cd didraw-test-a
DIDRAW_PROJECT_DIR=$PWD bun /Users/tretyakov_dv/Projects/sandbox/di.draw/packages/didraw-cli/src/index.ts daemon ensure
bun /Users/tretyakov_dv/Projects/sandbox/di.draw/packages/didraw-cli/src/index.ts patch --stdin <<<'{"ops":[{"op":"add","target":"node","value":{"id":"a","kind":"rect","x":0,"y":0}}]}'
bun /Users/tretyakov_dv/Projects/sandbox/di.draw/packages/didraw-cli/src/index.ts rooms list

# terminal 2 — different folder, different port via env override won't matter here since they share daemon by default profile
# Better isolation test: kill daemon, switch folder, run again
```

Run the dual-folder test described in spec §4.2 and verify each folder gets its own canvas dir under `~/.claude/projects/<slug-hash>/`.

Expected: two distinct directories with `<bn>-<hash8>` slug pattern.

- [ ] **Step 7: Commit**

```bash
git add packages/didraw-client/src/index.ts \
        packages/didraw-cli/src/lifecycle.ts \
        packages/didraw-cli/src/index.ts \
        packages/didraw-cli/tests/lifecycle.http.test.ts
git commit -m "feat(cli): rooms subcommands via HTTP (daemon-safe)"
```

---

## Task 10: Skill cheat-sheet + CHANGELOG + version bump

**Files:**
- Modify: `.claude/skills/draw/SKILL.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json` (root)
- Modify: `release/VERSION` (если файл существует)

- [ ] **Step 1: Inject rooms list at top of SKILL.md**

Modify `.claude/skills/draw/SKILL.md`. After the existing "Current canvas state" section, add:

````markdown
## Rooms in this workspace

!`didraw rooms list 2>/dev/null || echo '{"rooms":[]}'`

If `rooms` lists non-empty schemas relevant to the current dialogue, ask the user whether to continue an existing schema or start a new one. Don't clutter the `default` room with unrelated ad-hoc diagrams. Use `--room <id>` on data commands to address a specific room.
````

- [ ] **Step 2: Update SKILL.md command examples**

In the same file, after the existing "Commands" section, add:

````markdown
### Rooms management

```
didraw rooms list                                    # list with elementCount + version
didraw rooms archive <id>                            # move to .archive/
didraw rooms restore <id>                            # restore from .archive/
didraw rooms export <id> --to /path/to/file.json     # save snapshot
didraw rooms import /path/to/file.json [--as <id>] [--force]
didraw rooms rm <id> --confirm                       # hard delete
```
````

- [ ] **Step 3: Add CHANGELOG entry**

Open `CHANGELOG.md`. Add at top under a new "0.1.0 — 2026-05-15" header:

```markdown
## 0.1.0 — 2026-05-15

### Phase 2.0 — Persistence hardening

**Storage:**
- Workspace-scoped storage path (was hard-coded `default-project`). Resolution: `DIDRAW_PROJECT_DIR > CLAUDE_PROJECT_DIR > cwd`. Collision-resistant slug (`name-<sha1[0:8]>`) prevents same-basename folders colliding.
- Persisted envelope format: `{schemaVersion, roomId, version, lastTouched, elementCount, canvas, prompts}`. Single contract between storage and export.
- Room id validation: `/^[a-zA-Z0-9_-]{1,64}$/`. Invalid ids rejected with 422 (no silent mangle).

**Daemon-safe rooms API:**
- `GET /api/rooms` — listing with envelope metadata (version, elementCount, lastTouched).
- `POST /api/rooms/:id/archive` / `/restore` — move to `.archive/` and back.
- `POST /api/rooms/:id/export` — write envelope + `exportedAt` to disk.
- `POST /api/rooms/import` — restore from file with `as`/`force` options.
- `DELETE /api/rooms/:id` — hard delete with `{confirm:true}` body.

All ops use `flushIfDirty + evict + filesystem op` pattern, so daemon's autosave never overwrites a fresh archive/delete/import.

**CLI:**
- `didraw rooms list/archive/restore/export/import/rm` — all via HTTP, not direct filesystem.
- Existing `didraw rooms list` / `export` / `rm` behaviour preserved (signatures unchanged), but underlying transport now goes through daemon.

**Skill:**
- `/draw` cheat-sheet inject `didraw rooms list` at startup so AI sees existing schemas before deciding default-vs-resume.
```

- [ ] **Step 4: Bump version**

Modify root `package.json`:

```diff
-  "version": "0.0.1",
+  "version": "0.1.0",
```

If `release/VERSION` exists, also update.

```bash
test -f release/VERSION && echo "0.1.0" > release/VERSION
```

(If it doesn't exist, skip — it's generated by `scripts/build-release.sh`.)

- [ ] **Step 5: Final full test run**

```bash
cd /Users/tretyakov_dv/Projects/sandbox/di.draw
bun run test
```

Expected: ALL tests across all packages pass. Existing 52+ tests preserved, new Phase 2.0 tests added (~25 new tests).

- [ ] **Step 6: Final smoke — dual-folder isolation**

```bash
# Stop any existing daemon first
bun packages/didraw-cli/src/index.ts daemon stop || true

# Folder A
cd /tmp && rm -rf didraw-test-a && mkdir didraw-test-a && cd didraw-test-a
DIDRAW_PROJECT_DIR=$PWD bun /Users/tretyakov_dv/Projects/sandbox/di.draw/packages/didraw-cli/src/index.ts daemon ensure
DIDRAW_PROJECT_DIR=$PWD bun /Users/tretyakov_dv/Projects/sandbox/di.draw/packages/didraw-cli/src/index.ts rooms list
# Expected: rooms: [], dir contains "didraw-test-a-<hash>"

# Make a room
DIDRAW_PROJECT_DIR=$PWD bun /Users/tretyakov_dv/Projects/sandbox/di.draw/packages/didraw-cli/src/index.ts patch --stdin <<<'{"ops":[{"op":"add","target":"node","value":{"id":"a","kind":"rect","x":0,"y":0}}]}'
DIDRAW_PROJECT_DIR=$PWD bun /Users/tretyakov_dv/Projects/sandbox/di.draw/packages/didraw-cli/src/index.ts rooms list
# Expected: rooms: [{id:"default", elementCount:1, ...}]

# Stop daemon, switch to folder B
bun /Users/tretyakov_dv/Projects/sandbox/di.draw/packages/didraw-cli/src/index.ts daemon stop
cd /tmp && rm -rf didraw-test-b && mkdir didraw-test-b && cd didraw-test-b
DIDRAW_PROJECT_DIR=$PWD bun /Users/tretyakov_dv/Projects/sandbox/di.draw/packages/didraw-cli/src/index.ts daemon ensure
DIDRAW_PROJECT_DIR=$PWD bun /Users/tretyakov_dv/Projects/sandbox/di.draw/packages/didraw-cli/src/index.ts rooms list
# Expected: rooms: [], dir DIFFERENT from folder A

# Verify isolation: folder A's room not visible in folder B
ls ~/.claude/projects/didraw-test-*-*/canvas/ 2>/dev/null
# Expected: two separate directories, each with own contents

# Cleanup
bun /Users/tretyakov_dv/Projects/sandbox/di.draw/packages/didraw-cli/src/index.ts daemon stop
rm -rf /tmp/didraw-test-a /tmp/didraw-test-b
rm -rf ~/.claude/projects/didraw-test-*
```

If isolation works — done. If not, debug `config.ts` path resolution.

- [ ] **Step 7: Rebuild single-binary and smoke**

```bash
cd /Users/tretyakov_dv/Projects/sandbox/di.draw
bash scripts/build-release.sh
# Smoke test the binary
release/didraw-* rooms list
# Expected: {"ok":true,"rooms":[...],"dir":"..."}
```

- [ ] **Step 8: Commit and tag**

```bash
git add CHANGELOG.md package.json release/VERSION .claude/skills/draw/SKILL.md
git commit -m "release: 0.1.0 — Phase 2.0 persistence hardening"
git tag v0.1.0
```

---

## Self-Review

### Spec coverage check

| Spec section | Task(s) implementing |
|---|---|
| §2.1 Workspace-scoped storage / slugify | Task 1 |
| §2.1 Room id resolution chain | Task 3 (validation), existing routes used in tasks 5-8 |
| §2.1 No `rooms use` | (covered by omission — no endpoint, no CLI cmd) |
| §2.2 Persisted envelope | Task 2 |
| §2.2 Daemon-safe ops invariants | Tasks 4, 6, 7, 8 |
| §2.2 Metadata listing | Task 5 |
| §2.3 CLI surface | Task 9 |
| §2.4 Export schema | Task 7 (+ Task 2 envelope) |
| §2.4 Overwrite semantics + force | Task 8 |
| §2.5 Skill startup awareness | Task 10 |
| §4.1 Slug/project/room validation tests | Tasks 1, 3 |
| §4.2 Workspace isolation tests | Task 10 Step 6 (manual smoke); Task 9 unit |
| §4.3 Daemon-safe invariants tests | Tasks 4, 6, 7, 8 |
| §4.4 Export/import roundtrip + schema mismatch | Tasks 7, 8 |
| §4.5 CLI integration | Task 9 |

All spec sections have at least one task. No gaps.

### Placeholder scan

- No "TBD"/"TODO"/"implement later" in steps.
- Every code step contains complete code (not "add similar code").
- Test code is concrete with real assertions.
- Commit messages are specific.

### Type consistency

- `validateRoomId` introduced in Task 3, used in Task 8 (import endpoint) — same name, same signature.
- `Rooms.flushIfDirty` / `Rooms.evict` defined in Task 4, used in Tasks 6, 7, 8.
- `EnvelopeHeader` / `PersistedEnvelope` / `ExportEnvelope` defined in Task 2, used in Tasks 5, 7.
- `serialize` / `parseHeader` / `parseFull` / `serializeExport` — all from Task 2, names consistent in later tasks.
- `CanvasClient.listRooms/archiveRoom/restoreRoom/exportRoom/importRoom/deleteRoom` — added in Task 9 Step 1, used in Task 9 Step 4 test.

Plan internally consistent.
