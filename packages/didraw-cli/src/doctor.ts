import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";
import { ALL_PROFILES, type Profile, portFor } from "./profile";
import { isHealthy, status } from "./daemon";

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
  check: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

function checkBunVersion(): CheckResult {
  const ver = Bun.version ?? "unknown";
  const [major] = ver.split(".").map(Number);
  if (major >= 1) {
    return { check: "bun-version", status: "ok", detail: `bun ${ver}` };
  }
  return {
    check: "bun-version",
    status: "fail",
    detail: `bun ${ver}`,
    hint: "upgrade bun to >= 1.0",
  };
}

function checkDidrawVersion(): CheckResult {
  // Read version from nearest package.json at build-time path
  let pkgVersion = "unknown";
  try {
    const pkgPath = join(import.meta.dir, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    pkgVersion = pkg.version ?? "unknown";
  } catch {
    // ignore
  }
  const envVersion = process.env.DIDRAW_VERSION;
  if (envVersion && envVersion !== pkgVersion) {
    return {
      check: "didraw-version",
      status: "warn",
      detail: `package.json=${pkgVersion}, DIDRAW_VERSION=${envVersion}`,
      hint: "version mismatch between binary and env override",
    };
  }
  return { check: "didraw-version", status: "ok", detail: pkgVersion };
}

async function checkDaemonStatus(p: Profile): Promise<CheckResult> {
  try {
    const s = await status(p);
    const port = portFor(p);
    if (!s.running) {
      // No pidfile or pidfile stale — but an ad-hoc daemon may still be running.
      // Probe the port with a short timeout before declaring "not running".
      const adHocHealthy = await isHealthy(port);
      if (adHocHealthy) {
        return {
          check: `daemon-status[${p}]`,
          status: "ok",
          detail: `running (ad-hoc, no pidfile) on :${port}`,
        };
      }
      return {
        check: `daemon-status[${p}]`,
        status: "ok",
        detail: `not running (port ${port})`,
      };
    }
    const healthy = await isHealthy(port);
    if (healthy) {
      return {
        check: `daemon-status[${p}]`,
        status: "ok",
        detail: `running pid=${(s as { pid?: number }).pid}, healthy`,
      };
    }
    // Running (pid alive) but not healthy → warn
    return {
      check: `daemon-status[${p}]`,
      status: "warn",
      detail: `running pid=${(s as { pid?: number }).pid}, not healthy on :${port}`,
      hint: "daemon may be starting up or stuck",
    };
  } catch (e) {
    return {
      check: `daemon-status[${p}]`,
      status: "fail",
      detail: String(e),
      hint: "failed to read daemon status",
    };
  }
}

async function checkPortOwner(p: Profile): Promise<CheckResult> {
  const port = portFor(p);
  try {
    const s = await status(p);
    // Check port health — covers both pid-managed and ad-hoc daemons
    const healthy = await isHealthy(port);
    if (healthy) {
      const pid = (s as { pid?: number }).pid;
      return {
        check: `port-owner[${p}]`,
        status: "ok",
        detail: pid
          ? `port ${port} owned by didraw pid=${pid}`
          : `port ${port} not checked (daemon ok)`,
      };
    }
    if (!s.running) {
      // No pidfile and port not responding — port is free
      return {
        check: `port-owner[${p}]`,
        status: "ok",
        detail: `port ${port} free`,
      };
    }
    // Running (pid alive) but not healthy: check who owns the port via lsof
    try {
      const out = execFileSync("lsof", ["-i", `:${port}`, "-P", "-n", "-F", "pcn"], {
        encoding: "utf8",
        timeout: 3000,
      });
      // parse lsof field output: p=pid, c=command, n=name
      const lines = out.split("\n");
      let pid: string | undefined;
      let cmd: string | undefined;
      for (const line of lines) {
        if (line.startsWith("p")) pid = line.slice(1);
        else if (line.startsWith("c")) cmd = line.slice(1);
      }
      if (pid) {
        return {
          check: `port-owner[${p}]`,
          status: "fail",
          detail: `port ${port} busy, not healthy`,
          hint: `port busy by foreign process: pid ${pid} (cmd ${cmd ?? "?"}), kill or change DIDRAW_PORT`,
        };
      }
    } catch (lsofErr: unknown) {
      const msg = String(lsofErr);
      if (msg.includes("ENOENT") || msg.includes("not found")) {
        return {
          check: `port-owner[${p}]`,
          status: "warn",
          detail: `port ${port} busy but not healthy; lsof not available`,
          hint: "lsof not available",
        };
      }
    }
    return {
      check: `port-owner[${p}]`,
      status: "warn",
      detail: `port ${port} busy but not healthy`,
    };
  } catch (e) {
    return {
      check: `port-owner[${p}]`,
      status: "warn",
      detail: `could not check port ${port}: ${String(e)}`,
    };
  }
}

function checkStorageWritable(p: Profile): CheckResult {
  // Mirror backend config.ts storageDir resolution
  const storageSubdir: Record<Profile, string> = {
    dev: "canvas-dev",
    release: "canvas",
    debug: "canvas",
  };
  const storageDir =
    process.env.DIDRAW_STORAGE_DIR ??
    join(
      homedir(),
      ".claude",
      "projects",
      // We don't have access to the full slug logic here easily; use a placeholder
      // by importing from the backend config if available, or just the base path.
      (() => {
        try {
          // best-effort: try to read DIDRAW_PROJECT_DIR
          const base =
            process.env.DIDRAW_PROJECT_DIR ??
            process.env.CLAUDE_PROJECT_DIR ??
            process.cwd();
          const b = basename(base.replace(/[\\/]+$/, "")) || base;
          const body = b
            .toLowerCase()
            .replace(/[\\/]+/g, "-")
            .replace(/[^a-z0-9_-]/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-+|-+$/g, "");
          const hash = createHash("sha1").update(base).digest("hex").slice(0, 8);
          return body ? `${body}-${hash}` : "default-project";
        } catch {
          return "default-project";
        }
      })(),
      storageSubdir[p],
    );

  const testFile = join(storageDir, `.didraw-doctor-probe-${Date.now()}`);
  try {
    mkdirSync(storageDir, { recursive: true });
    writeFileSync(testFile, "probe");
    rmSync(testFile);
    return {
      check: `storage-writable[${p}]`,
      status: "ok",
      detail: storageDir,
    };
  } catch (e) {
    return {
      check: `storage-writable[${p}]`,
      status: "fail",
      detail: storageDir,
      hint: `storage dir not writable: ${storageDir} — ${String(e)}`,
    };
  }
}

async function checkManifestReachable(): Promise<CheckResult> {
  const url = process.env.DIDRAW_MANIFEST_URL;
  if (!url) {
    return {
      check: "manifest-reachable",
      status: "warn",
      detail: "DIDRAW_MANIFEST_URL not set",
      hint: "set DIDRAW_MANIFEST_URL for update channel",
    };
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      return { check: "manifest-reachable", status: "ok", detail: url };
    }
    return {
      check: "manifest-reachable",
      status: "warn",
      detail: `HTTP ${res.status} from ${url}`,
      hint: "manifest URL returned non-2xx (corp proxy?)",
    };
  } catch {
    return {
      check: "manifest-reachable",
      status: "warn",
      detail: `unreachable: ${url}`,
      hint: "manifest URL unreachable (corp proxy?)",
    };
  }
}

