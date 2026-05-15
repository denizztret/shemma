export type VersionInfo = {
  version: string;
  channel: string;
  profile: string;
  gitSha: string;
  buildDate: string;
  latest: string | null;
  updateAvailable: boolean;
};

export async function fetchVersion(): Promise<VersionInfo> {
  const r = await fetch("/api/version");
  return r.json();
}
