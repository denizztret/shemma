import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "index.ts");

// DRW-123: isolate registry writes from the user's real ~/.config/shemma.
let xdg: string;
beforeAll(() => {
  xdg = mkdtempSync(join(tmpdir(), "shemma-daemon-storage-xdg-"));
});
afterAll(() => {
  rmSync(xdg, { recursive: true, force: true });
});

async function runCli(
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const mergedEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") mergedEnv[k] = v;
  }
  mergedEnv.XDG_CONFIG_HOME = xdg;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete mergedEnv[k];
    else mergedEnv[k] = v;
  }
  // Group A (DRW-056): default output is friendly; tests opt-in to --json.
  const proc = Bun.spawn(["bun", CLI, "--json", ...args], {
    env: mergedEnv,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { status: exitCode, stdout, stderr };
}

describe("shemma daemon start --storage (argv parsing & validation)", () => {
  test("rejects --storage without value (exit 1, JSON error)", async () => {
    const r = await runCli(["daemon", "start", "--storage"]);
    expect(r.status).toBe(1);
    const j = JSON.parse(r.stderr.trim());
    expect(j.ok).toBe(false);
    expect(j.error).toContain("--storage requires");
  });

  test("rejects --storage where next token is a flag (exit 1)", async () => {
    const r = await runCli([
      "daemon",
      "start",
      "--storage",
      "--profile",
      "dev",
    ]);
    expect(r.status).toBe(1);
    const j = JSON.parse(r.stderr.trim());
    expect(j.ok).toBe(false);
    expect(j.error).toContain("--storage requires");
  });

  test("rejects uncreatable storage path (exit 1)", async () => {
    // /dev/null/x — устройство, нельзя создать subdir
    const r = await runCli([
      "daemon",
      "start",
      "--storage",
      "/dev/null/cannot-create-here",
    ]);
    expect(r.status).toBe(1);
    const j = JSON.parse(r.stderr.trim());
    expect(j.ok).toBe(false);
    expect(j.error).toContain("cannot create storage dir");
  });

  test("creates dir + profile subdir when --storage valid (no real daemon spawn)", async () => {
    // Идемпотентно: даже если daemon уже запущен (already=true), mkdir всё равно сработает.
    const base = mkdtempSync(join(tmpdir(), "shemma-cli-storage-"));
    try {
      // Используем SHEMMA_PORT с занятым/неважным значением и --profile debug
      // чтобы избежать конфликта с реальным release daemon юзера.
      // Не проверяем успешный spawn — нам важно только что mkdir срабатывает
      // и CLI не падает на --storage. Любой network/PID issue выводится
      // в stdout, но exit code должен быть 0 (start() сам печатает результат).
      //
      // Подход: запускаем с --storage <tmp>, статусы daemon-а не валидируем,
      // но проверяем что папка <tmp>/canvas-dev создана.
      await runCli(
        ["daemon", "start", "--profile", "dev", "--storage", base],
        // SHEMMA_PORT pinned to a port we don't expect to clash; if it does,
        // daemon already="already running" — but mkdir уже произошёл.
        { SHEMMA_PORT: "59999" },
      );
      const { statSync } = await import("node:fs");
      const subdir = join(base, "canvas-dev");
      // Папка должна быть создана даже если spawn failed
      expect(statSync(subdir).isDirectory()).toBe(true);
    } finally {
      // На всякий случай — убьём daemon если успел стартануть на :59999.
      await runCli(["daemon", "stop", "--profile", "dev"], {
        SHEMMA_PORT: "59999",
      }).catch(() => {});
      rmSync(base, { recursive: true, force: true });
    }
  });
});
