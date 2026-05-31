# Autolayout Rebuild A — Engine Comparison Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать в paste-окне Mermaid выбор движка размещения (`Dagre | ELK | Custom`), импортировать один и тот же код любым из них в одну бесконечную доску со смещением (без наложения), чтобы визуально сравнить качество раскладки и выбрать движок для куска B.

**Architecture:** Тонкий frontend-диспетчер `importMermaidWithEngine` маршрутизирует на существующий `importMermaidLegacy` (dagre/elk через `createMermaidDiagram`, throwaway-шейпы) или на существующий `importMermaid` (custom → backend v2). ELK включается регистрацией `@mermaid-js/layout-elk` на прямом инстансе `mermaid`. После создания результат сдвигается в свободное место правее существующего контента. Сравнение — через родной `editor.toImage` / chrome-MCP скриншоты.

**Tech Stack:** TypeScript, React, tldraw 5.0.0, `@tldraw/mermaid` 5.0.0 (mermaid 11.12.2), `@mermaid-js/layout-elk`, bun test.

**Spec:** `docs/superpowers/specs/2026-05-29-autolayout-rebuild-A-engine-comparison-design.md`

**Все API сверены с type-defs:** `editor.getCurrentPageBounds(): Box | undefined`, `Box.maxX` (getter), `editor.getViewportPageBounds(): Box`, `editor.toImage(ids, opts): Promise<{blob}>`, `exportAs(editor, ids, opts)`, `mermaid.registerLayoutLoaders` (mermaid@11.12.2 d.ts:173).

**Working dir / branch:** `/Users/tretyakov_dv/Projects/sandbox/di.draw`, ветка `feature/autolayout-rebuild` (уже создана от `0.28.0`).

**Команды тестов:**
- Один файл: `bun test --cwd apps/frontend src/canvas/mermaid-import.test.ts`
- Модалка: `bun test --cwd apps/frontend src/mermaid/MermaidImportModal.test.tsx`
- Весь фронт: `bun test --cwd apps/frontend src`
- Типы фронта: `bun --cwd apps/frontend run typecheck` (если скрипта нет — `bunx tsc -p apps/frontend/tsconfig.json --noEmit`)

---

## File Structure

Всё новое — в одном уже существующем модуле + модалка + одна точка во `App.tsx` (следуем текущему расположению, файл не дробим):

- `apps/frontend/src/canvas/mermaid-import.ts` — добавить: тип `LayoutEngine`; поля `engineUsed?`/`engineFallback?` в `MermaidImportResult`; `ensureElkLoader()`; параметр `opts?` у `importMermaidLegacy`; чистая `computeImportOriginX()`; `repositionToOriginX()`; `repositionCustomFrameWhenReady()`; диспетчер `importMermaidWithEngine()`.
- `apps/frontend/src/canvas/mermaid-import.test.ts` — новые тесты (дополняем существующий файл).
- `apps/frontend/src/mermaid/MermaidImportModal.tsx` — `<select>` движка; `onSubmit(source, engine)`; engine-state last-used (не сбрасывается при закрытии); экспорт `MERMAID_ENGINE_OPTIONS` + `DEFAULT_MERMAID_ENGINE`; `LayoutEngine` импортируется из `../canvas/mermaid-import` (DRY, без дублирования union-типа).
- `apps/frontend/src/mermaid/MermaidImportModal.test.ts` — новый тест-файл. **Во фронте НЕТ DOM-тест-инфры** (`@testing-library/react`/jsdom отсутствуют; `.test.tsx` нет; компоненты тестируются чистой инспекцией дерева/констант — см. `apps/frontend/src/settings/panels/panels.test.ts`). Поэтому тестируем экспортированную чистую константу опций; интеракция (выбор → onSubmit) проверяется типчеком + live (Task 9) + routing-тестами диспетчера (Task 6).
- `apps/frontend/src/App.tsx` — paste-modal call-site (~:687) → `importMermaidWithEngine`. Call-sites :389 и :592 НЕ трогаем.
- `apps/frontend/package.json` — dep `@mermaid-js/layout-elk`.

---

## Task 1: Зависимость ELK + тип движка + идемпотентная регистрация loader'а

**Files:**
- Modify: `apps/frontend/package.json`
- Modify: `apps/frontend/src/canvas/mermaid-import.ts`
- Test: `apps/frontend/src/canvas/mermaid-import.test.ts`

- [ ] **Step 1: Установить dep ELK-плагина**

Run:
```bash
cd /Users/tretyakov_dv/Projects/sandbox/di.draw && bun add --cwd apps/frontend @mermaid-js/layout-elk@^0.2.0
```
Expected: `apps/frontend/package.json` получает `"@mermaid-js/layout-elk": "^0.2.0"` в `dependencies`; `bun.lock` обновлён.
Примечание: если `^0.2.0` несовместим с mermaid 11.12.2 (peer-warning при install), взять версию, чей peer-range покрывает mermaid 11.x (проверить `bun pm ls @mermaid-js/layout-elk` / npm page) и зафиксировать её. Зафиксированную версию записать в spec §9.

- [ ] **Step 2: Написать падающий тест на идемпотентную регистрацию**

В `apps/frontend/src/canvas/mermaid-import.test.ts` добавить в конец файла:

