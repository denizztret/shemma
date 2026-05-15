import {
  connectionPreset,
  rolePreset,
  type ConnectionKind,
  type Role,
} from "@didraw/domain";

// Map a domain Role + state's style + meta.styleOwnedBy into the actual
// props passed to tldraw. If user owns style, preserve user-set fields and
// only fall back to preset for absent fields. Otherwise preset wins.
export function rolePropsForNode(opts: {
  role: Role | undefined;
  styleOwnedBy?: string;
  userStyle?: { color?: string; fill?: string };
}): { color?: string; fill?: string } {
  if (!opts.role) return opts.userStyle ?? {};
  const preset = rolePreset(opts.role);
  if (opts.styleOwnedBy === "user") {
    return {
      color: opts.userStyle?.color ?? preset.style.color,
      fill: opts.userStyle?.fill ?? preset.style.fill,
    };
  }
  return { color: preset.style.color, fill: preset.style.fill };
}

export function connectionPropsForEdge(
  kind: ConnectionKind | undefined,
): { dashed: boolean; defaultLabel?: string } {
  if (!kind) return { dashed: false };
  const p = connectionPreset(kind);
  return { dashed: p.dashed, defaultLabel: p.defaultLabel };
}

export const PORT_SIDE_TO_ANCHOR: Record<
  "N" | "S" | "E" | "W",
  { x: number; y: number }
> = {
  N: { x: 0.5, y: 0 },
  S: { x: 0.5, y: 1 },
  E: { x: 1, y: 0.5 },
  W: { x: 0, y: 0.5 },
};
