import { generateNodeId, slugify } from "@shemma/domain";
import type { NodeId, SchemaCreateResponse } from "@shemma/domain";
import { LEGACY_SPACE_ID } from "../transport/api";
import {
  type Editor,
  type TLShape,
  type TLShapeId,
  renderPlaintextFromRichText,
} from "tldraw";

// DRW-086: BoxLike type for union bounds result. We use a plain object to avoid
// importing `Box` class (tldraw re-exports it but we want to stay test-friendly).
export type BoundsLike = { x: number; y: number; w: number; h: number };

/**
 * DRW-096: true if `inner` is fully contained within `outer` (all 4 corners
 * inside, slack=0). Используется чтобы skip auto-zoom после Tidy, когда
 * affected shapes уже видны в текущем viewport.
 */
export function isBoundsContained(
  inner: BoundsLike,
  outer: BoundsLike,
): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

/**
 * DRW-086: Compute the union bounding box of the given shape ids.
 * Iterates `editor.getShapePageBounds(id)` and unions all results.
 * Returns null if shapeIds is empty or no shape has bounds.
 */
export function unionBoundsOf(
  editor: Editor,
  shapeIds: TLShapeId[],
): BoundsLike | null {
  if (shapeIds.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let found = false;
  for (const id of shapeIds) {
    const b = editor.getShapePageBounds(id);
    if (!b) continue;
    found = true;
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.w > maxX) maxX = b.x + b.w;
    if (b.y + b.h > maxY) maxY = b.y + b.h;
  }
  if (!found) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

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
  // biome-ignore lint/suspicious/noExplicitAny: tldraw updateShapes partial typing verbose; safe by id+type
  const updates: any[] = [];
  for (const id of rootIds) {
    const s = editor.getShape(id);
    if (!s) continue;
    // biome-ignore lint/suspicious/noExplicitAny: tldraw shape.x not in public TLShape
    updates.push({ id, type: s.type, x: (s as any).x + dx });
  }
  if (updates.length > 0) editor.updateShapes(updates);
}

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
  while (Date.now() < deadline) {
    try {
      const shape = editor.getShape(id);
      if (shape) {
        const b = editor.getShapePageBounds(id);
        if (b) {
          const dx = originX - b.x;
          if (Math.abs(dx) >= 0.5) {
            editor.updateShape({
              id,
              type: shape.type,
              // biome-ignore lint/suspicious/noExplicitAny: tldraw shape.x not in public TLShape
              x: (shape as any).x + dx,
            });
          }
        }
        return;
      }
    } catch (e) {
      // Editor torn down / room switched mid-poll (best-effort, throwaway): bail
      // quietly. AbortSignal-cancellation не плетём — 2s-poll безвреден для A.
      console.warn("[shemma] custom-import reposition aborted", e);
      return;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  console.warn(
    "[shemma] custom-import frame did not settle in time; skip reposition",
    frameId,
  );
}

// ---------------------------------------------------------------------------
// DRW-134 Task 2.6: v2 protocol — POST /api/schema/create path
// ---------------------------------------------------------------------------

// slugify re-exported from @shemma/domain (replaces local copy).
export { slugify };

/**
 * DRW-141: derive a human-readable label for the schema-frame from a Mermaid
 * source string.
 *
 * Aligns with `extractMermaidLabel` in `packages/shemma-mcp/src/tools/domain.ts`
 * so that browser-mode and storage-mode imports produce equivalent frame names.
 *
 * Resolution order:
 *   1) `%% Comment label`              — explicit metadata wins.
 *   2) `graph LR "Title"` / `flowchart TB "Title"` — quoted diagram title.
 *   3) `subgraph <id> [Label]`         — first subgraph display label.
 *   4) `<id>[Label]` / `<id>(Label)`   — first node display label.
 *   5) `"Imported schema"`             — final fallback.
 *
 * Pre-DRW-141 behaviour leaked the raw mermaid identifier line (e.g.
 * `"x[Browser X]"`) into `frame.props.name`. The first-node-label step
 * keeps that case useful while ensuring the bracketed identifier is parsed
 * rather than written back verbatim.
 */
export function inferMermaidLabel(source: string): string {
  const lines = source.split("\n");
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;

    if (trimmed.startsWith("%%")) {
      const label = trimmed.slice(2).trim();
      if (label.length > 0) return label;
      continue;
    }

    const titleMatch = trimmed.match(/^(?:graph|flowchart)\s+\S+\s+"(.+)"/i);
    if (titleMatch?.[1]) return titleMatch[1];

    const subgraphMatch = trimmed.match(/^subgraph\s+\S+\s*\[([^\]]+)\]/i);
    if (subgraphMatch?.[1]) return subgraphMatch[1].trim();

    // Skip graph/flowchart header lines that didn't quote-match above; they
    // never carry a label themselves.
    if (/^(?:graph|flowchart)\b/i.test(trimmed)) continue;

    // First node with display label: `id[Label]`, `id(Label)`, `id{Label}`,
    // also stadium `id([Label])` / `id[[Label]]`. We accept any opening
    // bracket variant and take everything up to the matching close.
    const nodeMatch = trimmed.match(
      /^[A-Za-z0-9_-]+\s*[\[\(\{]+\s*"?([^\]\)\}"]+?)"?\s*[\]\)\}]+/,
    );
    if (nodeMatch?.[1]) {
      const label = nodeMatch[1].trim();
      if (label.length > 0) return label;
    }
  }
  return "Imported schema";
}

