import type { Profile } from "./server";

export type EnsureOpts = {
  profile: Profile;
  port: number;
  autoEnsure: boolean;
  probeHealth: () => Promise<boolean>;
  startBackground: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  /** Test override; default 50 attempts × 100ms = 5s timeout (match CLI). */
  maxAttempts?: number;
};

export type EnsureResult =
  | { ok: true; port: number }
  | { ok: false; code: "daemon-unavailable" | "daemon-unhealthy"; port: number };

export async function ensureDaemonSilent(opts: EnsureOpts): Promise<EnsureResult> {
  if (await opts.probeHealth()) return { ok: true, port: opts.port };
  if (!opts.autoEnsure) {
    return { ok: false, code: "daemon-unavailable", port: opts.port };
  }
  await opts.startBackground();
  const max = opts.maxAttempts ?? 50;
  for (let i = 0; i < max; i++) {
    await opts.sleep(100);
    if (await opts.probeHealth()) return { ok: true, port: opts.port };
  }
  return { ok: false, code: "daemon-unhealthy", port: opts.port };
}
