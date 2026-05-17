import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { Gallery } from "./gallery/Gallery";

const params = new URLSearchParams(location.search);
const roomParam = params.get("room");
const viewParam = params.get("view");

// Routing:
// - No ?room= AND no ?view=gallery → Gallery
// - ?view=gallery → Gallery (explicit)
// - ?room=<id> → App (room editor)
const showGallery = viewParam === "gallery" || roomParam === null;
const room = roomParam ?? "default";

// biome-ignore lint/style/noNonNullAssertion: root element is guaranteed by index.html
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {showGallery ? <Gallery /> : <App room={room} />}
  </React.StrictMode>,
);
