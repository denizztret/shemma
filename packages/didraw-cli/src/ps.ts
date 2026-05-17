import { ALL_PROFILES, type Profile, portFor } from "./profile";
import { isHealthy, status } from "./daemon";

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
        const port = portFor(p);
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
          port: portFor(p),
          running: false,
          healthy: false,
        };
      }
    }),
  );
  console.log(JSON.stringify(results, null, 2));
}
