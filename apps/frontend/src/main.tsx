import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { Gallery } from "./gallery/Gallery";
import { SpacesPage } from "./spaces/SpacesPage";
import { parseShemmaUrl } from "./spaces/url-parser";
import { LEGACY_SPACE_ID } from "./transport/api";

const params = new URLSearchParams(window.location.search);
const hasRoomQuery = params.has("room");
const hasGalleryView = params.get("view") === "gallery";
const hasSpaceQuery = params.has("space");
const isLegacyRoute = (hasRoomQuery || hasGalleryView) && !hasSpaceQuery;

let tree: React.ReactNode;
if (isLegacyRoute) {
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
  if (state.view === "landing") {
    tree = <SpacesPage />;
  } else if (state.view === "gallery") {
    tree = <Gallery space={state.spaceId} />;
  } else {
    tree = <App space={state.spaceId} room={state.roomId} />;
  }
}

// biome-ignore lint/style/noNonNullAssertion: root element is guaranteed by index.html
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{tree}</React.StrictMode>,
);
