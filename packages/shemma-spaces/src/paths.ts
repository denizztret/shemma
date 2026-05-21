import os from "node:os";
import path from "node:path";

export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg && xdg.length > 0 ? path.join(xdg, "shemma") : path.join(os.homedir(), ".config", "shemma");
}

export function spacesJsonPath(): string {
  return path.join(configDir(), "spaces.json");
}

export function spacesLockPath(): string {
  return path.join(configDir(), "spaces.json.lock");
}
