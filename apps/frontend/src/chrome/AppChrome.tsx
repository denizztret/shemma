import type { ReactNode } from "react";
import { tokens } from "../design-tokens";

export function AppChrome({
  banner,
  floatingOverlays,
  children,
}: {
  banner?: ReactNode;
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
    </div>
  );
}
