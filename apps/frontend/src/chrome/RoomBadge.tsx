import { useEffect, useState } from "react";
import { useToasts } from "tldraw";
import { tokens } from "../design-tokens";
import { revealRoom } from "../transport/api";
import { type VersionInfo, fetchVersion } from "../transport/version";

export function RoomBadge({ room, space }: { room: string; space: string }) {
  const [v, setV] = useState<VersionInfo | null>(null);
  const { addToast } = useToasts();
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
      {/* Клик по имени комнаты → показать её файл в Finder/проводнике. */}
      <button
        type="button"
        title="Открыть файл комнаты в Finder"
        onClick={() => {
          void revealRoom(space, room).catch((e) =>
            addToast({
              title: `Не удалось открыть файл: ${(e as Error).message}`,
              severity: "error",
            }),
          );
        }}
        style={{
          padding: "4px 8px",
          fontFamily: tokens.font.mono,
          fontSize: tokens.font.sm,
          color: tokens.color.textMuted,
          background: tokens.color.bgOverlay,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.sm,
          cursor: "pointer",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = tokens.color.hoverOverlay;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = tokens.color.bgOverlay;
        }}
      >
        room: <span style={{ color: tokens.color.text }}>{room}</span>
      </button>
    </div>
  );
}