function checkConfigReadable(): CheckResult {
  const path = join(homedir(), ".claude", ".didraw-config.json");
  if (!existsSync(path)) {
    return {
      check: "config-readable",
      status: "ok",
      detail: "no config file (uses defaults)",
    };
  }
  try {
    JSON.parse(readFileSync(path, "utf8"));
    return { check: "config-readable", status: "ok", detail: path };
  } catch {
    return {
      check: "config-readable",
      status: "fail",
      detail: path,
      hint: "invalid JSON in config file",
    };
  }
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export interface DoctorOptions {
  profile: Profile;
  all: boolean;
  json: boolean;
}

export async function cmdDoctor(opts: DoctorOptions): Promise<void> {
  const profiles: Profile[] = opts.all ? [...ALL_PROFILES] : [opts.profile];

  // Run all checks in parallel
  const results = await Promise.all([
    Promise.resolve(checkBunVersion()),
    Promise.resolve(checkDidrawVersion()),
    ...profiles.map((p) => checkDaemonStatus(p)),
    ...profiles.map((p) => checkPortOwner(p)),
    ...profiles.map((p) => Promise.resolve(checkStorageWritable(p))),
    checkManifestReachable(),
    Promise.resolve(checkConfigReadable()),
  ]);

  if (opts.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results) {
      const hint = r.hint ? ` (hint: ${r.hint})` : "";
      console.log(`[${r.status}] ${r.check}: ${r.detail}${hint}`);
    }
    const ok = results.filter((r) => r.status === "ok").length;
    const warn = results.filter((r) => r.status === "warn").length;
    const fail = results.filter((r) => r.status === "fail").length;
    console.log(`\n${ok} ok, ${warn} warn, ${fail} fail`);
  }

  const hasFail = results.some((r) => r.status === "fail");
  if (hasFail) process.exit(3);
}
