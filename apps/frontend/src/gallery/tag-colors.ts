import type { RoomTagColor } from "../transport/api";

export type TagChipStyle = { bg: string; text: string };

/**
 * Single source of truth for tag chip colours — reused by cards, list rows,
 * the inline editor swatches, and the active-filter bar. One entry per
 * RoomTagColor union member (all 7 must be present; enforced by a test).
 */
export const TAG_COLORS: Record<RoomTagColor, TagChipStyle> = {
  red: { bg: "#dc2626", text: "#ffffff" },
  orange: { bg: "#ea580c", text: "#ffffff" },
  yellow: { bg: "#facc15", text: "#1a1a1a" },
  green: { bg: "#16a34a", text: "#ffffff" },
  blue: { bg: "#2563eb", text: "#ffffff" },
  purple: { bg: "#7c3aed", text: "#ffffff" },
  gray: { bg: "#6b7280", text: "#ffffff" },
};

/** Ordered list of colours for the swatch picker. */
export const TAG_COLOR_ORDER: RoomTagColor[] = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "gray",
];
