import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";

const room = new URLSearchParams(location.search).get("room") ?? "default";

// biome-ignore lint/style/noNonNullAssertion: root element is guaranteed by index.html
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App room={room} />
  </React.StrictMode>,
);
