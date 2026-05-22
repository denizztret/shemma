import { useEffect, useState } from "react";
import { tokens } from "../design-tokens";
import { type VersionInfo, fetchVersion } from "../transport/version";

export function RoomBadge({ room }: { room: string }) {
  const [v, setV] = useState<VersionInfo | null>(null);
  useEffect(() => {
    fetchVersion().then(setV);
  }, []);

  const versionBg =
    v?.profile === "dev"
      ? tokens.color.badgeDev
      : v?.profile === "debug"
        ? tokens.color.badgeDebug
        : tokens.color.bgOverlay;

  return (
    <div
      style={{
        // ВНИМАНИЕ: это контент tldraw SharePanel зоны, координат не задаём.
        // Tldraw сам позиционирует SharePanel в top-right.
        display: "inline-flex",
        gap: 6,
        pointerEvents: "auto",
      }}
    >
      {v && (
        <div
          style={{
            padding: "4px 8px",
            fontFamily: tokens.font.mono,
            fontSize: tokens.font.sm,
            color: tokens.color.text,
            background: versionBg,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.sm,
          }}
        >
          {v.version}
        </div>
      )}
      <div
        style={{
          padding: "4px 8px",
          fontFamily: tokens.font.mono,
          fontSize: tokens.font.sm,
          color: tokens.color.textMuted,
          background: tokens.color.bgOverlay,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.sm,
        }}
      >
        room: <span style={{ color: tokens.color.text }}>{room}</span>
      </div>
    </div>
  );
}
