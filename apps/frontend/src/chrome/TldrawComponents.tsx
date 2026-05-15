import type { TLComponents } from "tldraw";
import { RoomBadge } from "./RoomBadge";

export function buildTldrawComponents(room: string): TLComponents {
  return {
    SharePanel: () => <RoomBadge room={room} />,
  };
}
