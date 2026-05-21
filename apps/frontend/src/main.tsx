import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { Gallery } from "./gallery/Gallery";
import { MultiColumnLayout } from "./spaces/MultiColumnLayout";
import { SpacesPage } from "./spaces/SpacesPage";
import { parseShemmaUrl } from "./spaces/url-parser";
import { LEGACY_SPACE_ID } from "./transport/api";

/**
 * Routing (spec §7.2, DRW-116):
 *   1. Legacy URLs — `?room=<id>` or `?view=gallery` without any of the new
 *      space-aware params (`?space=`/`?cols=`). Keep rendering `<App />` /
 *      `<Gallery />` directly so existing dev workflows and tests stay green.
 *      Transition shim until DRW-116 wraps the whole UI under spaces.
 *   2. Everything else — delegate to `parseShemmaUrl`:
 *        • `view: "landing"` (bare `/`) → `<SpacesPage />`
 *        • `view: "columns"` → `<MultiColumnLayout />` (handles 1+ columns;
 *          single-column re-uses existing App/Gallery; multi-column stub
 *          until Task 17).
 */
const params = new URLSearchParams(window.location.search);
const hasRoomQuery = params.has("room");
const hasGalleryView = params.get("view") === "gallery";
const hasSpaceQuery = params.has("space");
const hasColsQuery = params.has("cols");
const isLegacyRoute =
  (hasRoomQuery || hasGalleryView) && !hasSpaceQuery && !hasColsQuery;

let tree: React.ReactNode;
if (isLegacyRoute) {
  // Legacy single-room / gallery path — preserved unchanged. App/Gallery
  // receive the synthetic `LEGACY_SPACE_ID` space prop so every HTTP/WS
  // call still carries `?space=` (the backend ignores the value while the
  // space middleware is OFF, which is the default for dev/release today).
  const roomParam = params.get("room");
  const showGallery = hasGalleryView || roomParam === null;
  const room = roomParam ?? "default";
  tree = showGallery ? (
    <Gallery space={LEGACY_SPACE_ID} />
  ) : (
    <App space={LEGACY_SPACE_ID} room={room} />
  );
} else {
  const state = parseShemmaUrl(window.location.href);
  tree =
    state.view === "landing" ? (
      <SpacesPage />
    ) : (
      <MultiColumnLayout columns={state.columns} />
    );
}

// biome-ignore lint/style/noNonNullAssertion: root element is guaranteed by index.html
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{tree}</React.StrictMode>,
);
