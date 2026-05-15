import { homedir } from "node:os";
import { join } from "node:path";

export type Profile = "dev" | "release" | "debug";

export function parseProfile(argv: string[]): Profile {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--profile") return argv[i + 1] as Profile;
  }
  return (process.env.DIDRAW_PROFILE ?? "release") as Profile;
}

export function applyProfile(p: Profile) {
  process.env.DIDRAW_PROFILE = p;
}

export function pidFile(p: Profile): string {
  return join(homedir(), ".claude", `.didraw-${p}.pid`);
}

export function portFor(p: Profile): number {
  if (process.env.DIDRAW_PORT) return Number(process.env.DIDRAW_PORT);
  return p === "dev" ? 8788 : 8787;
}
