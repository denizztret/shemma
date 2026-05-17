import type { TLComponents } from "tldraw";
import { GalleryLink } from "./GalleryLink";
import { RoomBadge } from "./RoomBadge";

export function buildTldrawComponents(room: string): TLComponents {
  return {
    SharePanel: () => (
      // tlui-layout has pointer-events:none; restore it here so the link is clickable.
      // className mirrors tldraw's own .tlui-share-zone for correct layout/z-index.
      <div
        className="tlui-share-zone"
        style={{ pointerEvents: "all", zIndex: 300 }}
      >
        <GalleryLink />
        <RoomBadge room={room} />
      </div>
    ),
  };
}
