import { tokens } from "../design-tokens";

export function RoomBadge({ room }: { room: string }) {
  return (
    <div
      style={{
        // ВНИМАНИЕ: это контент tldraw SharePanel зоны, координат не задаём.
        // Tldraw сам позиционирует SharePanel в top-right.
        padding: "4px 8px",
        fontFamily: tokens.font.mono,
        fontSize: tokens.font.sm,
        color: tokens.color.textMuted,
        background: tokens.color.bgOverlay,
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.sm,
        pointerEvents: "auto",
      }}
    >
      room: <span style={{ color: tokens.color.text }}>{room}</span>
    </div>
  );
}
