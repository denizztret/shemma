// Единственный источник правды для цветов/шрифтов/z-index.
// Никаких inline констант в JSX по правилам §3.8.
export const tokens = {
  font: {
    sm: 12,
    base: 13,
    mono: "ui-monospace, SFMono-Regular, monospace",
    sans: "system-ui, -apple-system, sans-serif",
  },
  color: {
    text: "#1a1a1a",
    textMuted: "#666",
    border: "rgba(0,0,0,0.12)",
    bgOverlay: "rgba(255,255,255,0.95)",
    accent: "#0a7",
    badgeDev: "#fc6",
    badgeDebug: "#f66",
    warnBg: "#fef3c7",
    warnBorder: "#f59e0b",
    warnText: "#78350f",
  },
  radius: { sm: 3, md: 6, lg: 8 },
  z: { overlay: 90, banner: 100, modal: 1000 },
} as const;
