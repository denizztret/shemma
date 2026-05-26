export type LabelMetricsOptions = {
  /** Heuristic font size in px (default 16, tldraw size "m"). */
  fontSize?: number;
  /** Maximum wrap width before line break (default 200). */
  maxWidth?: number;
  /** Maximum lines (default 3). Excess truncated, no ellipsis (just clamped). */
  maxLines?: number;
};

export type LabelMetrics = {
  width: number;
  height: number;
  lines: number;
};

const DEFAULT_FONT_SIZE = 16;
const DEFAULT_MAX_WIDTH = 200;
const DEFAULT_MAX_LINES = 3;
const AVG_CHAR_WIDTH_RATIO = 0.5;
const LINE_HEIGHT_RATIO = 1.4;

export function measureLabelHeuristic(
  text: string,
  opts: LabelMetricsOptions,
): LabelMetrics {
  if (!text) return { width: 0, height: 0, lines: 0 };

  const fontSize = opts.fontSize ?? DEFAULT_FONT_SIZE;
  const maxWidth = opts.maxWidth ?? DEFAULT_MAX_WIDTH;
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
  const avgCharWidth = fontSize * AVG_CHAR_WIDTH_RATIO;
  const lineHeight = Math.ceil(fontSize * LINE_HEIGHT_RATIO);

  const charsPerLine = Math.max(1, Math.floor(maxWidth / avgCharWidth));
  const idealLines = Math.ceil(text.length / charsPerLine);
  const lines = Math.min(idealLines, maxLines);

  const usedCharsLastLine = lines < idealLines
    ? charsPerLine
    : (text.length - (lines - 1) * charsPerLine) || charsPerLine;
  const longestChars = lines > 1 ? charsPerLine : usedCharsLastLine;
  const width = Math.min(maxWidth, Math.ceil(longestChars * avgCharWidth));
  const height = lines * lineHeight;

  return { width, height, lines };
}