/**
 * DRW-134 Task 2.6: HTTP request к backend `POST /api/schema/create`.
 * Auto-upgrade flow: backend создаёт frame + child shapes в v2 room;
 * реальные tldraw records приходят через WS broadcast.
 *
 * Принимает `space` и `room` из текущего window.location (или overrides
 * через `opts`). Frontend не пишет shapes напрямую в store.
 *
 * @returns response body из backend (`{ok, frameId, nodeIds, version}`)
 * @throws Error если backend вернул non-2xx или `{ok:false}`
 */
export async function createSchemaViaBackend(opts: {
  label: string;
  raw: string;
  space?: string;
  room?: string;
  positionsOverride?: Record<string, { x: number; y: number; w?: number; h?: number }>;
}): Promise<SchemaCreateResponse> {
  const space =
    opts.space ??
    (typeof location !== "undefined"
      ? (new URLSearchParams(location.search).get("space") ?? LEGACY_SPACE_ID)
      : LEGACY_SPACE_ID);
  const room =
    opts.room ??
    (typeof location !== "undefined"
      ? (new URLSearchParams(location.search).get("room") ?? "default")
      : "default");

  const qs = new URLSearchParams({ space, room }).toString();
  const r = await fetch(`/api/schema/create?${qs}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: opts.label, raw: opts.raw, positionsOverride: opts.positionsOverride }),
  });

  if (!r.ok) {
    let msg = `POST /api/schema/create failed: ${r.status}`;
    try {
      const body = (await r.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      // ignore parse failure
    }
    throw new Error(msg);
  }

  const body = (await r.json()) as SchemaCreateResponse;
  if (!body.ok) {
    throw new Error(
      `schema/create error: ${JSON.stringify((body as { errors?: unknown }).errors)}`,
    );
  }
  return body;
}

// ---------------------------------------------------------------------------
// Legacy path helpers (v1 fallback — used when backend endpoint is unavailable)
// ---------------------------------------------------------------------------

// Lazy-load @tldraw/mermaid — pulls in mermaid + heavy deps; only paid когда
// пользователь реально импортирует.
async function loadMermaid() {
  return await import("@tldraw/mermaid");
}

/** tldraw 5.0.0 mapper input wrapper (MermaidNodeRenderMapper): geometry on .node, id on .nodeId.
 *  Verified empirically against @tldraw/mermaid@5.0.0 on a live board. */
type MermaidMapperInput = {
  nodeId: string;
  node: { id: string; x: number; y: number; w: number; h: number; kind?: string; parentId?: string };
};

/** Records a blueprint node's flat layout coords into `out`, keyed by mermaid id.
 *  Returns undefined so createMermaidDiagram keeps its default render. */
export function harvestRecordFromBlueprintNode(
  out: Record<string, { x: number; y: number; w: number; h: number }>,
  input: MermaidMapperInput,
): undefined {
  const n = input.node;
  out[input.nodeId] = { x: n.x, y: n.y, w: n.w, h: n.h };
  return undefined;
}

/** Deep-equal сравнение двух position-карт (ключи + точные x/y/w/h).
 *  Тёплые mermaid-рендеры детерминированы → побайтовое равенство валидно. */
export function samePositions(
  a: Record<string, { x: number; y: number; w: number; h: number }>,
  b: Record<string, { x: number; y: number; w: number; h: number }>,
): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    const va = a[k];
    const vb = b[k];
    if (!va || !vb) return false;
    if (va.x !== vb.x || va.y !== vb.y || va.w !== vb.w || va.h !== vb.h) return false;
  }
  return true;
}

/** Прогрет ли mermaid-layout в текущем page-load (elk-worker + шрифты).
 *  Сбрасывается при перезагрузке страницы (re-init модуля). */
let mermaidLayoutWarmed = false;

/** Один offscreen-проход: рендер на throwaway-странице + harvest + cleanup. */
async function harvestMermaidPositionsOnce(
  editor: Editor,
  source: string,
  opts: { layout?: "elk" },
): Promise<{
  positions: Record<string, { x: number; y: number; w: number; h: number }>;
  meta: Record<string, { kind?: string; parentId?: string }>;
}> {
  const mod = await loadMermaid();
  // biome-ignore lint/suspicious/noExplicitAny: createMermaidDiagram/blueprintRender не в public d.ts
  const mermaidMod = mod as any;

  const positions: Record<string, { x: number; y: number; w: number; h: number }> = {};
  // kind + parentId per mermaid id для nested-guard (R8) — НЕ уходит в backend.
  const meta: Record<string, { kind?: string; parentId?: string }> = {};
  const createOptions: Record<string, unknown> = {
    blueprintRender: {
      mapNodeToRenderSpec: (input: MermaidMapperInput) => {
        meta[input.nodeId] = { kind: input.node.kind, parentId: input.node.parentId };
        return harvestRecordFromBlueprintNode(positions, input);
      },
    },
  };
  if (opts.layout === "elk") createOptions.mermaidConfig = { layout: "elk" };

  const prevPageId = editor.getCurrentPageId();
  // biome-ignore lint/suspicious/noExplicitAny: getPages not on public Editor type alias
  const before = new Set((editor as any).getPages().map((p: { id: string }) => p.id));
  // biome-ignore lint/suspicious/noExplicitAny: createPage/run not on public Editor type alias
  (editor as any).run(() => { (editor as any).createPage({ name: "__mermaid_harvest__" }); }, { history: "ignore" });
  // biome-ignore lint/suspicious/noExplicitAny: getPages not on public Editor type alias
  const scratch = (editor as any).getPages().map((p: { id: string }) => p.id).find((pid: string) => !before.has(pid));
  if (!scratch) throw new Error("harvestMermaidPositions: failed to create scratch page");
  // biome-ignore lint/suspicious/noExplicitAny: setCurrentPage/run not on public Editor type alias
  (editor as any).run(() => { (editor as any).setCurrentPage(scratch); }, { history: "ignore" });

  try {
    await mermaidMod.createMermaidDiagram(editor, source, createOptions);
  } finally {
    // biome-ignore lint/suspicious/noExplicitAny: setCurrentPage/deletePage/run not on public Editor type alias
    (editor as any).run(() => {
      (editor as any).setCurrentPage(prevPageId);
      (editor as any).deletePage(scratch);
    }, { history: "ignore" });
  }

  return { positions, meta };
}

/** Snapshot mermaid dagre/elk layout positions keyed by mermaid id, WITHOUT
 *  leaving any shapes on the user's page. Runs createMermaidDiagram on a
 *  throwaway page (id discovered by diffing getPages()), harvests via the public
 *  blueprintRender hook, then deletes the throwaway page entirely.
 *  Throws on nested subgraphs (Stage-1 is single-level).
 *
 *  Stability loop: на первом page-load elk-worker и шрифты ещё не прогреты →
 *  первый рендер даёт вырожденную раскладку. Ждём fonts.ready, затем повторяем
 *  до совпадения двух подряд harvest'ов (warm mermaid output детерминирован).
 *  Флаг mermaidLayoutWarmed мемоизирован на время жизни модуля. */
export async function harvestMermaidPositions(
  editor: Editor,
  source: string,
  opts: { layout?: "elk" } = {},
): Promise<Record<string, { x: number; y: number; w: number; h: number }>> {
  // Fonts must be loaded before mermaid measures text, and elk's async worker
  // must initialize — both race on the FIRST render in a fresh page and yield a
  // degenerate layout. Await fonts, then render until two consecutive harvests
  // agree (warm mermaid output is deterministic). Memoized per page-load.
  if (typeof document !== "undefined" && (document as { fonts?: { ready?: Promise<unknown> } }).fonts?.ready) {
    try {
      await (document as unknown as { fonts: { ready: Promise<unknown> } }).fonts.ready;
    } catch {
      // font readiness is best-effort
    }
  }

  let result = await harvestMermaidPositionsOnce(editor, source, opts);
  if (!mermaidLayoutWarmed) {
    let prev = result;
    for (let attempt = 0; attempt < 4; attempt++) {
      const next = await harvestMermaidPositionsOnce(editor, source, opts);
      result = next;
      if (samePositions(prev.positions, next.positions)) {
        mermaidLayoutWarmed = true;
        break;
      }
      prev = next;
    }
  }

  // Nested-subgraph guard (R8): subgraph чей parentId — другой subgraph → не поддержано в Stage-1.
  const meta = result.meta;
  const subgraphIds = new Set(Object.keys(meta).filter((id) => meta[id]?.kind === "subgraph"));
  for (const id of subgraphIds) {
    const p = meta[id]?.parentId;
    if (p && subgraphIds.has(p)) {
      throw new Error(`nested subgraphs not supported in Stage-1 import (${id} inside ${p})`);
    }
  }
  return result.positions;
}

/** Движок размещения, выбираемый в paste-окне (spec A). */
export type LayoutEngine = "dagre" | "elk" | "custom";

// ELK loader регистрируется на прямом инстансе пакета `mermaid` (НЕ через
// loadMermaid()=@tldraw/mermaid). createMermaidDiagram внутри импортирует тот
// же физический инстанс (bun дедуплицирует mermaid@11.12.2), поэтому
// registerLayoutLoaders на нём активирует layout:"elk" в createMermaidDiagram.
let elkLoaderRegistered = false;
let elkLoaderFailed = false;

/** ТОЛЬКО для тестов: сброс idempotency-флагов между кейсами. */
export function __resetElkLoaderForTest(): void {
  elkLoaderRegistered = false;
  elkLoaderFailed = false;
  mermaidLayoutWarmed = false;
}

/**
 * Идемпотентно регистрирует ELK layout-loader в mermaid. Возвращает true, если
 * ELK доступен (зарегистрирован сейчас или ранее), false — если регистрация
 * не удалась (тогда вызывающий фоллбэчит на dagre, не молча).
 */
export async function ensureElkLoader(): Promise<boolean> {
  if (elkLoaderRegistered) return true;
  // Постоянный сбой: не спамим dynamic import + warn на каждый ELK-импорт.
  if (elkLoaderFailed) return false;
  try {
    const mermaid = (await import("mermaid")).default as {
      registerLayoutLoaders: (loaders: unknown) => void;
    };
    const elkLayouts = (await import("@mermaid-js/layout-elk")).default;
    mermaid.registerLayoutLoaders(elkLayouts);
    elkLoaderRegistered = true;
    return true;
  } catch (e) {
    elkLoaderFailed = true;
    console.warn(
      "[shemma] ELK layout loader registration failed; falling back to dagre",
      e,
    );
    return false;
  }
}

function plaintextLabel(editor: Editor, s: TLShape): string | undefined {
  // biome-ignore lint/suspicious/noExplicitAny: tldraw shape props not in public types
  const rt = (s as any).props?.richText;
  if (!rt) return undefined;
  const text = renderPlaintextFromRichText(editor, rt);
  return text || undefined;
}

/**
 * DRW-134 Task 2.6: Heuristic — is this tldraw `group` shape a cosmetic wrapper?
 *
 * Cosmetic groups are intermediate wrappers emitted by `createMermaidDiagram`
 * that carry no semantic meaning (no `meta.role`, no `meta.didrawName` / `didrawId`).
 * Boundary groups (from subgraph blocks) have `meta.role === "boundary"`.
 *
 * Rule: cosmetic iff:
 *   - shape.type === "group"
 *   - meta.role is absent or not "boundary"
 *   - meta.didrawId is absent
 *   - meta.didrawName is absent (was never assigned by legacy importer)
 *
 * False-negative (keeping a boundary group as group) is safer than
 * false-positive (unwittingly ungrouping a semantic subgraph).
 */
export function isCosmeticGroup(shape: TLShape): boolean {
  if (shape.type !== "group") return false;
  // biome-ignore lint/suspicious/noExplicitAny: tldraw meta is untyped
  const m = (shape as any).meta as Record<string, unknown> | undefined;
  if (!m) return true; // no meta at all → cosmetic
  if (m.role === "boundary") return false; // semantic boundary group
  if (m.didrawId !== undefined) return false; // already assigned v2 identity
  if (m.didrawName !== undefined) return false; // assigned legacy identity
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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

/**
 * DRW-134 Task 2.6 / DRW-148: Импортировать Mermaid diagram в editor.
 *
 * **v2 path (единственный):** вызывает `POST /api/schema/create` с raw mermaid source.
 * Backend создаёт schema-frame (v2 protocol), auto-upgrade room в v2, возвращает
 * `{frameId, nodeIds}`. Реальные tldraw records приходят через WS broadcast.
 * Frontend shapes напрямую НЕ пишутся. Возвращает `{ok:true, frameId, nodeIds,
 * shapeIds:[], sourceTargetIds:[]}` — caller зум'ит по frameId после WS settle.
 *
 * Throws если backend недоступен или вернул ошибку. Тихого v1-фоллбека нет
 * (DRW-148: v2 — единственный путь создания схем).
 */
export async function importMermaid(
  editor: Editor,
  source: string,
  opts: {
    /** label для schema-frame. Default — первая непустая строка source или "Imported diagram". */
    label?: string;
    /** Пространство для backend call. Default из location.search. */
    space?: string;
    /** Room для backend call. Default из location.search. */
    room?: string;
    /** Stage-1 import: mermaid-id-keyed позиции для backend position-injection. */
    positionsOverride?: Record<string, { x: number; y: number; w?: number; h?: number }>;
  } = {},
): Promise<MermaidImportResult> {
  // DRW-141: aligned with MCP `extractMermaidLabel`; fixes browser-mode leaking
  // the raw mermaid identifier line (e.g. `"x[Browser X]"`) into frame.props.name.
  const label = opts.label ?? inferMermaidLabel(source);

  const resp = await createSchemaViaBackend({
    label,
    raw: source,
    space: opts.space,
    room: opts.room,
    positionsOverride: opts.positionsOverride,
  });
  // v2 path — shapes arrive via WS; return immediately with backend IDs.
  // editor param kept in signature for API compatibility (callers pass it in).
  void editor;
  return {
    ok: true,
    frameId: (resp as { ok: true; frameId: string }).frameId,
    nodeIds: (resp as { ok: true; nodeIds: NodeId[] }).nodeIds,
    shapeIds: [],
    sourceTargetIds: [],
  };
}

/**
 * Legacy v1 import path: createMermaidDiagram + local shape writes.
 * Kept for fallback and test compatibility. Internal; not exported from module
 * index, but exported here for direct test injection via mocking.
 *
 * DRW-134 Task 2.6 auto-ungroup: after createMermaidDiagram, any cosmetic
 * tldraw `group` shape that wraps frame children is detected and dissolved —
 * its children are re-parented directly to the frame, and the group is deleted.
 * Boundary groups (`meta.role === "boundary"`) are preserved.
 */
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

  const after = editor.getCurrentPageShapes();
  const newShapes = after.filter(
    (s) => !beforeIds.has(s.id as unknown as string),
  );

  if (newShapes.length === 0) {
    throw new Error("mermaid produced no shapes");
  }

  const pageId = editor.getCurrentPageId() as unknown as string;
  // biome-ignore lint/suspicious/noExplicitAny: tldraw shape parentId not typed publicly
  const isRoot = (s: TLShape) => (s as any).parentId === pageId;
  const rootFrames = newShapes.filter((s) => isRoot(s) && s.type === "frame");
  const sourceTargets =
    rootFrames.length > 0 ? rootFrames : newShapes.filter(isRoot);
  const sourceTargetIds = new Set<string>(
    sourceTargets.map((s) => s.id as unknown as string),
  );

  // DRW-084: detect geo container shapes (subgraphs) — get role="boundary".
  const newShapeIds = new Set<string>(
    newShapes.map((s) => s.id as unknown as string),
  );
  const isContainer = (s: TLShape): boolean => {
    if (s.type !== "geo") return false;
    return newShapes.some(
      // biome-ignore lint/suspicious/noExplicitAny: tldraw shape parentId not typed publicly
      (c) =>
        (c as any).parentId === s.id &&
        newShapeIds.has(c.id as unknown as string),
    );
  };

  // DRW-134 Task 2.6: auto-ungroup cosmetic tldraw `group` shapes.
  // After createMermaidDiagram, detect root groups that are cosmetic wrappers
  // (no semantic meta). Re-parent their children to the frame / page, then delete.
  const cosmeticGroups = newShapes.filter(isCosmeticGroup);
  if (cosmeticGroups.length > 0) {
    for (const group of cosmeticGroups) {
      // biome-ignore lint/suspicious/noExplicitAny: tldraw parentId not typed publicly
      const groupId = group.id as unknown as string;
      // Find parent of this group to re-parent children to it.
      // biome-ignore lint/suspicious/noExplicitAny: tldraw parentId not typed publicly
      const groupParentId = (group as any).parentId as string;
      // Find children of this cosmetic group among new shapes.
      const children = newShapes.filter(
        // biome-ignore lint/suspicious/noExplicitAny: tldraw parentId not typed publicly
        (c) =>
          (c as any).parentId === groupId &&
          newShapeIds.has(c.id as unknown as string),
      );
      if (children.length > 0) {
        // Re-parent children to the group's parent (frame or page).
        // biome-ignore lint/suspicious/noExplicitAny: tldraw updateShapes accepts partial shape types
        // biome-ignore lint/suspicious/noExplicitAny: tldraw updateShapes accepts partial shape
        const reparentUpdates: any[] = children.map((c) => ({
          id: c.id,
          type: c.type,
          parentId: groupParentId,
          meta: { ...c.meta },
        }));
        editor.updateShapes(reparentUpdates);
      }
      // Delete the cosmetic group shape.
      // biome-ignore lint/suspicious/noExplicitAny: editor.deleteShape not typed publicly
      (editor as any).deleteShape?.(group.id);
    }
    // Re-read shapes after group dissolution.
    const afterUngroup = editor.getCurrentPageShapes();
    newShapes.length = 0;
    for (const s of afterUngroup) {
      if (!beforeIds.has(s.id as unknown as string)) {
        newShapes.push(s);
      }
    }
  }

  // DRW-134 Task 2.6: Assign v2 identity fields (didrawId, didrawLabel) in addition
  // to legacy didrawName for backward compat. Use slugify from @shemma/domain.
  const usedIds = new Set<NodeId>();
  // biome-ignore lint/suspicious/noExplicitAny: tldraw partial update types verbose; safe by id+type
  const updates: any[] = [];
  for (const s of newShapes) {
    const labelText =
      s.type === "arrow"
        ? (plaintextLabel(editor, s) ?? "arrow")
        : (plaintextLabel(editor, s) ?? s.type);
    const slug = labelText ? slugify(labelText) : "";
    const nodeId = generateNodeId({ slug, existingIds: usedIds });
    usedIds.add(nodeId);

    const meta: Record<string, unknown> = {
      ...s.meta,
      // v2 fields (DRW-134):
      didrawId: nodeId,
      didrawLabel: labelText,
      // Legacy field (backward compat — v1 consumers still read didrawName):
      didrawName: nodeId,
    };

    // DRW-084: geo containers (subgraphs) + legacy frame shapes → role="boundary".
    if (isContainer(s) || s.type === "frame") {
      meta.role = "boundary";
    }

    if (sourceTargetIds.has(s.id as unknown as string)) {
      meta.mermaidSource = source;
      // DRW-134 Task 2.6: mark frame as schema-frame with v2 protocol fields.
      if (s.type === "frame") {
        meta.didrawSchemaFrame = true;
        meta.didrawProtocol = "v2";
        meta.schemaProtocolVersion = "1.0";
        meta.didrawOverlays = {};
      }
    }

    // didrawSchemaParent on children — set to the first source frame's id.
    const firstFrameId = Array.from(sourceTargetIds)[0];
    if (
      firstFrameId &&
      !sourceTargetIds.has(s.id as unknown as string) &&
      s.type !== "arrow"
    ) {
      // biome-ignore lint/suspicious/noExplicitAny: parentId not typed publicly
      const parentId = (s as any).parentId as string;
      if (parentId && parentId !== pageId) {
        meta.didrawSchemaParent = parentId;
      }
    }

    updates.push({
      id: s.id,
      type: s.type,
      meta,
    });
  }
  if (updates.length > 0) {
    editor.updateShapes(updates);
  }

  return {
    ok: true,
    shapeIds: newShapes.map((s) => s.id),
    sourceTargetIds: Array.from(sourceTargetIds) as unknown as TLShapeId[],
  };
}

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

  // dagre/elk: harvest mermaid-native positions offscreen, then build OUR v2
  // objects on those coords through the backend (replaces native-stub legacy path).
  let engineUsed: LayoutEngine = engine;
  let engineFallback = false;
  if (engine === "elk") {
    const ok = await ensureElkLoader();
    if (!ok) {
      engineUsed = "dagre";
      engineFallback = true;
    }
  }
  const positions = await harvestMermaidPositions(
    editor,
    source,
    engineUsed === "elk" ? { layout: "elk" } : {},
  );
  const res = await importMermaid(editor, source, { ...opts, positionsOverride: positions });
  return { ...res, engineUsed, engineFallback };
}
