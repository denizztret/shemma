import type { Editor } from "tldraw";
import type { SchemaContainerDirection, SchemaContainerProps, SchemaContainerShape } from "./SchemaContainerShape";

/**
 * DRW-166/167: Set direction prop on all selected schema-container shapes.
 *
 * Sends a single combined request to the backend: the `directions` map is
 * applied atomically before the layout pass, eliminating the race between
 * optimistic `editor.updateShape` and the WS 50ms debounce. `scope: "self"`
 * prevents the layout pass from collapsing parent frames (DRW-167).
 *
 * The optimistic local update is kept for instant UI feedback.
 */
export function setSchemaContainerDirection(
  editor: Editor,
  direction: SchemaContainerDirection,
): void {
  const targets = editor
    .getSelectedShapes()
    .filter((s) => s.type === "schema-container");
  if (targets.length === 0) return;

  // Optimistic local update for instant visual feedback.
  for (const t of targets) {
    const props = t.props as SchemaContainerProps;
    if (props.direction === direction) continue;
    editor.updateShape<SchemaContainerShape>({
      id: t.id,
      type: "schema-container",
      props: { ...props, direction },
    });
  }

  const containerIds = targets.map((t) => t.id as string);
  void triggerLayoutSelection(containerIds, direction);
}

async function triggerLayoutSelection(
  containerIds: string[],
  direction: SchemaContainerDirection,
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
          ids: containerIds,
          directions: Object.fromEntries(containerIds.map((id) => [id, direction])),
          scope: "self",
        }),
      },
    );
  } catch {
    // Non-fatal: user can manually trigger via Cmd+Shift+L
  }
}
