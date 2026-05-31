import type { Editor, TLShapeId } from "tldraw";
import type {
  SchemaContainerProps,
  SchemaContainerShape,
} from "./SchemaContainerShape";

/**
 * Direction value applied through `setContainerDirection`.
 *
 * The polymorphic writer never receives `"custom"` — `"custom"` is the
 * auto-flip result, set by `SchemaContainerAutoFlip` when the user manually
 * drags a child inside a container. Explicit user selection through the
 * Direction submenu / SelectionPanel always picks one of the four cardinal
 * directions; callers guard against `"custom"` and early-return.
 */
export type ContainerDirection = "TB" | "BT" | "LR" | "RL";

/**
 * Task #6 (frame-container-direction-layout): polymorphic Direction writer
 * for schema-container AND frame.
 *
 * - **schema-container** — пишет `props.direction` (existing v0 invariant).
 * - **frame** — пишет `meta.didrawDirection` (introduced in Task #2;
 *   `runLayout::readContainerDirection` reads it server-side).
 * - **other shape types** — silently skipped.
 *
 * После optimistic local update отправляется POST `/api/agent/layout-selection`
 * с `directions` map + `scope:"self"`:
 * - `directions` map даёт backend атомарную возможность перезаписать
 *   `props.direction` для schema-container до layout pass'а (eliminates the
 *   race с WS-debounce, see DRW-166).
 * - Frame entries в `directions` map backend пока игнорирует (validation
 *   ограничена schema-container'ом, см. `apps/backend/src/routes/layout-selection.ts`);
 *   meta.didrawDirection доедет до backend через WS sync. Сам POST всё равно
 *   нужен — `affectedIds` включает frame id, и `scope:"self"` гарантирует, что
 *   layout pass пройдёт по subgraph'у конкретного container'а без схлопывания
 *   parent frame (см. DRW-167 + task #5).
 *
 * Explicit `ids` parameter — consistency с upcoming `setContainerLayoutParams`
 * (task #7); вызывающие сами решают, что в селекшене.
 */
export function setContainerDirection(
  editor: Editor,
  ids: string[],
  direction: ContainerDirection,
  opts?: { triggerLayout?: boolean },
): void {
  if (ids.length === 0) return;
  // Autolayout rebuild: when the caller drives layout itself (frontend elk),
  // it passes `triggerLayout: false` so the legacy backend layout-selection POST
  // doesn't race the elk pass. The meta/props write still persists via WS.
  const triggerLayout = opts?.triggerLayout !== false;

  const accepted: string[] = [];

  // Optimistic local updates для instant visual feedback. Single `editor.run`
  // batches changes в одну undo entry (consistency с предыдущим помощником
  // DRW-166).
  editor.run(() => {
    for (const id of ids) {
      const shape = editor.getShape(id as TLShapeId);
      if (!shape) continue;

      if (shape.type === "schema-container") {
        const props = shape.props as SchemaContainerProps;
        const meta = (shape.meta ?? {}) as Record<string, unknown>;
        const propChanged = props.direction !== direction;
        // A cardinal direction set through the panel is a deliberate user choice:
        // clear the inherited-placeholder marker (didrawDirectionInherited) so the
        // inherit-include layout treats it as EXPLICIT. Without this the marker —
        // stamped at import for subgraphs with no `direction` — would keep the
        // container "inherit" and the user's pick would be ignored. Parity with
        // backend layout-selection.ts clearing.
        const markerSet = meta.didrawDirectionInherited === true;
        if (propChanged || markerSet) {
          editor.updateShape<SchemaContainerShape>({
            id: shape.id,
            type: "schema-container",
            props: { ...props, direction },
            // Only touch meta when the marker is actually set — keeps the common
            // path (no marker) meta-free and avoids polluting it with `false`.
            ...(markerSet
              ? { meta: { ...meta, didrawDirectionInherited: false } }
              : {}),
          });
        }
        accepted.push(id);
        continue;
      }

      if (shape.type === "frame") {
        const meta = (shape.meta ?? {}) as Record<string, unknown>;
        if (meta.didrawDirection !== direction) {
          // biome-ignore lint/suspicious/noExplicitAny: tldraw frame meta untyped
          editor.updateShape({
            id: shape.id,
            type: "frame",
            meta: { ...meta, didrawDirection: direction },
          } as never);
        }
        accepted.push(id);
        continue;
      }

      // Non-container shape — skipped (no updateShape, не попадает в POST).
    }
  });

  if (accepted.length === 0) return;

  if (!triggerLayout) return;

  const directions: Record<string, ContainerDirection> = {};
  for (const id of accepted) directions[id] = direction;

  void triggerLayoutSelection(accepted, directions);
}

async function triggerLayoutSelection(
  ids: string[],
  directions: Record<string, ContainerDirection>,
): Promise<void> {
  // Read space + room from current URL (SSR-safe guard)
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
          directions,
          scope: "self",
          // Direction change implies full re-layout of subgraph: pinned children
          // were positioned для PREVIOUS direction; preserving them означает что
          // визуально ничего не происходит (см. DRW-180 live feedback). Все pinned
          // children unpin'нутся для этого re-layout pass; pin meta сохраняется
          // server-side (forceUnpin = per-request override).
          forceUnpin: true,
        }),
      },
    );
  } catch {
    // Non-fatal: user can manually trigger via Cmd+Shift+L
  }
}

// `SchemaContainerDirection` (TB/LR/BT/RL/custom) остаётся домейном
// `props.direction` schema-container'а — пишется напрямую в `App.tsx` для
// explicit "custom" choice context-menu'я. Этот writer работает только с
// cardinal directions; "custom" — отдельная responsibility (auto-flip и
// explicit context-menu select).
