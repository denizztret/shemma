import { useEffect, useState } from "react";
import { tokens } from "../design-tokens";
import { type VersionInfo, fetchVersion } from "../transport/version";

export function VersionFooter() {
  const [v, setV] = useState<VersionInfo | null>(null);
  useEffect(() => {
    fetchVersion().then(setV);
  }, []);
  if (!v) return null;
  const badgeText =
    v.profile === "dev" ? "DEV" : v.profile === "debug" ? "DEBUG" : null;
  const badgeBg =
    v.profile === "dev" ? tokens.color.badgeDev : tokens.color.badgeDebug;
  return (
    <div
      style={{
        padding: "2px 8px",
        fontSize: tokens.font.sm,
        fontFamily: tokens.font.mono,
        color: tokens.color.textMuted,
        background: tokens.color.bgOverlay,
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.sm,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      <span>v{v.version}</span>
      <span style={{ opacity: 0.6 }}>·</span>
      <span>{v.channel}</span>
      {badgeText && (
        <span
          style={{
            background: badgeBg,
            color: "#000",
            padding: "0 6px",
            borderRadius: tokens.radius.sm,
            fontWeight: "bold",
            fontSize: 10,
          }}
        >
          {badgeText}
        </span>
      )}
    </div>
  );
}
