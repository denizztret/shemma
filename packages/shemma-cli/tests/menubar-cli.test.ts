// Smoke: render выдаёт валидное SwiftBar-меню независимо от состояния демона
// (детерминированные проверки — структура, а не конкретный статус).
// HOME уводим в tmpdir, чтобы не читать реальные ~/.claude state-файлы.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dir, "..", "src", "index.ts");

let tmpHome: string;

async function runCli(args: string[]): Promise<{
  status: number;
  stdout: string;
  stderr: string;
}> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: {
      ...(process.env as Record<string, string>),
      HOME: tmpHome,
      XDG_CONFIG_HOME: path.join(tmpHome, ".config"),
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
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "menubar-home-"));
  // Кеш update-badge кладём заранее свежим, чтобы render не ходил в сеть.
  fs.mkdirSync(path.join(tmpHome, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpHome, ".claude", ".shemma-menubar-update.json"),
    JSON.stringify({
      checkedAt: Date.now(),
      badge: { available: false, latest: null },
    }),
  );
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("shemma menubar render", () => {
  test("выдаёт валидную структуру меню и exit 0", async () => {
    const r = await runCli(["menubar", "render"]);
    expect(r.status).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines[0]).toContain("| image="); // title с иконкой
    expect(lines[1]).toBe("---");
    expect(r.stdout).toContain("Остановить всё");
    expect(r.stdout).toContain("Doctor:");
    expect(r.stdout).toContain("Изменить конфиг…");
  });

  test("zero-arg menubar = render", async () => {
    const r = await runCli(["menubar"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("| image=");
  });
});

describe("shemma menubar do", () => {
  test("без action — exit 1", async () => {
    const r = await runCli(["menubar", "do"]);
    expect(r.status).toBe(1);
  });
  test("неизвестный action — exit 1", async () => {
    const r = await runCli(["menubar", "do", "self-destruct"]);
    expect(r.status).toBe(1);
  });
});

describe("usage", () => {
  test("help упоминает menubar", async () => {
    const r = await runCli(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("menubar install");
    expect(r.stdout).toContain("menubar.label");
  });
});
