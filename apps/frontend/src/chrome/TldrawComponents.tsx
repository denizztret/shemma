import type { TLComponents } from "tldraw";
import { RoomBadge } from "./RoomBadge";

/**
 * Build tldraw `components` prop. Default horizontal layout per tldraw.com.
 * DefaultToolbar orientation="vertical" wraps everything in
 * TldrawUiOrientationProvider whose React context bleeds into MainMenu /
 * PageMenu / StylePanel (siblings via portal), making the entire UI vertical
 * — do not use that prop without CSS scoping.
 *
 * Docs: https://tldraw.dev/sdk-features/ui-components
 */
export function buildTldrawComponents(room: string): TLComponents {
  return {
    SharePanel: () => <RoomBadge room={room} />,
  };
}
