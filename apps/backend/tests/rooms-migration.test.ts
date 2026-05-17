// apps/backend/tests/rooms-migration.test.ts
// Phase 3.0 Task 11: lazy v2 → v3 migration в FilePersistence.load.
//
// Контракт (spec §9):
// 1. v3 envelope читается as-is через parseFull.
// 2. v2/v1 envelope: парсится через parseV2OrThrow → migrateV2ToV3 → atomic-rewrite
//    как v3, оригинал переименовывается в `<file>.v2.bak`. didrawIndex перестраивается.
//
// Эти тесты доказывают, что миграция выполняется именно при load (а не при save),
// и что .v2.bak создаётся ровно один раз (повторный load v3 файла не трогает backup).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilePersistence } from "../src/persistence";
import { Rooms } from "../src/rooms";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "didraw-mig-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("rooms.load migration", () => {
  test("loads v3 envelope as-is (no migration, no .v2.bak)", async () => {
    const file = join(dir, "r.json");
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 3,
        roomId: "r",
        version: 0,
        lastTouched: new Date().toISOString(),
        elementCount: 0,
        didraw: { didrawVersion: "0.4.0", createdAt: new Date().toISOString() },
        store: {
          schema: { schemaVersion: 1, storeVersion: 4, recordVersions: {} },
          store: {
            "document:document": {
              id: "document:document",
              typeName: "document",
              gridSize: 10,
              name: "",
              meta: {},
            },
            "page:page": {
              id: "page:page",
              typeName: "page",
              name: "Page 1",
              index: "a1",
              meta: {},
            },
          },
        },
        prompts: [],
        opLog: [],
      }),
    );

    const persistence = new FilePersistence(dir);
    const rooms = new Rooms({
      load: persistence.load.bind(persistence),
      save: persistence.save.bind(persistence),
    });
    rooms.setPersistence(persistence);
    const r = await rooms.get("r");

    expect(r.store.store["document:document"]).toBeDefined();
    expect(r.store.store["page:page"]).toBeDefined();
    expect(r.version).toBe(0);
    expect(existsSync(`${file}.v2.bak`)).toBe(false);
    // Файл не должен быть переписан — содержимое осталось v3.
    const raw = JSON.parse(readFileSync(file, "utf8"));
    expect(raw.schemaVersion).toBe(3);
  });

  test("auto-migrates v2 → v3 on load; creates .v2.bak; rewrites file as v3", async () => {
    const file = join(dir, "r.json");
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 2,
        roomId: "r",
        version: 7,
        lastTouched: new Date().toISOString(),
        elementCount: 1,
        canvas: {
          version: 1,
          nodes: [
            {
              id: "shape:e_backend",
              kind: "rect",
              x: 10,
              y: 20,
              w: 120,
              h: 80,
              label: "backend",
              meta: { name: "backend", role: "service" },
            },
          ],
          edges: [],
          groups: [],
        },
        prompts: [],
        opLog: [],
      }),
    );

    const persistence = new FilePersistence(dir);
    const rooms = new Rooms({
      load: persistence.load.bind(persistence),
      save: persistence.save.bind(persistence),
    });
    rooms.setPersistence(persistence);
    const r = await rooms.get("r");

    // 1. В store присутствуют document + page boilerplate
    expect(r.store.store["document:document"]).toBeDefined();
    expect(r.store.store["page:page"]).toBeDefined();

    // 2. v2 node превратился ровно в один shape
    const shapes = Object.values(r.store.store).filter(
      (x) => (x as { typeName?: string }).typeName === "shape",
    );
    expect(shapes.length).toBe(1);
    const shape = shapes[0] as {
      type: string;
      x: number;
      y: number;
      meta?: Record<string, unknown>;
    };
    expect(shape.type).toBe("geo");
    expect(shape.x).toBe(10);
    expect(shape.y).toBe(20);
    expect(shape.meta?.didrawName).toBe("backend");
    expect(shape.meta?.role).toBe("service");

    // 3. didrawIndex заполнен по новой схеме (name → shape.id)
    expect(r.didrawIndex.get("backend")).toBeDefined();

    // 4. Version сохранён из v2
    expect(r.version).toBe(7);

    // 5. .v2.bak создан и содержит оригинальный v2 JSON
    const backupPath = `${file}.v2.bak`;
    expect(existsSync(backupPath)).toBe(true);
    const backup = JSON.parse(readFileSync(backupPath, "utf8"));
    expect(backup.schemaVersion).toBe(2);
    expect(backup.canvas.nodes[0].id).toBe("shape:e_backend");

    // 6. Главный файл переписан как v3 атомарно (без последующего flush)
    const reread = JSON.parse(readFileSync(file, "utf8"));
    expect(reread.schemaVersion).toBe(3);
    expect(reread.roomId).toBe("r");
    expect(reread.version).toBe(7);

    // 7. Повторный load уже читает v3, .v2.bak не перезатирается
    await rooms.evict("r");
    const r2 = await rooms.get("r");
    expect(r2.didrawIndex.get("backend")).toBeDefined();
    const backupAfter = JSON.parse(readFileSync(backupPath, "utf8"));
    expect(backupAfter.schemaVersion).toBe(2);
  });
});
