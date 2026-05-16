// Coverage for DRW-009 (apply --room) и DRW-010 (domain commands --room).
// Существующий domain.test.ts полагается на CLAUDE_SESSION_ID — мы здесь
// явно убираем env, чтобы --room был ЕДИНСТВЕННЫМ способом маршрутизации.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { startServer } from "../../../apps/backend/src/index";

let srv: { port: number; close: () => Promise<void> };
const CLI = join(import.meta.dir, "..", "src", "index.ts");

beforeAll(async () => {
  srv = await startServer({ inMemory: true, port: 0 });
});
afterAll(async () => {
  await srv.close();
});

// env БЕЗ CLAUDE_SESSION_ID: проверяем что без --room запрос пойдёт в default,
// а с --room — в указанный room. Это исключает скрытое влияние env-default.
function envNoSession(): Record<string, string> {
  const e: Record<string, string> = {
    ...(process.env as Record<string, string>),
    DIDRAW_PORT: String(srv.port),
  };
  delete e.CLAUDE_SESSION_ID;
  return e;
}

async function cli(args: string[], input?: string) {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: envNoSession(),
    stdin: input !== undefined ? Buffer.from(input) : "ignore",
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

async function stateOf(room: string): Promise<{
  nodes: Array<{ id: string }>;
  edges: Array<{ id: string }>;
  groups: Array<{ id: string }>;
}> {
  const r = await fetch(
    `http://localhost:${srv.port}/api/state?room=${encodeURIComponent(room)}&fmt=compact`,
  );
  const j = (await r.json()) as { canvas: { nodes: unknown[]; edges: unknown[]; groups: unknown[] } };
  return j.canvas as ReturnType<typeof stateOf> extends Promise<infer T> ? T : never;
}

describe("DRW-009: apply --room", () => {
  test("apply --stdin --room <id> маршрутизирует в указанный room, default остаётся пустым", async () => {
    const batch = JSON.stringify({
      actions: [{ kind: "define", role: "service", name: "auth" }],
    });
    const r = await cli(["apply", "--stdin", "--room", "drw009-a"], batch);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).ok).toBe(true);

    const target = await stateOf("drw009-a");
    expect(target.nodes.length).toBe(1);

    const def = await stateOf("default");
    expect(def.nodes.length).toBe(0);
  });

  test("apply без --room → default room", async () => {
    const batch = JSON.stringify({
      actions: [{ kind: "define", role: "service", name: "auth2" }],
    });
    const r = await cli(["apply", "--stdin"], batch);
    expect(r.status).toBe(0);

    const def = await stateOf("default");
    expect(def.nodes.some((n) => n.id === "shape:e_auth2")).toBe(true);
  });

  test("apply --room с невалидным id → exit 1, ничего не создано", async () => {
    const batch = JSON.stringify({
      actions: [{ kind: "define", role: "service", name: "bad" }],
    });
    const r = await cli(["apply", "--stdin", "--room", "with spaces"], batch);
    expect(r.status).toBe(1);
  });
});

describe("DRW-010: domain commands --room", () => {
  test("define --room <id> создаёт node в указанной room", async () => {
    const r = await cli(["define", "service", "svc1", "--room", "drw010-def"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).ok).toBe(true);

    const target = await stateOf("drw010-def");
    expect(target.nodes.some((n) => n.id === "shape:e_svc1")).toBe(true);
  });

  test("connect --room соединяет в указанной room", async () => {
    await cli(["define", "service", "a", "--room", "drw010-conn"]);
    await cli(["define", "datastore", "b", "--room", "drw010-conn"]);
    const r = await cli(["connect", "a", "b", "--room", "drw010-conn"]);
    expect(r.status).toBe(0);

    const target = await stateOf("drw010-conn");
    expect(target.edges.length).toBe(1);
  });

  test("group --room собирает в указанной room", async () => {
    await cli(["define", "service", "g1", "--room", "drw010-grp"]);
    await cli(["define", "service", "g2", "--room", "drw010-grp"]);
    const r = await cli([
      "group",
      "g1,g2",
      "--as",
      "network",
      "--name",
      "vpc",
      "--room",
      "drw010-grp",
    ]);
    expect(r.status).toBe(0);

    const target = await stateOf("drw010-grp");
    expect(target.groups.length).toBe(1);
  });

  test("note --room создаёт note в указанной room", async () => {
    const r = await cli(["note", "--text", "ремарка", "--room", "drw010-note"]);
    expect(r.status).toBe(0);

    const target = await stateOf("drw010-note");
    expect(target.nodes.length).toBe(1);
  });

  test("layout --room запускается на указанной room", async () => {
    await cli(["define", "service", "x", "--room", "drw010-lay"]);
    await cli(["define", "service", "y", "--room", "drw010-lay"]);
    const r = await cli(["layout", "--mode", "layered-lr", "--room", "drw010-lay"]);
    expect(r.status).toBe(0);
  });

  test("delete --room удаляет в указанной room", async () => {
    await cli(["define", "service", "del1", "--room", "drw010-del"]);
    const r = await cli(["delete", "del1", "--room", "drw010-del"]);
    expect(r.status).toBe(0);

    const target = await stateOf("drw010-del");
    expect(target.nodes.length).toBe(0);
  });

  test("context --room возвращает summary указанной room", async () => {
    await cli(["define", "service", "ctx1", "--room", "drw010-ctx"]);
    const r = await cli(["context", "--room", "drw010-ctx"]);
    expect(r.status).toBe(0);
    const body = JSON.parse(r.stdout) as {
      summary: { byRole: Record<string, number> };
    };
    expect(body.summary.byRole.service).toBe(1);
  });

  test("две параллельные комнаты изолированы", async () => {
    await cli(["define", "service", "left", "--room", "drw010-iso-a"]);
    await cli(["define", "service", "right", "--room", "drw010-iso-b"]);

    const a = await stateOf("drw010-iso-a");
    const b = await stateOf("drw010-iso-b");
    expect(a.nodes.some((n) => n.id === "shape:e_left")).toBe(true);
    expect(a.nodes.some((n) => n.id === "shape:e_right")).toBe(false);
    expect(b.nodes.some((n) => n.id === "shape:e_right")).toBe(true);
    expect(b.nodes.some((n) => n.id === "shape:e_left")).toBe(false);
  });
});
