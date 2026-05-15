import { tokens } from "../design-tokens";
import type { AiActivity } from "../transport/ws";

export function AiActivityBadge({
  activity,
}: {
  activity: AiActivity | null;
}) {
  if (!activity) return null;
  return (
    <div
      style={{
        position: "absolute",
        top: 8,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: tokens.z.overlay,
        pointerEvents: "none",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 10px",
        background: tokens.color.bgOverlay,
        border: `1px solid ${tokens.color.badgeDev}`,
        borderRadius: tokens.radius.md,
        fontFamily: tokens.font.sans,
        fontSize: tokens.font.sm,
        color: tokens.color.text,
        boxShadow: "0 2px 6px rgba(0,0,0,0.08)",
        animation: "didraw-ai-pulse 1.4s ease-in-out infinite",
      }}
    >
      <span
        style={{
          display: "inline-block",
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: tokens.color.badgeDev,
        }}
      />
      <span style={{ fontWeight: 600 }}>{activity.actor}</span>
      <span style={{ color: tokens.color.textMuted }}>·</span>
      <span>{activity.task}</span>
      <style>{`
        @keyframes didraw-ai-pulse {
          0%, 100% { box-shadow: 0 2px 6px rgba(0,0,0,0.08); }
          50%      { box-shadow: 0 2px 14px ${tokens.color.badgeDev}; }
        }
      `}</style>
    </div>
  );
}
