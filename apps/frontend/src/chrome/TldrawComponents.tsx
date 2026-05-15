import type { TLComponents } from "tldraw";
import { RoomBadge } from "./RoomBadge";

/**
 * Build tldraw `components` prop. New slots added as data slots are filled by later tasks
 * (Task 28 will add Prompt UI here, Task 38 — VersionFooter, etc.).
 *
 * Tldraw docs: https://tldraw.dev/sdk-features/ui-components
 */
export function buildTldrawComponents(room: string): TLComponents {
  return {
    SharePanel: () => <RoomBadge room={room} />,
  };
}
