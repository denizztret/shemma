/**
 * DRW-051: Pure SVG thumbnail renderer for TLStoreSnapshot.
 * No @tldraw/* imports — pure string assembly.
 */

type ShapeRecord = {
  typeName: string;
  type: string;
  x: number;
  y: number;
  props?: {
    w?: number;
    h?: number;
    size?: number;
    geo?: string;
    segments?: Array<{ points?: Array<{ x: number; y: number }> }>;
    start?: { x?: number; y?: number };
    end?: { x?: number; y?: number };
  };
};

type TLStoreSnapshot = {
  store?: Record<string, unknown>;
};

const PAD = 20;

function escapeAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function bbox(shapes: ShapeRecord[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const s of shapes) {
    const x = s.x ?? 0;
    const y = s.y ?? 0;
    const w = s.props?.w ?? s.props?.size ?? 100;
    const h = s.props?.h ?? 100;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + w > maxX) maxX = x + w;
    if (y + h > maxY) maxY = y + h;
  }

  return { minX, minY, maxX, maxY };
}

/** Render a TLStoreSnapshot to an SVG string. Pure function, no I/O. */
export function renderThumbnail(
  snapshot: TLStoreSnapshot,
  w = 240,
  h = 160,
): string {
  const store = snapshot?.store ?? {};
  const shapes = Object.values(store).filter(
    (r): r is ShapeRecord =>
      r !== null &&
      typeof r === "object" &&
      (r as ShapeRecord).typeName === "shape",
  );

  if (shapes.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
      `<text x="${w / 2}" y="${h / 2}" text-anchor="middle" dominant-baseline="middle" ` +
      `font-family="sans-serif" font-size="14" fill="#aaa">Empty</text></svg>`;
  }

  const box = bbox(shapes);
  const bx = box.minX - PAD;
  const by = box.minY - PAD;
  const bw = box.maxX - box.minX + PAD * 2;
  const bh = box.maxY - box.minY + PAD * 2;

  const viewBox = escapeAttr(`${bx} ${by} ${bw} ${bh}`);
  const parts: string[] = [];

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" ` +
    `viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet">`,
  );

  for (const s of shapes) {
    const sx = s.x ?? 0;
    const sy = s.y ?? 0;
    const sw = s.props?.w ?? s.props?.size ?? 100;
    const sh = s.props?.h ?? 100;

    if (s.type === "geo") {
      const geo = s.props?.geo ?? "rectangle";
      if (geo === "ellipse") {
        const cx = sx + sw / 2;
        const cy = sy + sh / 2;
        const rx = sw / 2;
        const ry = sh / 2;
        parts.push(
          `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" stroke="#666" fill="#eee" stroke-width="1.5"/>`,
        );
      } else if (geo === "diamond") {
        const cx = sx + sw / 2;
        const cy = sy + sh / 2;
        const pts = `${cx},${sy} ${sx + sw},${cy} ${cx},${sy + sh} ${sx},${cy}`;
        parts.push(
          `<polygon points="${pts}" stroke="#666" fill="#eee" stroke-width="1.5"/>`,
        );
      } else {
        // default: rectangle
        parts.push(
          `<rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" stroke="#666" fill="#eee" stroke-width="1.5"/>`,
        );
      }
    } else if (s.type === "note") {
      parts.push(
        `<rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" rx="4" ry="4" stroke="#cca800" fill="#fff9c4" stroke-width="1.5"/>`,
      );
    } else if (s.type === "text") {
      parts.push(
        `<rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" stroke="#ccc" fill="#f5f5f5" stroke-width="1"/>`,
      );
    } else if (s.type === "frame") {
      parts.push(
        `<rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" stroke="#888" fill="none" stroke-dasharray="4 4" stroke-width="1.5"/>`,
      );
    } else if (s.type === "arrow") {
      const startX = (s.props?.start?.x ?? 0) + sx;
      const startY = (s.props?.start?.y ?? 0) + sy;
      const endX = (s.props?.end?.x ?? sw) + sx;
      const endY = (s.props?.end?.y ?? sh) + sy;
      parts.push(
        `<line x1="${startX}" y1="${startY}" x2="${endX}" y2="${endY}" stroke="#333" stroke-width="1.5"/>`,
      );
    } else if (
      s.type === "draw" ||
      s.type === "line" ||
      s.type === "highlight"
    ) {
      const segs = s.props?.segments;
      if (segs && segs.length > 0) {
        const pts = segs
          .flatMap((seg) => seg.points ?? [])
          .map((p) => `${(p.x ?? 0) + sx},${(p.y ?? 0) + sy}`)
          .join(" ");
        if (pts) {
          parts.push(
            `<polyline points="${pts}" stroke="#666" fill="none" stroke-width="1.5"/>`,
          );
        }
      }
    } else {
      // image, video, embed, bookmark — grey placeholder
      parts.push(
        `<rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" stroke="#ccc" fill="#e8e8e8" stroke-width="1"/>`,
      );
    }
  }

  parts.push("</svg>");
  return parts.join("");
}
