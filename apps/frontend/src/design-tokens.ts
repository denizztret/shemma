// Единственный источник правды для цветов/шрифтов/z-index.
// Никаких inline констант в JSX по правилам §3.8.
//
// DRW-217: цветовые токены — CSS-переменные (определены в styles.css под
// :root / html[data-shemma-theme="dark"]). Inline-стили компонентов
// темизируются автоматически без re-render'а. Статичные значения
// (badgeDev/badgeDebug/successBg/errorBg/errorText) одинаковы в обеих темах.
export const tokens = {
  font: {
    sm: 12,
    base: 13,
    mono: "ui-monospace, SFMono-Regular, monospace",
    sans: "system-ui, -apple-system, sans-serif",
  },
  color: {
    text: "var(--shemma-text)",
    textMuted: "var(--shemma-text-muted)",
    border: "var(--shemma-border)",
    hoverOverlay: "var(--shemma-hover-overlay)",
    bgPage: "var(--shemma-bg-page)",
    bg: "var(--shemma-bg)",
    bgSubtle: "var(--shemma-bg-stripe)",
    bgOverlay: "var(--shemma-bg-overlay)",
    backdrop: "var(--shemma-backdrop)",
    accent: "var(--shemma-accent)",
    badgeDev: "#fc6",
    badgeDebug: "#f66",
    badgeBg: "var(--shemma-badge-bg)",
    badgeBorder: "var(--shemma-badge-border)",
    badgeText: "var(--shemma-badge-text)",
    warnBg: "var(--shemma-warn-bg)",
    warnBorder: "var(--shemma-warn-border)",
    warnText: "var(--shemma-warn-text)",
    dangerBg: "var(--shemma-danger-bg)",
    dangerBorder: "var(--shemma-danger-border)",
    dangerText: "var(--shemma-danger-text)",
    successBg: "#16a34a",
    errorBg: "#c1273a",
    errorText: "#ffffff",
  },
  radius: { sm: 3, md: 6, lg: 8 },
  z: { overlay: 90, banner: 100, modal: 1000, toast: 9999 },
} as const;
