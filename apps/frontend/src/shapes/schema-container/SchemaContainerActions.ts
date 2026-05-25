import type { Editor } from "tldraw";
import type { SchemaContainerDirection, SchemaContainerProps, SchemaContainerShape } from "./SchemaContainerShape";

/**
 * DRW-150: Set direction prop on all selected schema-container shapes.
 *
 * If direction !== 'custom', also triggers an immediate layout pass via
 * backend POST /api/layout/selection so the change is visually applied
 * without requiring a manual Cmd+Shift+L.
 */
export function setSchemaContainerDirection(
  editor: Editor,
  direction: SchemaContainerDirection,
): void {
  const targets = editor
    .getSelectedShapes()
    .filter((s) => s.type === "schema-container");
  if (targets.length === 0) return;

  for (const t of targets) {
    const props = t.props as SchemaContainerProps;
    if (props.direction === direction) continue;
    editor.updateShape<SchemaContainerShape>({
      id: t.id,
      type: "schema-container",
      props: { ...props, direction },
    });
  }

  // Trigger immediate layout pass (non-custom only — custom preserves positions)
  if (direction !== "custom") {
    void triggerLayoutSelection(targets.map((t) => t.id as string));
  }
}

async function triggerLayoutSelection(containerIds: string[]): Promise<void> {
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
        body: JSON.stringify({ ids: containerIds }),
      },
    );
  } catch {
    // Non-fatal: user can manually trigger via Cmd+Shift+L
  }
}
