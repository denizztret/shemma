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
    body: JSON.stringify({ label: opts.label, raw: opts.raw }),
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
};

/**
 * DRW-134 Task 2.6: Импортировать Mermaid diagram в editor.
 *
 * **v2 path (default):** вызывает `POST /api/schema/create` с raw mermaid source.
 * Backend создаёт schema-frame (v2 protocol), auto-upgrade room в v2, возвращает
 * `{frameId, nodeIds}`. Реальные tldraw records приходят через WS broadcast.
 * Frontend shapes напрямую НЕ пишутся. Возвращает `{ok:true, frameId, nodeIds,
 * shapeIds:[], sourceTargetIds:[]}` — caller зум'ит по frameId после WS settle.
 *
 * **v1 fallback path (когда `opts.forceV1 === true` или endpoint 404/503):**
 * Старый flow через `createMermaidDiagram` + local shape writes:
 *   1) записываем shape'ы локально (meta.didrawName + identity v2-fields);
 *   2) auto-ungroup cosmetic tldraw group wrappers (если есть);
 *   3) frame получает `meta.didrawSchemaFrame=true` + v2 marker fields.
 * WS-фреймы шлёт startStoreSync автоматически.
 *
 * Throws на невалидный source.
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
    /** Принудительно использовать legacy v1 path. */
    forceV1?: boolean;
  } = {},
): Promise<MermaidImportResult> {
  // DRW-141: aligned with MCP `extractMermaidLabel`; fixes browser-mode leaking
  // the raw mermaid identifier line (e.g. `"x[Browser X]"`) into frame.props.name.
  const label = opts.label ?? inferMermaidLabel(source);

  if (!opts.forceV1) {
    try {
      const resp = await createSchemaViaBackend({
        label,
        raw: source,
        space: opts.space,
        room: opts.room,
      });
      // v2 path — shapes arrive via WS; return immediately with backend IDs.
      return {
        ok: true,
        frameId: (resp as { ok: true; frameId: string }).frameId,
        nodeIds: (resp as { ok: true; nodeIds: NodeId[] }).nodeIds,
        shapeIds: [],
        sourceTargetIds: [],
      };
    } catch (err) {
      // Fallback to v1 if backend unavailable (e.g. 404 before Task 2.5 shipped).
      // Log but don't rethrow — legacy path below.
      console.warn(
        "[mermaid-import] v2 backend call failed, falling back to v1 path:",
        err,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // v1 legacy path (fallback / forceV1)
  // ---------------------------------------------------------------------------
  return importMermaidLegacy(editor, source);
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
): Promise<MermaidImportResult> {
  const mod = await loadMermaid();
  // biome-ignore lint/suspicious/noExplicitAny: createMermaidDiagram не в public d.ts'ках
  const mermaidMod = mod as any;

  const beforeIds = new Set<string>(
    editor.getCurrentPageShapes().map((s) => s.id as unknown as string),
  );

  // DRW-093: source passes through as-is.
  await mermaidMod.createMermaidDiagram(editor, source);

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
