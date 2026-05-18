import type { Role } from "./roles";

export type RolePreset = {
  kind: "rect" | "ellipse" | "diamond" | "sticky" | "frame";
  style: { color?: string; fill?: string; stroke?: string };
  container?: boolean;
  defaultW?: number;
  defaultH?: number;
};

const PRESETS: Record<Role, RolePreset> = {
  actor:     { kind: "ellipse", style: { color: "violet", fill: "semi" },     defaultW: 120, defaultH: 60 },
  service:   { kind: "rect",    style: { color: "blue",   fill: "semi" },     defaultW: 220, defaultH: 80 },
  datastore: { kind: "rect",    style: { color: "green",  fill: "solid" },    defaultW: 220, defaultH: 80 },
  queue:     { kind: "rect",    style: { color: "orange", fill: "pattern" },  defaultW: 140, defaultH: 50 },
  network:   { kind: "frame",   style: { color: "grey",   stroke: "dashed" }, container: true, defaultW: 400, defaultH: 300 },
  boundary:  { kind: "frame",   style: { color: "red",    stroke: "dashed" }, container: true, defaultW: 400, defaultH: 300 },
  external:  { kind: "rect",    style: { color: "yellow", fill: "semi" },     defaultW: 220, defaultH: 80 },
  note:      { kind: "sticky",  style: { color: "yellow" },                   defaultW: 200, defaultH: 100 },
};

export function rolePreset(role: Role): RolePreset {
  return PRESETS[role];
}