```ts
describe("ensureElkLoader — idempotent ELK loader registration", () => {
  test("registers exactly once across multiple calls; returns true", async () => {
    let registerCalls = 0;
    mock.module("mermaid", () => ({
      default: {
        registerLayoutLoaders: (_loaders: unknown) => {
          registerCalls++;
        },
      },
    }));
    mock.module("@mermaid-js/layout-elk", () => ({ default: [{ name: "elk" }] }));

    const { ensureElkLoader, __resetElkLoaderForTest } = await import(
      "./mermaid-import"
    );
    __resetElkLoaderForTest();

    const r1 = await ensureElkLoader();
    const r2 = await ensureElkLoader();
    const r3 = await ensureElkLoader();

    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(r3).toBe(true);
    expect(registerCalls).toBe(1);
  });

  test("returns false (no throw) when registration fails", async () => {
    mock.module("mermaid", () => ({
      default: {
        registerLayoutLoaders: () => {
          throw new Error("loader incompatible");
        },
      },
    }));
    mock.module("@mermaid-js/layout-elk", () => ({ default: [] }));

    const { ensureElkLoader, __resetElkLoaderForTest } = await import(
      "./mermaid-import"
    );
    __resetElkLoaderForTest();

    const r = await ensureElkLoader();
    expect(r).toBe(false);
  });
});
```

- [ ] **Step 3: Запустить тест — убедиться, что падает**

Run: `bun test --cwd apps/frontend src/canvas/mermaid-import.test.ts`
Expected: FAIL — `ensureElkLoader`/`__resetElkLoaderForTest` не экспортированы.

- [ ] **Step 4: Реализовать тип и регистрацию**

В `apps/frontend/src/canvas/mermaid-import.ts` после блока `loadMermaid` (после строки 185) добавить:

```ts
/** Движок размещения, выбираемый в paste-окне (spec A). */
export type LayoutEngine = "dagre" | "elk" | "custom";

// ELK loader регистрируется на прямом инстансе пакета `mermaid` (НЕ через
// loadMermaid()=@tldraw/mermaid). createMermaidDiagram внутри импортирует тот
// же физический инстанс (bun дедуплицирует mermaid@11.12.2), поэтому
// registerLayoutLoaders на нём активирует layout:"elk" в createMermaidDiagram.
let elkLoaderRegistered = false;

/** ТОЛЬКО для тестов: сброс idempotency-флага между кейсами. */
export function __resetElkLoaderForTest(): void {
  elkLoaderRegistered = false;
}

/**
 * Идемпотентно регистрирует ELK layout-loader в mermaid. Возвращает true, если
 * ELK доступен (зарегистрирован сейчас или ранее), false — если регистрация
 * не удалась (тогда вызывающий фоллбэчит на dagre, не молча).
 */
export async function ensureElkLoader(): Promise<boolean> {
  if (elkLoaderRegistered) return true;
  try {
    const mermaid = (await import("mermaid")).default as {
      registerLayoutLoaders: (loaders: unknown) => void;
    };
    const elkLayouts = (await import("@mermaid-js/layout-elk")).default;
    mermaid.registerLayoutLoaders(elkLayouts);
    elkLoaderRegistered = true;
    return true;
  } catch (e) {
    console.warn(
      "[shemma] ELK layout loader registration failed; falling back to dagre",
      e,
    );
    return false;
  }
}
```

- [ ] **Step 5: Запустить тест — убедиться, что проходит**

Run: `bun test --cwd apps/frontend src/canvas/mermaid-import.test.ts`
Expected: PASS (оба новых кейса зелёные; существующие не сломаны).

- [ ] **Step 6: Commit**

```bash
cd /Users/tretyakov_dv/Projects/sandbox/di.draw
git add apps/frontend/package.json bun.lock apps/frontend/src/canvas/mermaid-import.ts apps/frontend/src/canvas/mermaid-import.test.ts
git commit -m "feat(frontend): ELK layout-loader registration + LayoutEngine type (rebuild A task 1)"
```

---

## Task 2: `importMermaidLegacy` принимает `layout:"elk"` и прокидывает в mermaidConfig

**Files:**
- Modify: `apps/frontend/src/canvas/mermaid-import.ts:293-306`
- Test: `apps/frontend/src/canvas/mermaid-import.test.ts`

- [ ] **Step 1: Падающий тест — опции прокидываются в createMermaidDiagram**

Добавить хелпер-мок, захватывающий 3-й аргумент, и тесты:

