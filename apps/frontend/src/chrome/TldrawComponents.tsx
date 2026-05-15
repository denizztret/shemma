import {
  DefaultToolbar,
  DefaultToolbarContent,
  type TLComponents,
} from "tldraw";
import { RoomBadge } from "./RoomBadge";

/**
 * Build tldraw `components` prop. Vertical toolbar matches the default tldraw.com
 * desktop layout (left side, vertical) per spec §3.8 tldraw-native principle.
 *
 * Docs: https://tldraw.dev/sdk-features/ui-components
 */
export function buildTldrawComponents(room: string): TLComponents {
  return {
    SharePanel: () => <RoomBadge room={room} />,
    Toolbar: () => (
      <DefaultToolbar orientation="vertical">
        <DefaultToolbarContent />
      </DefaultToolbar>
    ),
  };
}
