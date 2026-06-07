import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { Gallery } from "./gallery/Gallery";
import { SpacesPage } from "./spaces/SpacesPage";
import { parseShemmaUrl } from "./spaces/url-parser";
import { initTheme } from "./theme/theme-store";

// DRW-217: тема до рендера — data-shemma-theme на <html> без flash светлой.
initTheme();

// DRW-120: legacy URLs (?room=foo / ?view=gallery) without ?space= are leftovers
// from pre-multi-space bookmarks. The synthetic LEGACY_SPACE_ID fallback no
// longer works (backend regex-rejects "__legacy__") — strip the legacy params
// and land on SpacesPage so the user picks a real space explicitly.
const params = new URLSearchParams(window.location.search);
if (
  (params.has("room") || params.get("view") === "gallery") &&
  !params.has("space")
) {
  window.history.replaceState(null, "", "/");
}

const state = parseShemmaUrl(window.location.href);
let tree: React.ReactNode;
if (state.view === "landing") {
  tree = <SpacesPage />;
} else if (state.view === "gallery") {
  tree = <Gallery space={state.spaceId} />;
} else {
  tree = <App space={state.spaceId} room={state.roomId} />;
}

// biome-ignore lint/style/noNonNullAssertion: root element is guaranteed by index.html
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{tree}</React.StrictMode>,
);
