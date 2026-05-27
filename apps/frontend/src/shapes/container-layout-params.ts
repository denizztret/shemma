import type { Editor, TLShapeId } from "tldraw";
import type { ContainerLayoutOverride } from "@shemma/domain";

/**
 * Task #7 (frame-container-direction-layout): per-container layout params
 * override writer for schema-container AND frame.
 *
 * Semantics (see spec 4.1):
 *  - `partial` is `Partial<LayoutParams>` → optimistic
 *    `editor.updateShape({ meta: { didrawLayoutParams: partial } })` + POST
 *    `/api/agent/layout-selection` с `layoutParamsOverride: { [id]: partial }`
 *    + `scope:"self"`. Backend (Task #4) overrides spacing per-anchor.
 *  - `partial === null` → optimistic update writes `meta.didrawLayoutParams`
 *    as `undefined` (tldraw convention — undefined deletes the key from
 *    `shape.meta` locally). POST передаёт `null` в map; backend (Task #4)
 *    удаляет meta key server-side. Convergent semantics: key absent в meta
 *    после round-trip.
 *  - Non-container ids (anything beyond `schema-container` / `frame`) silently
 *    skipped — no `updateShape`, no entry в POST body.
 *
 * Pattern mirrors `setContainerDirection` (Task #6): single `editor.run`
 * batches updates в одну undo entry; POST attaches `scope:"self"` чтобы
 * backend выполнил layout pass по subgraph'у конкретного container'а без
 * схлопывания parent frame (см. DRW-167 + spec §3.5).
 */
export async function setContainerLayoutParams(
  editor: Editor,
  ids: string[],
  partial: ContainerLayoutOverride,
): Promise<void> {
  if (ids.length === 0) return;

  // tldraw convention: meta.<key> = undefined deletes the key locally.
  const metaValue: ContainerLayoutOverride | undefined =
    partial === null ? undefined : partial;

  const accepted: string[] = [];
  const override: Record<string, ContainerLayoutOverride> = {};

  editor.run(() => {
    for (const id of ids) {
      const shape = editor.getShape(id as TLShapeId);
      if (!shape) continue;
      if (shape.type !== "schema-container" && shape.type !== "frame") continue;

      const meta = (shape.meta ?? {}) as Record<string, unknown>;
      // biome-ignore lint/suspicious/noExplicitAny: tldraw frame/container meta untyped
      editor.updateShape({
        id: shape.id,
        type: shape.type,
        meta: { ...meta, didrawLayoutParams: metaValue },
      } as any);

      accepted.push(id);
      // JSON.stringify will serialize null as `null` (preserved on wire), and
      // omit undefined — but `partial` here is either `Partial<LayoutParams>` or
      // `null`, never undefined, so this assignment preserves the wire shape.
      override[id] = partial;
    }
  });

  if (accepted.length === 0) return;

  await triggerLayoutSelection(accepted, override);
}

async function triggerLayoutSelection(
  ids: string[],
  layoutParamsOverride: Record<string, ContainerLayoutOverride>,
): Promise<void> {
  // SSR-safe guard (mirrors SchemaContainerActions).
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const space = url.searchParams.get("space") ?? "default";
  const room = url.searchParams.get("room") ?? "default";

  try {
    await fetch(
      `/api/agent/layout-selection?space=${encodeURIComponent(space)}&room=${encodeURIComponent(room)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ids,
          scope: "self",
          layoutParamsOverride,
        }),
      },
    );
  } catch {
    // Non-fatal: user can manually trigger via Cmd+Shift+L.
  }
}
