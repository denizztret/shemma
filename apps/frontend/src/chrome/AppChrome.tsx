import type { ReactNode } from "react";
import { tokens } from "../design-tokens";

export function AppChrome({
  banner,
  footer,
  floatingOverlays,
  children,
}: {
  banner?: ReactNode;
  footer?: ReactNode;
  floatingOverlays?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        position: "relative",
      }}
    >
      {banner ? (
        <div style={{ zIndex: tokens.z.banner, position: "relative" }}>
          {banner}
        </div>
      ) : null}
      <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
        {children}
        {floatingOverlays}
      </div>
      {footer ? (
        // bottom-left, above tldraw's zoom-control row (~36px tall) — keeps clear of
        // bottom-right watermark area where tldraw's "Made with tldraw"/license badge sits.
        <div
          style={{
            position: "absolute",
            left: 8,
            bottom: 50,
            zIndex: tokens.z.overlay,
            pointerEvents: "auto",
          }}
        >
          {footer}
        </div>
      ) : null}
    </div>
  );
}
