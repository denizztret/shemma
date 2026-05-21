/**
 * DRW-116 — End-to-end smoke matrix (Task 32).
 *
 * Smoke-coverage поверх focused unit/integration тестов: один консолидирующий
 * E2E-сценарий, который проходит полный happy-path жизненный цикл spaces через
 * CLI без поднятия настоящего daemon-а (--no-daemon / s list / s forget /
 * s prune). Гарантирует, что несколько CLI-инвокаций последовательно читают и
 * пишут одну и ту же `spaces.json` под isolated XDG_CONFIG_HOME.
 *
 * Что НЕ дублирует — каждый из 8 пунктов плана покрыт точечным тестом:
 *   - Scenario 1 (fresh `shemma <path>`)     → cli-top-level-path.test.ts
 *   - Scenario 2 (daemon reuse)              → daemon-lock.test.ts
 *   - Scenario 3 (multi → ?cols=)            → cli-top-level-path.test.ts
 *   - Scenario 4 (MCP CWD → space)           → src/mcp.test.ts + migration-mcp-fallback.test.ts
 *   - Scenario 5 (legacy migration)          → apps/backend/src/migration/__tests__/legacy-spaces.test.ts
 *   - Scenario 6 (SHEMMA_SKIP_LEGACY_MIGRATION) → same legacy-spaces.test.ts
 *   - Scenario 7 (--storage deprecation)     → cli-deprecation.test.ts
 *   - Scenario 8 (WS multi-space isolation)  → apps/backend/tests/ws-multi-space.test.ts
 *
 * Browser-driven verification (split-column drag, SpacesPage UI и т.д.) описан
 * в `docs/manual-tests/drw-116-global-daemon-spaces.md`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dir, "..", "src", "index.ts");

let tmpXdg: string;

async function runCli(args: string[]): Promise<{
  status: number;
  stdout: string;
  stderr: string;
}> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: {
      ...(process.env as Record<string, string>),
      XDG_CONFIG_HOME: tmpXdg,
    },
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

beforeEach(() => {
  tmpXdg = fs.mkdtempSync(path.join(os.tmpdir(), "drw-116-smoke-"));
});

afterEach(() => {
  fs.rmSync(tmpXdg, { recursive: true, force: true });
});

describe("DRW-116 smoke matrix — full spaces lifecycle through CLI", () => {
  test("fresh registry → register two spaces → list → forget one → prune orphan", async () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-a-"));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-b-"));
    try {
      // 1. Fresh state: registry doesn't exist yet.
      const initial = await runCli(["s", "list", "--json"]);
      expect(initial.status).toBe(0);
      expect(JSON.parse(initial.stdout).spaces).toEqual([]);

      // 2. Register two paths via the top-level positional entry (mirrors
      //    `shemma /a /b` user flow). --no-daemon skips browser + daemon spawn.
      const register = await runCli([a, b, "--no-daemon"]);
      expect(register.status).toBe(0);
      const registerMatches = register.stdout.match(/registered:/g);
      expect(registerMatches?.length).toBe(2);
      expect(register.stdout).toMatch(/URL: http:\/\/localhost:\d+\/\?cols=/);

      // 3. spaces.json persists across CLI invocations.
      const afterRegister = await runCli(["s", "list", "--json"]);
      const parsed = JSON.parse(afterRegister.stdout) as {
        spaces: Array<{ id: string; path: string; storageLayout: string }>;
      };
      expect(parsed.spaces).toHaveLength(2);
      // Both spaces resolved to absolute realpaths (macOS /private prefix tolerated).
      for (const sp of parsed.spaces) {
        expect(path.isAbsolute(sp.path)).toBe(true);
        expect(sp.storageLayout).toBe("project");
      }

      // 4. Forget one space (the one registered for `a`) → list reflects removal.
      //    Listing is ordered by lastUsedAt desc — find the entry that maps
      //    to `a` rather than relying on positional order.
      const realA = fs.realpathSync(a);
      const aEntry = parsed.spaces.find((s) => s.path === realA);
      if (!aEntry) throw new Error(`no registered space matched path ${realA}`);
      const forget = await runCli(["s", "forget", aEntry.id]);
      expect(forget.status).toBe(0);
      expect(forget.stdout).toContain("forgotten:");
      const afterForget = await runCli(["s", "list", "--json"]);
      const remaining = JSON.parse(afterForget.stdout).spaces as Array<{
        path: string;
      }>;
      expect(remaining).toHaveLength(1);
      expect(remaining[0].path).toBe(fs.realpathSync(b));

      // 5. Remove remaining space's path on disk → prune detects orphan.
      fs.rmSync(b, { recursive: true, force: true });
      const dry = await runCli(["s", "prune", "--dry-run"]);
      expect(dry.status).toBe(0);
      expect(dry.stdout).toContain("Found 1 orphan");
      // --dry-run doesn't mutate registry.
      const afterDry = await runCli(["s", "list", "--json"]);
      expect(JSON.parse(afterDry.stdout).spaces).toHaveLength(1);

      // 6. Confirm prune.
      const prune = await runCli(["s", "prune", "--yes"]);
      expect(prune.status).toBe(0);
      expect(prune.stdout).toContain("Pruned 1 space");
      const afterPrune = await runCli(["s", "list", "--json"]);
      expect(JSON.parse(afterPrune.stdout).spaces).toEqual([]);
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });

  test("registry file lives under XDG_CONFIG_HOME (isolation works)", async () => {
    // Sanity-check that XDG_CONFIG_HOME really isolates the registry — otherwise
    // tests above could be contaminated by the user's real `~/.config/shemma/`.
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-iso-"));
    try {
      await runCli(["s", "add", proj]);
      const registryPath = path.join(tmpXdg, "shemma", "spaces.json");
      expect(fs.existsSync(registryPath)).toBe(true);
      const raw = JSON.parse(fs.readFileSync(registryPath, "utf-8")) as {
        schemaVersion: number;
        spaces: Array<{ path: string }>;
      };
      expect(raw.schemaVersion).toBeGreaterThanOrEqual(1);
      expect(raw.spaces).toHaveLength(1);
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });
});
