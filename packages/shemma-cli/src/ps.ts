import { CanvasClient } from "@shemma/client";
import { ALL_PROFILES, type Profile, portFor } from "./profile";
import { isHealthy, status } from "./daemon";
import { getOutput, info as uiInfo } from "./ui";

// Static port defaults per profile — used in ps to show correct port for each
// profile regardless of the current process's SHEMMA_PORT env override.
// SHEMMA_PORT override is honored only for the profile that matches the current
// process's SHEMMA_PROFILE (i.e. the profile the operator is querying from),
// because cross-process env is unknowable.
const PORT_BY_PROFILE: Record<Profile, number> = {
  dev: 8788,
  release: 8787,
  debug: 8787,
};

function portForPs(p: Profile): number {
  const currentProfile = (process.env.SHEMMA_PROFILE ?? "release") as Profile;
  if (p === currentProfile) {
    // Honor SHEMMA_PORT override for the current profile
    return portFor(p);
  }
  return PORT_BY_PROFILE[p];
}

export interface ProfileStatus {
  profile: Profile;
  port: number;
  pid?: number;
  running: boolean;
  healthy: boolean;
}

/**
 * Returns resolved storage path of a currently running daemon for `profile`,
 * or `null` if no daemon is running (connection refused / unhealthy /
 * /api/health отсутствует на pre-DRW-052 версии).
 *
 * Used by `shemma open` (DRW-052) to detect storage conflict: если daemon
 * запущен на другом storage, нельзя просто открыть browser — он попадёт
 * не туда, куда user ожидает.
 */
export async function getRunningDaemonStorage(
  profile: Profile,
): Promise<string | null> {
  const port = portForPs(profile);
  const client = new CanvasClient({ baseUrl: `http://localhost:${port}` });
  const health = await client.getHealth();
  return health?.storage ?? null;
}

export async function cmdPs(): Promise<void> {
  const results = await Promise.all(
    ALL_PROFILES.map(async (p): Promise<ProfileStatus> => {
      try {
        const s = await status(p);
        const port = portForPs(p);
        const healthy = s.running ? await isHealthy(port) : false;
        return {
          profile: p,
          port,
          pid: (s as { pid?: number }).pid,
          running: s.running,
          healthy,
        };
      } catch {
        return {
          profile: p,
          port: portForPs(p),
          running: false,
          healthy: false,
        };
      }
    }),
  );
  const ui = getOutput();
  if (ui.mode === "json") {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  // Human mode: table-ish output with one line per profile.
  for (const r of results) {
    const state = r.running
      ? r.healthy
        ? "healthy"
        : "running (unhealthy)"
      : "not running";
    const pid = r.pid !== undefined ? ` pid=${r.pid}` : "";
    uiInfo(`${r.profile.padEnd(8)} :${r.port}  ${state}${pid}`);
  }
}
