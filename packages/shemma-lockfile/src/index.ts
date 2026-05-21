import fs from "node:fs";
import path from "node:path";

export type LockMetadata = {
  pid: number;
  port: number;
  startedAt: string;
  profile: string;
};

export function acquireLock(lockDir: string): boolean {
  try {
    fs.mkdirSync(lockDir, { recursive: false });
    return true;
  } catch (err: any) {
    if (err && err.code === "EEXIST") return false;
    throw err;
  }
}

export function releaseLock(lockDir: string): void {
  fs.rmSync(lockDir, { recursive: true, force: true });
}

export function readLockMetadata(lockDir: string): LockMetadata | undefined {
  const pidPath = path.join(lockDir, "daemon.pid");
  if (!fs.existsSync(pidPath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(pidPath, "utf8")) as LockMetadata;
  } catch {
    return undefined;
  }
}

export function writeLockMetadata(lockDir: string, meta: LockMetadata): void {
  const pidPath = path.join(lockDir, "daemon.pid");
  const tmp = `${pidPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(meta));
  fs.renameSync(tmp, pidPath);
}

export function isLockAlive(lockDir: string): boolean {
  const meta = readLockMetadata(lockDir);
  if (!meta) return false;
  try {
    process.kill(meta.pid, 0);
    return true;
  } catch {
    return false;
  }
}
