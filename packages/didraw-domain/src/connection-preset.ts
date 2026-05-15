import type { ConnectionKind } from "./connections";

export type ConnectionPreset = {
  dashed: boolean;
  defaultLabel?: string;
  arrow: "to" | "both";
};

const PRESETS: Record<ConnectionKind, ConnectionPreset> = {
  sync:  { dashed: false, defaultLabel: "calls",     arrow: "to" },
  async: { dashed: true,  defaultLabel: "publishes", arrow: "to" },
  data:  { dashed: false, defaultLabel: "reads",     arrow: "to" },
  dep:   { dashed: true,                             arrow: "to" },
};

export function connectionPreset(kind: ConnectionKind): ConnectionPreset {
  return PRESETS[kind];
}
