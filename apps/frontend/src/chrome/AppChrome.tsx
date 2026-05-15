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
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
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
        // right: 56 keeps clear of tldraw's bottom-right help button (~48px wide + 8 gap).
        <div
          style={{
            position: "absolute",
            right: 56,
            bottom: 8,
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
