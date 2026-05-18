/**
 * DRW-060: `ensureDaemon` fast-path fallback.
 *
 * Root cause:
 *   `src/index.ts` populates `process.env.SHEMMA_PORT = portFor(profile)` for
 *   every CLI invocation so internal CanvasClient calls hit the right daemon.
 *   The fast path in `ensureDaemon` treated *any* SHEMMA_PORT as "externally
 *   set, just verify health, exit(3) if not". After `shemma update` swapped
 *   the binary, the flow `stop(profile)` → `ensure(profile)` blew up on the
 *   second step: SHEMMA_PORT was still set (auto-set by index.ts), daemon was
 *   freshly stopped → unhealthy → exit(3) instead of spawning the new binary.
 *
 * Fix:
 *   - `SHEMMA_PORT_AUTOSET=1` marker distinguishes "we set it" vs "caller set
 *     it" (tests/test-fixtures); fast path triggers only when marker is absent.
 *   - `cmdUpdate` explicitly clears both env vars before `ensure()`.
 *
 * Black-box subprocess tests below verify the marker semantics via
 * `shemma daemon ensure`:
 *   1. SHEMMA_PORT externally set, server healthy → fast-path OK
 *   2. SHEMMA_PORT externally set, server NOT healthy → fast-path exits 3
 *   3. SHEMMA_PORT auto-set (no caller override), daemon running on profile
 *      port → ensureDaemon goes through `status()` and reports success
 *      (NOT through fast path).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "index.ts");

function pidFileFor(profile: string): string {
  return join(homedir(), ".claude", `.shemma-${profile}.pid`);
}

async function cli(
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const mergedEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") mergedEnv[k] = v;
  }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete mergedEnv[k];
    else mergedEnv[k] = v;
  }
  const proc = Bun.spawn(["bun", CLI, "--json", ...args], {
    env: mergedEnv,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { status, stdout, stderr };
}

describe("ensureDaemon fast-path: SHEMMA_PORT externally set", () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  let port = 0;

  beforeEach(() => {
    // In-process Bun.serve mimicking a healthy daemon. `isHealthy` calls
    // CanvasClient.health() which hits `/healthz`; the extended /api/health
    // probe is unused on the fast path.
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/healthz") {
          return new Response("ok");
        }
        return new Response("nope", { status: 404 });
      },
    });
    port = server.port;
  });

  afterEach(() => {
    server?.stop(true);
    server = null;
  });

  test("externally set SHEMMA_PORT + healthy → fast-path returns success", async () => {
    const r = await cli(["daemon", "ensure", "--profile", "dev"], {
      SHEMMA_PORT: String(port),
      // Explicit clear: in case the test runner inherited the marker from a
      // parent CLI invocation (CI matrix runs), we must guarantee the marker
      // is absent to assert "externally set" semantics.
      SHEMMA_PORT_AUTOSET: undefined,
    });
    if (r.status !== 0) {
      console.error("stdout:", r.stdout);
      console.error("stderr:", r.stderr);
    }
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.ok).toBe(true);
    expect(j.already).toBe(true);
    expect(j.port).toBe(port);
  });

  test("externally set SHEMMA_PORT + unhealthy → fast-path exits 3", async () => {
    server?.stop(true); // kill before the CLI tries to hit it
    server = null;
    const deadPort = port; // same port, but no listener
    const r = await cli(["daemon", "ensure", "--profile", "dev"], {
      SHEMMA_PORT: String(deadPort),
    });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("not healthy");
  });
});

describe("ensureDaemon fast-path: SHEMMA_PORT_AUTOSET marker bypasses fast path", () => {
  // Stale pid-file scenario: previous daemon stopped, .pid file unlinked.
  // Auto-set SHEMMA_PORT (no external override) must NOT short-circuit to
  // exit(3) on health failure — instead it should fall through to status()
  // and try to start. We can't fully simulate "start succeeds" in a unit
  // test (would spawn a real daemon), but we can verify the fast path is
  // skipped: `daemon ensure` with auto-set SHEMMA_PORT against a missing
  // pid-file should NOT print "SHEMMA_PORT is set but server not healthy".
  //
  // We pick an obscure profile port (release / 8787) but ensure no pid file
  // exists. The CLI will try to start() a real daemon — to keep the test
  // fast and side-effect-free we don't actually want that. Strategy: prove
  // it via stderr signature instead — when fast path is skipped, the error
  // message changes to "not healthy within 5s on :<port>" (from start path)
  // and would take 5s. To avoid that wait, we simply assert that the
  // fast-path-specific signature is NOT present after a short timeout.
  //
  // Trade-off: this is a probe, not a full integration. Real-world fix is
  // covered by the manual smoke test in DRW-060 verification (stop + ensure
  // in quick succession in cmdUpdate).

  test("auto-set SHEMMA_PORT does NOT short-circuit when daemon is healthy on profile port", async () => {
    // Stand up a healthy /healthz on a random port, then drive `daemon ensure`
    // with SHEMMA_PORT pointing at it AND SHEMMA_PORT_AUTOSET=1. The marker
    // signals "index.ts auto-set this — fast path doesn't apply". ensureDaemon
    // must NOT emit the fast-path error and must NOT exit 3; it should fall
    // through to status() which finds no pid file (we don't seed one) and
    // proceed to start(). Since start() would actually spawn a daemon —
    // unsafe in tests — we deliberately pick a profile/pid file that already
    // looks "running" via the in-process server.
    //
    // Approach: seed a fake pid file pointing at this process (always alive),
    // so `status()` sees running=true, calls isHealthy() on our stub port,
    // and returns success without spawning anything.
    const stub = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/healthz") return new Response("ok");
        return new Response("nope", { status: 404 });
      },
    });

    // Use the `debug` profile so we don't clobber a real running dev/release
    // pid file the developer may have.
    const pidPath = pidFileFor("debug");
    const hadExisting = existsSync(pidPath);
    let savedPid: string | null = null;
    if (hadExisting) {
      savedPid = await Bun.file(pidPath).text();
    }

    try {
      writeFileSync(pidPath, String(process.pid));

      const r = await cli(["daemon", "ensure", "--profile", "debug"], {
        SHEMMA_PORT: String(stub.port),
        SHEMMA_PORT_AUTOSET: "1",
      });

      // Fast-path-specific error MUST NOT appear: that's the DRW-060
      // regression signature.
      expect(r.stderr).not.toContain("SHEMMA_PORT is set but server not healthy");
      expect(r.status).toBe(0);
      const j = JSON.parse(r.stdout);
      expect(j.ok).toBe(true);
      // status path returns full {running, pid, profile, port}, not the
      // fast-path {already, profile, port} only.
      expect(j.pid).toBe(process.pid);
    } finally {
      stub.stop(true);
      // Restore previous pid file state.
      try { unlinkSync(pidPath); } catch {}
      if (savedPid !== null) writeFileSync(pidPath, savedPid);
    }
  });
});
