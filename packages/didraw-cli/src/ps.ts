import { ALL_PROFILES, type Profile, portFor } from "./profile";
import { isHealthy, status } from "./daemon";

// Static port defaults per profile — used in ps to show correct port for each
// profile regardless of the current process's DIDRAW_PORT env override.
// DIDRAW_PORT override is honored only for the profile that matches the current
// process's DIDRAW_PROFILE (i.e. the profile the operator is querying from),
// because cross-process env is unknowable.
const PORT_BY_PROFILE: Record<Profile, number> = {
  dev: 8788,
  release: 8787,
  debug: 8787,
};

function portForPs(p: Profile): number {
  const currentProfile = (process.env.DIDRAW_PROFILE ?? "release") as Profile;
  if (p === currentProfile) {
    // Honor DIDRAW_PORT override for the current profile
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
  console.log(JSON.stringify(results, null, 2));
}
