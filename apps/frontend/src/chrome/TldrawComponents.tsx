import type { TLComponents } from "tldraw";
import { GalleryLink } from "./GalleryLink";
import { RoomBadge } from "./RoomBadge";

export function buildTldrawComponents(room: string): TLComponents {
  return {
    SharePanel: () => (
      <div style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
        <GalleryLink />
        <RoomBadge room={room} />
      </div>
    ),
  };
}
