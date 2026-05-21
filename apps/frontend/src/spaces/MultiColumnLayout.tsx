import { App } from "../App";
import { Gallery } from "../gallery/Gallery";
import type { Column } from "./url-parser";

/**
 * Stub layout for Task 14 — Task 17 will replace this with the real
 * multi-column splitter UI. For now we handle the single-column case by
 * rendering the existing `App`/`Gallery` components so the new URL forms
 * (`?space=…`, `?space=…&room=…`) start working immediately.
 *
 * DRW-116 Task 15: pass `space` (and `room` for room columns) down to
 * `<App />` / `<Gallery />` so their HTTP/WS calls carry the composite
 * `(space, room)` query the backend now scopes per-space bundles by.
 *
 * Multi-column URLs (`?cols=…`) fall back to a placeholder; Task 17 lands
 * the splitter + per-column state wiring.
 */
export function MultiColumnLayout({ columns }: { columns: Column[] }) {
  const [first] = columns;
  if (columns.length === 1 && first) {
    if (first.kind === "room") {
      return <App space={first.spaceId} room={first.roomId} />;
    }
    return <Gallery space={first.spaceId} />;
  }
  return (
    <div className="multi-column-placeholder">
      MultiColumnLayout coming in Task 17 — {columns.length} columns
    </div>
  );
}