```ts
// Хелпер: мок createMermaidDiagram, запоминающий переданные options.
function mockMermaidCapture(): { calls: Array<{ source: string; options: unknown }> } {
  const calls: Array<{ source: string; options: unknown }> = [];
  mock.module("@tldraw/mermaid", () => ({
    createMermaidDiagram: async (
      editor: any,
      source: string,
      options?: unknown,
    ) => {
      calls.push({ source, options });
      // добавить минимальный root frame, чтобы importMermaidLegacy не бросил "no shapes"
      editor._addShapes([makeShape("f1", "frame", editor.getCurrentPageId(), "F")]);
    },
  }));
  return { calls };
}

describe("importMermaidLegacy — layout option passthrough", () => {
  test("dagre (no opts): createMermaidDiagram called WITHOUT mermaidConfig.layout", async () => {
    const cap = mockMermaidCapture();
    const editor = makeFakeEditor("page:page");
    const { importMermaidLegacy } = await import("./mermaid-import");
    await importMermaidLegacy(editor as never, "graph LR\nA-->B");
    expect(cap.calls).toHaveLength(1);
    const opts = cap.calls[0]!.options as { mermaidConfig?: { layout?: string } } | undefined;
    expect(opts?.mermaidConfig?.layout).toBeUndefined();
  });

  test("elk: createMermaidDiagram called WITH mermaidConfig.layout='elk'", async () => {
    const cap = mockMermaidCapture();
    const editor = makeFakeEditor("page:page");
    const { importMermaidLegacy } = await import("./mermaid-import");
    await importMermaidLegacy(editor as never, "graph LR\nA-->B", { layout: "elk" });
    expect(cap.calls).toHaveLength(1);
    const opts = cap.calls[0]!.options as { mermaidConfig?: { layout?: string } };
    expect(opts.mermaidConfig?.layout).toBe("elk");
  });
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `bun test --cwd apps/frontend src/canvas/mermaid-import.test.ts`
Expected: FAIL — `importMermaidLegacy` не принимает третий аргумент / не передаёт options.

- [ ] **Step 3: Реализовать проброс**

В `mermaid-import.ts` изменить сигнатуру (строка 293) и вызов (строка 306):

```ts
export async function importMermaidLegacy(
  editor: Editor,
  source: string,
  opts: { layout?: "elk" } = {},
): Promise<MermaidImportResult> {
  const mod = await loadMermaid();
  // biome-ignore lint/suspicious/noExplicitAny: createMermaidDiagram не в public d.ts'ках
  const mermaidMod = mod as any;

  const beforeIds = new Set<string>(
    editor.getCurrentPageShapes().map((s) => s.id as unknown as string),
  );

  // DRW-093: source passes through as-is. opts.layout (если задан) включает
  // mermaid-native ELK через mermaidConfig (loader уже должен быть зарегистрирован).
  const createOptions =
    opts.layout === "elk" ? { mermaidConfig: { layout: "elk" } } : undefined;
  await mermaidMod.createMermaidDiagram(editor, source, createOptions);
```

(остальное тело функции без изменений.)

- [ ] **Step 4: Запустить — убедиться, что проходит**

Run: `bun test --cwd apps/frontend src/canvas/mermaid-import.test.ts`
Expected: PASS (оба кейса; существующие importMermaidLegacy-тесты, которые мокают `(editor, _source)` без 3-го арга, продолжают работать — лишний параметр игнорируется их моком).

- [ ] **Step 5: Commit**

```bash
cd /Users/tretyakov_dv/Projects/sandbox/di.draw
git add apps/frontend/src/canvas/mermaid-import.ts apps/frontend/src/canvas/mermaid-import.test.ts
git commit -m "feat(frontend): importMermaidLegacy passes layout:elk to mermaidConfig (rebuild A task 2)"
```

---

## Task 3: Чистая `computeImportOriginX`

**Files:**
- Modify: `apps/frontend/src/canvas/mermaid-import.ts`
- Test: `apps/frontend/src/canvas/mermaid-import.test.ts`

- [ ] **Step 1: Падающий тест**

```ts
describe("computeImportOriginX", () => {
  const vp = { x: 1000, y: 0, w: 800, h: 600, minX: 1000 } as any;

  test("with page content: maxX + GAP", async () => {
    const { computeImportOriginX, IMPORT_GAP } = await import("./mermaid-import");
    const pageBounds = { x: 0, y: 0, w: 500, h: 300, maxX: 500 } as any;
    expect(computeImportOriginX(pageBounds, vp)).toBe(500 + IMPORT_GAP);
  });

  test("empty page (pageBounds undefined): viewport minX", async () => {
    const { computeImportOriginX } = await import("./mermaid-import");
    expect(computeImportOriginX(undefined, vp)).toBe(1000);
  });
});
```

- [ ] **Step 2: Запустить — падает**

Run: `bun test --cwd apps/frontend src/canvas/mermaid-import.test.ts`
Expected: FAIL — `computeImportOriginX`/`IMPORT_GAP` не экспортированы.

- [ ] **Step 3: Реализовать**

В `mermaid-import.ts` (рядом с `unionBoundsOf`, после строки 58) добавить:

```ts
/** Зазор между импортами на доске (spec A §4). */
export const IMPORT_GAP = 200;

/**
 * Левый край (page-X) для нового импорта: правее существующего контента,
 * либо в видимой области на пустой странице.
 * @param pageBounds editor.getCurrentPageBounds() — Box | undefined
 * @param viewportBounds editor.getViewportPageBounds() — Box
 */
export function computeImportOriginX(
  pageBounds: { maxX: number } | undefined,
  viewportBounds: { minX: number },
  gap: number = IMPORT_GAP,
): number {
  return pageBounds ? pageBounds.maxX + gap : viewportBounds.minX;
}
```

- [ ] **Step 4: Запустить — проходит**

Run: `bun test --cwd apps/frontend src/canvas/mermaid-import.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/tretyakov_dv/Projects/sandbox/di.draw
git add apps/frontend/src/canvas/mermaid-import.ts apps/frontend/src/canvas/mermaid-import.test.ts
git commit -m "feat(frontend): computeImportOriginX pure helper (rebuild A task 3)"
```

---

## Task 4: `repositionToOriginX` — сдвиг синхронного импорта (dagre/elk)

**Files:**
- Modify: `apps/frontend/src/canvas/mermaid-import.ts`
- Test: `apps/frontend/src/canvas/mermaid-import.test.ts`

- [ ] **Step 1: Падающий тест**

Расширить fake editor нужными методами и проверить сдвиг корней по dx. Добавить в тест:

```ts
describe("repositionToOriginX", () => {
  test("shifts root shapes so union minX == originX", async () => {
    const moved: Array<{ id: string; x: number }> = [];
    const bounds: Record<string, { x: number; y: number; w: number; h: number }> = {
      "shape:root": { x: 50, y: 0, w: 100, h: 80 },
      "shape:child": { x: 60, y: 10, w: 40, h: 20 },
    };
    const shapesById: Record<string, { id: string; type: string; x: number }> = {
      "shape:root": { id: "shape:root", type: "frame", x: 50 },
      "shape:child": { id: "shape:child", type: "geo", x: 10 },
    };
    const editor = {
      getShapePageBounds: (id: string) => bounds[id],
      getShape: (id: string) => shapesById[id],
      updateShapes: (ups: Array<{ id: string; x: number }>) => {
        for (const u of ups) moved.push({ id: u.id, x: u.x });
      },
    };
    const { repositionToOriginX } = await import("./mermaid-import");
    repositionToOriginX(
      editor as never,
      ["shape:root"] as never,
      ["shape:root", "shape:child"] as never,
      1000,
    );
    // union minX = 50, originX = 1000 → dx = 950 → root.x 50→1000
    expect(moved).toEqual([{ id: "shape:root", x: 1000 }]);
  });

  test("no-op when union bounds null (no shapes)", async () => {
    const editor = {
      getShapePageBounds: () => undefined,
      getShape: () => undefined,
      updateShapes: () => {
        throw new Error("should not be called");
      },
    };
    const { repositionToOriginX } = await import("./mermaid-import");
    expect(() =>
      repositionToOriginX(editor as never, [] as never, [] as never, 1000),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Запустить — падает**

Run: `bun test --cwd apps/frontend src/canvas/mermaid-import.test.ts`
Expected: FAIL — `repositionToOriginX` не экспортирован.

- [ ] **Step 3: Реализовать**

В `mermaid-import.ts` (после `computeImportOriginX`) добавить:

```ts
/**
 * Сдвигает корневые шейпы импорта так, чтобы левый край union-bbox всех новых
 * шейпов совпал с originX. Дети двигаются вместе с корнями. No-op, если bbox
 * пуст или сдвиг < 0.5px.
 */
export function repositionToOriginX(
  editor: Editor,
  rootIds: TLShapeId[],
  allNewIds: TLShapeId[],
  originX: number,
): void {
  const bbox = unionBoundsOf(editor, allNewIds);
  if (!bbox) return;
  const dx = originX - bbox.x;
  if (Math.abs(dx) < 0.5) return;
  const updates = rootIds
    .map((id) => {
      const s = editor.getShape(id);
      if (!s) return null;
      // biome-ignore lint/suspicious/noExplicitAny: tldraw shape.x not in public TLShape
      return { id, type: s.type, x: (s as any).x + dx };
    })
    .filter((u): u is { id: TLShapeId; type: string; x: number } => u !== null);
  if (updates.length > 0) editor.updateShapes(updates);
}
```

- [ ] **Step 4: Запустить — проходит**

Run: `bun test --cwd apps/frontend src/canvas/mermaid-import.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/tretyakov_dv/Projects/sandbox/di.draw
git add apps/frontend/src/canvas/mermaid-import.ts apps/frontend/src/canvas/mermaid-import.test.ts
git commit -m "feat(frontend): repositionToOriginX for sync mermaid imports (rebuild A task 4)"
```

---

## Task 5: `repositionCustomFrameWhenReady` — best-effort сдвиг Custom-frame после WS

**Files:**
- Modify: `apps/frontend/src/canvas/mermaid-import.ts`
- Test: `apps/frontend/src/canvas/mermaid-import.test.ts`

- [ ] **Step 1: Падающий тест**

Polling-хелпер с инъекцией интервала/таймаута для детерминизма:

```ts
describe("repositionCustomFrameWhenReady", () => {
  test("moves frame once it appears in store", async () => {
    let polls = 0;
    const moved: Array<{ id: string; x: number }> = [];
    const editor = {
      getShape: (_id: string) => {
        polls++;
        return polls >= 2 ? { id: "shape:f", type: "frame", x: 30 } : undefined;
      },
      getShapePageBounds: (_id: string) => ({ x: 30, y: 0, w: 100, h: 50 }),
      updateShape: (u: { id: string; x: number }) => moved.push(u),
    };
    const { repositionCustomFrameWhenReady } = await import("./mermaid-import");
    await repositionCustomFrameWhenReady(editor as never, "shape:f", 500, {
      intervalMs: 1,
      timeoutMs: 100,
    });
    // bounds.x=30, originX=500 → dx=470 → frame.x 30→500
    expect(moved).toEqual([{ id: "shape:f", x: 500 }]);
  });

  test("gives up after timeout without throwing when frame never appears", async () => {
    const editor = {
      getShape: () => undefined,
      getShapePageBounds: () => undefined,
      updateShape: () => {
        throw new Error("should not move");
      },
    };
    const { repositionCustomFrameWhenReady } = await import("./mermaid-import");
    await expect(
      repositionCustomFrameWhenReady(editor as never, "shape:f", 500, {
        intervalMs: 1,
        timeoutMs: 10,
      }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Запустить — падает**

Run: `bun test --cwd apps/frontend src/canvas/mermaid-import.test.ts`
Expected: FAIL — функция не экспортирована.

- [ ] **Step 3: Реализовать**

В `mermaid-import.ts` добавить:

```ts
/**
 * Best-effort: дождаться появления frame (создаётся backend'ом, приходит через
 * WS асинхронно) и сдвинуть его левый край к originX. Если за timeoutMs frame
 * не появился — тихо выходит (логирует). Throwaway-сравнение: pin/echo-семантику
 * не трогаем; backend-ownership может перетереть позицию (известное ограничение).
 */
export async function repositionCustomFrameWhenReady(
  editor: Editor,
  frameId: string | undefined,
  originX: number,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  if (!frameId) return;
  const intervalMs = opts.intervalMs ?? 50;
  const timeoutMs = opts.timeoutMs ?? 2000;
  const deadline = Date.now() + timeoutMs;
  const id = frameId as unknown as TLShapeId;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const shape = editor.getShape(id);
    if (shape) {
      const b = editor.getShapePageBounds(id);
      if (b) {
        const dx = originX - b.x;
        if (Math.abs(dx) >= 0.5) {
          // biome-ignore lint/suspicious/noExplicitAny: tldraw shape.x not in public TLShape
          editor.updateShape({ id, type: shape.type, x: (shape as any).x + dx });
        }
      }
      return;
    }
    if (Date.now() >= deadline) {
      console.warn(
        "[shemma] custom-import frame did not settle in time; skip reposition",
        frameId,
      );
      return;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
```

- [ ] **Step 4: Запустить — проходит**

Run: `bun test --cwd apps/frontend src/canvas/mermaid-import.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/tretyakov_dv/Projects/sandbox/di.draw
git add apps/frontend/src/canvas/mermaid-import.ts apps/frontend/src/canvas/mermaid-import.test.ts
git commit -m "feat(frontend): best-effort reposition for custom WS frame (rebuild A task 5)"
```

---

## Task 6: Диспетчер `importMermaidWithEngine` + поля результата

**Files:**
- Modify: `apps/frontend/src/canvas/mermaid-import.ts:226-235` (тип), + новая функция
- Test: `apps/frontend/src/canvas/mermaid-import.test.ts`

- [ ] **Step 1: Падающий тест — маршрутизация по движку**

```ts
describe("importMermaidWithEngine — routing", () => {
  function fakeEditorWithBounds(pageId: string) {
    const e = makeFakeEditor(pageId) as any;
    e.getCurrentPageBounds = () => undefined; // пустая страница
    e.getViewportPageBounds = () => ({ x: 0, y: 0, w: 800, h: 600, minX: 0 });
    e.getShapePageBounds = (_id: string) => ({ x: 0, y: 0, w: 100, h: 50 });
    return e;
  }

  test("dagre → createMermaidDiagram called, engineUsed='dagre'", async () => {
    const cap = mockMermaidCapture();
    const editor = fakeEditorWithBounds("page:page");
    const { importMermaidWithEngine } = await import("./mermaid-import");
    const res = await importMermaidWithEngine(editor as never, "graph LR\nA-->B", "dagre");
    expect(cap.calls).toHaveLength(1);
    expect(cap.calls[0]!.options).toBeUndefined();
    expect(res.engineUsed).toBe("dagre");
    expect(res.engineFallback).toBeFalsy();
  });

  test("elk (loader ok) → layout:elk passed, engineUsed='elk'", async () => {
    const cap = mockMermaidCapture();
    mock.module("mermaid", () => ({ default: { registerLayoutLoaders: () => {} } }));
    mock.module("@mermaid-js/layout-elk", () => ({ default: [] }));
    const { importMermaidWithEngine, __resetElkLoaderForTest } = await import("./mermaid-import");
    __resetElkLoaderForTest();
    const editor = fakeEditorWithBounds("page:page");
    const res = await importMermaidWithEngine(editor as never, "graph LR\nA-->B", "elk");
    expect((cap.calls[0]!.options as any).mermaidConfig.layout).toBe("elk");
    expect(res.engineUsed).toBe("elk");
    expect(res.engineFallback).toBe(false);
  });

  test("elk (loader fails) → falls back to dagre, engineFallback=true", async () => {
    const cap = mockMermaidCapture();
    mock.module("mermaid", () => ({
      default: { registerLayoutLoaders: () => { throw new Error("bad"); } },
    }));
    mock.module("@mermaid-js/layout-elk", () => ({ default: [] }));
    const { importMermaidWithEngine, __resetElkLoaderForTest } = await import("./mermaid-import");
    __resetElkLoaderForTest();
    const editor = fakeEditorWithBounds("page:page");
    const res = await importMermaidWithEngine(editor as never, "graph LR\nA-->B", "elk");
    expect(cap.calls[0]!.options).toBeUndefined(); // dagre, no layout
    expect(res.engineUsed).toBe("dagre");
    expect(res.engineFallback).toBe(true);
  });

  test("custom → backend path, createMermaidDiagram NOT called", async () => {
    const cap = mockMermaidCapture();
    const fetchMock = mock(async () =>
      new Response(JSON.stringify({ ok: true, frameId: "shape:f", nodeIds: [], version: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    (globalThis as any).fetch = fetchMock;
    const editor = fakeEditorWithBounds("page:page");
    const { importMermaidWithEngine } = await import("./mermaid-import");
    const res = await importMermaidWithEngine(editor as never, "graph LR\nA-->B", "custom", {
      space: "s", room: "r",
    });
    expect(cap.calls).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalled();
    expect(res.engineUsed).toBe("custom");
    expect(res.frameId).toBe("shape:f");
  });
});
```

- [ ] **Step 2: Запустить — падает**

Run: `bun test --cwd apps/frontend src/canvas/mermaid-import.test.ts`
Expected: FAIL — `importMermaidWithEngine` не экспортирован; поля `engineUsed`/`engineFallback` отсутствуют в типе.

- [ ] **Step 3: Расширить тип результата**

В `mermaid-import.ts` (тип `MermaidImportResult`, строки 226-235) добавить два поля:

```ts
export type MermaidImportResult = {
  ok: true;
  /** v2 path: backend-assigned frameId. v1 path: first root frame id or empty. */
  frameId?: string;
  /** v2 path: backend-assigned nodeIds. v1 path: empty. */
  nodeIds?: NodeId[];
  shapeIds: TLShapeId[];
  /** Subset of shapeIds где сохранён meta.mermaidSource (root frame'ы импорта). */
  sourceTargetIds: TLShapeId[];
  /** Spec A: какой движок реально применён. */
  engineUsed?: LayoutEngine;
  /** Spec A: true, если ELK запрошен, но loader не активен → применён dagre. */
  engineFallback?: boolean;
};
```

- [ ] **Step 4: Реализовать диспетчер**

В `mermaid-import.ts` (после `importMermaidLegacy`) добавить:

```ts
/**
 * Spec A: единая точка импорта mermaid с выбором движка размещения.
 * - dagre/elk → throwaway mermaid-native (createMermaidDiagram), sync-сдвиг.
 * - custom    → backend v2 (как раньше), best-effort сдвиг после WS-settle.
 * Origin вычисляется ДО импорта (правее существующего контента).
 */
export async function importMermaidWithEngine(
  editor: Editor,
  source: string,
  engine: LayoutEngine,
  opts: { label?: string; space?: string; room?: string } = {},
): Promise<MermaidImportResult> {
  // biome-ignore lint/suspicious/noExplicitAny: getCurrentPageBounds/getViewportPageBounds not on minimal Editor type alias here
  const ed = editor as any;
  const originX = computeImportOriginX(
    ed.getCurrentPageBounds(),
    ed.getViewportPageBounds(),
  );

  if (engine === "custom") {
    const res = await importMermaid(editor, source, opts);
    void repositionCustomFrameWhenReady(editor, res.frameId, originX);
    return { ...res, engineUsed: "custom" };
  }

  let engineUsed: LayoutEngine = engine;
  let engineFallback = false;
  if (engine === "elk") {
    const ok = await ensureElkLoader();
    if (!ok) {
      engineUsed = "dagre";
      engineFallback = true;
    }
  }
  const res = await importMermaidLegacy(
    editor,
    source,
    engineUsed === "elk" ? { layout: "elk" } : {},
  );
  repositionToOriginX(editor, res.sourceTargetIds, res.shapeIds, originX);
  return { ...res, engineUsed, engineFallback };
}
```

- [ ] **Step 5: Запустить — проходит**

Run: `bun test --cwd apps/frontend src/canvas/mermaid-import.test.ts`
Expected: PASS (все 4 кейса + предыдущие задачи зелёные).

- [ ] **Step 6: Commit**

```bash
cd /Users/tretyakov_dv/Projects/sandbox/di.draw
git add apps/frontend/src/canvas/mermaid-import.ts apps/frontend/src/canvas/mermaid-import.test.ts
git commit -m "feat(frontend): importMermaidWithEngine dispatcher + engineUsed/fallback (rebuild A task 6)"
```

---

## Task 7: Селектор движка в `MermaidImportModal`

**Files:**
- Modify: `apps/frontend/src/mermaid/MermaidImportModal.tsx`
- Test (new): `apps/frontend/src/mermaid/MermaidImportModal.test.ts`

> **Конвенция тестов фронта:** DOM-инфры нет (`@testing-library/react`/jsdom отсутствуют). Тестируем экспортированную чистую константу опций (как `panels.test.ts` тестирует extracted-логику). Поведение «выбор → onSubmit(engine)» — тривиальное hook-wiring, проверяется типчеком (Task 8) + live (Task 9) + routing-тестами диспетчера (Task 6).

- [ ] **Step 1: Падающий тест (чистая константа опций)**

Создать `apps/frontend/src/mermaid/MermaidImportModal.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MERMAID_ENGINE,
  MERMAID_ENGINE_OPTIONS,
} from "./MermaidImportModal";

describe("MermaidImportModal — engine options", () => {
  test("exposes exactly dagre, elk, custom", () => {
    const values = MERMAID_ENGINE_OPTIONS.map((o) => o.value).sort();
    expect(values).toEqual(["custom", "dagre", "elk"]);
  });

  test("default engine is custom (existing flow unchanged)", () => {
    expect(DEFAULT_MERMAID_ENGINE).toBe("custom");
  });

  test("every option has a non-empty label", () => {
    for (const o of MERMAID_ENGINE_OPTIONS) {
      expect(o.label.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Запустить — падает**

Run: `bun test --cwd apps/frontend src/mermaid/MermaidImportModal.test.ts`
Expected: FAIL — `MERMAID_ENGINE_OPTIONS`/`DEFAULT_MERMAID_ENGINE` не экспортированы.

- [ ] **Step 3: Реализовать селектор**

В `MermaidImportModal.tsx`:

(а) импорт типа движка (DRY — не дублируем union) вверху файла:
```tsx
import type { LayoutEngine } from "../canvas/mermaid-import";
```

(б) экспортируемые опции + дефолт (до компонента):
```tsx
export const DEFAULT_MERMAID_ENGINE: LayoutEngine = "custom";
export const MERMAID_ENGINE_OPTIONS: { value: LayoutEngine; label: string }[] = [
  { value: "custom", label: "Custom (наш backend)" },
  { value: "dagre", label: "Dagre (mermaid-native)" },
  { value: "elk", label: "ELK (mermaid-native)" },
];
```

(в) расширить тип пропа onSubmit (строка 25):
```tsx
  onSubmit: (
    source: string,
    engine: LayoutEngine,
  ) => Promise<{ ok: boolean; error?: string }>;
```

(г) добавить engine-state (рядом со строкой 27); **не сбрасывать** при закрытии (last-used per session):
```tsx
  const [engine, setEngine] = useState<LayoutEngine>(DEFAULT_MERMAID_ENGINE);
```
В `useEffect` сброса (строки 39-43) НЕ трогаем `engine` — оставляем `setText/setError/setLoading`.

(д) в `submit()` (строка 63) передать engine:
```tsx
      const res = await onSubmit(source, engine);
```

(е) добавить `<select>` над textarea (после строки 115 `<div>Import Mermaid</div>`), рендеря опции из константы:
```tsx
        <label
          style={{ display: "flex", alignItems: "center", gap: 8, fontSize: tokens.font.sm }}
        >
          Layout engine
          <select
            aria-label="Layout engine"
            value={engine}
            disabled={loading}
            onChange={(e) => setEngine(e.target.value as LayoutEngine)}
            style={{
              padding: "4px 8px",
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.sm,
              fontFamily: tokens.font.sans,
              fontSize: tokens.font.sm,
            }}
          >
            {MERMAID_ENGINE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
```

- [ ] **Step 4: Запустить — проходит**

Run: `bun test --cwd apps/frontend src/mermaid/MermaidImportModal.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/tretyakov_dv/Projects/sandbox/di.draw
git add apps/frontend/src/mermaid/MermaidImportModal.tsx apps/frontend/src/mermaid/MermaidImportModal.test.ts
git commit -m "feat(frontend): engine selector in MermaidImportModal (rebuild A task 7)"
```

---

## Task 8: Подключить диспетчер в `App.tsx` (paste-modal call-site)

**Files:**
- Modify: `apps/frontend/src/App.tsx:16` (import), `:684-695` (modal usage)

- [ ] **Step 1: Обновить import**

В `App.tsx` строка 16 — добавить `importMermaidWithEngine` к импорту:
```tsx
import {
  importMermaid,
  importMermaidWithEngine,
  isBoundsContained,
  unionBoundsOf,
} from "./canvas/mermaid-import";
```
(`importMermaid` оставляем — он ещё используется на :389 и :592.)

- [ ] **Step 2: Обновить onSubmit модалки**

В `App.tsx` (строки 687-694) заменить:
```tsx
              onSubmit={async (source, engine) => {
                try {
                  await importMermaidWithEngine(editor, source, engine);
                  return { ok: true };
                } catch (e) {
                  return { ok: false, error: String(e) };
                }
              }}
```
**Call-sites `importMermaid` на :389 (AI/backend WS import) и :592 (dev-helper) НЕ трогаем.**

- [ ] **Step 3: Тайпчек + весь фронт-сьют**

Run:
```bash
cd /Users/tretyakov_dv/Projects/sandbox/di.draw
bunx tsc -p apps/frontend/tsconfig.json --noEmit
bun test --cwd apps/frontend src
```
Expected: tsc — без ошибок (новая сигнатура onSubmit совместима); все frontend-тесты зелёные.

- [ ] **Step 4: Biome lint затронутых файлов**

Run:
```bash
cd /Users/tretyakov_dv/Projects/sandbox/di.draw
bunx biome check apps/frontend/src/canvas/mermaid-import.ts apps/frontend/src/mermaid/MermaidImportModal.tsx apps/frontend/src/App.tsx
```
Expected: без новых ошибок (pre-existing — игнор, см. DRW-102).

- [ ] **Step 5: Commit**

```bash
cd /Users/tretyakov_dv/Projects/sandbox/di.draw
git add apps/frontend/src/App.tsx
git commit -m "feat(frontend): wire engine selector into paste-modal import (rebuild A task 8)"
```

---

## Task 9: Live-проверка на доске + решение по движку (research-выход)

**Files:**
- Create: `docs/references/2026-05-29-engine-comparison-findings.md`

> Эта задача — ручная live-проверка контроллером (main agent с chrome-devtools MCP), не subagent'ом (memory `feedback-no-subagent-screenshot-trust`). Реализатор-subagent останавливается после Task 8 и сообщает, что готово к live-прогону.

- [ ] **Step 1: Поднять dev и открыть комнату**

Run (контроллер):
```bash
cd /Users/tretyakov_dv/Projects/sandbox/di.draw
bun --cwd apps/frontend run dev   # script "dev"=vite, :5173; backend daemon должен быть поднят (release :8787 уже работает, либо dev :8788)
```
Открыть через chrome-devtools MCP пустую тестовую комнату (живой WS-subscriber).

- [ ] **Step 2: Импортировать sample-2 каждым движком**

Источник: `apps/backend/tests/fixtures/sample-2-mermaid.md`. В paste-модале импортировать один и тот же код трижды: `Dagre`, затем `ELK`, затем `Custom`. Ожидание: три результата лягут полосами слева-направо без наложения.

- [ ] **Step 3: Снять PNG и сравнить с эталонами**

Для каждого результата — выделить + `editor.toImage`/скриншот chrome-MCP. Сравнить с `~/Projects/draft-n-old/mermaid-mr-345/dagre-lr.png` и `elk-lr.png`. Зафиксировать визуальный счёт пересечений на каждом.

- [ ] **Step 4: Записать выводы + решение**

В `docs/references/2026-05-29-engine-comparison-findings.md`: таблица «движок → пересечения на sample-2 → читаемость → компактность», скриншоты-ссылки, и решение «основа B = <движок>». Проверить, что ELK реально отработал (раскладка ≠ dagre); если `engineFallback` сработал — отметить.

- [ ] **Step 5: Закрыть DRW-151 + обновить memory**

```bash
# через backlog MCP: task_edit DRW-151 --finalSummary "...", task_archive (после приёмки user)
```
Обновить memory `next-session-autolayout-rebuild`: решение по движку для B.

- [ ] **Step 6: Commit findings**

```bash
cd /Users/tretyakov_dv/Projects/sandbox/di.draw
git add docs/references/2026-05-29-engine-comparison-findings.md
git commit -m "docs(refs): engine comparison findings + B engine decision (rebuild A task 9)"
```

---

## Self-Review

**1. Spec coverage:**
- §1 селектор + транзиентный last-used → Task 7. ✓
- §2 три движка (dagre/elk/custom) → Tasks 2,6. ✓
- §3 data flow + ELK loader разводка модулей → Tasks 1,6. ✓
- §4 offset (computeImportOriginX + reposition sync/custom) → Tasks 3,4,5,6. ✓
- §5 PNG-экспорт (editor.toImage) → Task 9 (используется контроллером; UI-кнопка вне scope). ✓
- §6 файлы → все затронуты. ✓
- §7 тесты (dagre/elk/custom routing, fallback, MermaidDiagramError, idempotency, origin) → Tasks 1-7. ✓
- §8 приёмка + решающая метрика + DRW-151 → Task 9. ✓
- §9 риски (ELK loader, custom reposition, dep version) → отражены в Tasks 1,5. ✓

**Примечание по §7 spec (MermaidDiagramError test):** кейс «createMermaidDiagram бросает» покрывается тем, что диспетчер не ловит исключение → пробрасывает наверх, App.tsx onSubmit ловит и показывает error. Явный unit можно добавить в Task 6 при желании; поведение детерминировано существующим try/catch в модалке.

**2. Placeholder scan:** код приведён полностью в каждом шаге; «TBD» только в Task 1 Step 1 про точную версию dep — это осознанный verification-step (peer-compat), не placeholder реализации. ✓

**3. Type consistency:** `LayoutEngine = "dagre"|"elk"|"custom"` единообразно (Tasks 1,6,7); `MermaidImportResult.engineUsed/engineFallback` объявлены в Task 6 до использования; `computeImportOriginX`/`repositionToOriginX`/`repositionCustomFrameWhenReady`/`ensureElkLoader`/`importMermaidWithEngine` — имена согласованы между задачами и тестами. ✓

**Подтверждённое окружение фронта:** scripts `dev`=vite, `test`=`bun test src`, `typecheck`=`tsc --noEmit -p .` (apps/frontend/package.json). DOM-тест-инфры нет — Task 7 тестирует чистую константу (соответствует `panels.test.ts`).

**Известное допущение для реализатора:**
- Точная версия `@mermaid-js/layout-elk` уточняется по peer-compat с mermaid 11.12.2 (Task 1 Step 1); зафиксировать в spec §9 после install.
