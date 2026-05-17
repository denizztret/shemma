import { CanvasClient } from "@shemma/client";
import { fail } from "./util";

type Args = {
  room?: string;
  compact?: boolean;
  since?: number;
  confirm?: boolean;
};

export function parseArgs(argv: string[]): Args {
  const a: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--room") a.room = argv[++i];
    else if (k === "--compact") a.compact = true;
    else if (k === "--since") a.since = Number(argv[++i]);
    else if (k === "--confirm") a.confirm = true;
  }
  return a;
}

export async function cmdState(argv: string[]) {
  const a = parseArgs(argv);
  const c = new CanvasClient({ room: a.room });
  try {
    const r = await c.getState({
      fmt: a.compact ? "compact" : "full",
      since: a.since,
    });
    console.log(JSON.stringify(r));
  } catch (e) {
    fail(e);
  }
}

export async function cmdPatch(argv: string[]) {
  const a = parseArgs(argv);
  if (!argv.includes("--stdin")) {
    console.error(JSON.stringify({ ok: false, error: "expected --stdin" }));
    process.exit(1);
  }
  const raw = await readStdin();
  // biome-ignore lint/suspicious/noExplicitAny: dynamic stdin body
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    console.error(
      JSON.stringify({ ok: false, error: "invalid JSON on stdin" }),
    );
    process.exit(1);
  }
  const c = new CanvasClient({ room: a.room });
  try {
    const r = await c.applyPatch(body.ops, {
      source: body.source ?? "ai",
      clientOpId: body.clientOpId,
    });
    console.log(JSON.stringify(r));
    if (r.ok === false) process.exit(1);
  } catch (e) {
    fail(e);
  }
}

export async function cmdClear(argv: string[]) {
  const a = parseArgs(argv);
  if (!a.confirm) {
    console.error(JSON.stringify({ ok: false, error: "expected --confirm" }));
    process.exit(1);
  }
  const c = new CanvasClient({ room: a.room });
  try {
    console.log(JSON.stringify(await c.clear()));
  } catch (e) {
    fail(e);
  }
}

async function readStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) data += String(chunk);
  return data;
}
