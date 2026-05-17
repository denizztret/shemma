import { CanvasClient } from "@shemma/client";
import { fail } from "./util";
import { error as uiError, getOutput, printResponse } from "./ui";

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
    // state is always raw JSON — human mode can't usefully summarize the full
    // TLStoreSnapshot. Emit as JSON in both modes for backward compat (existing
    // tests parse stdout). Use stdout directly to avoid prefix symbols.
    process.stdout.write(JSON.stringify(r) + "\n");
  } catch (e) {
    fail(e);
  }
}

export async function cmdPatch(argv: string[]) {
  const a = parseArgs(argv);
  if (!argv.includes("--stdin")) {
    uiError("expected --stdin", { code: "expected --stdin" });
    process.exit(1);
  }
  const raw = await readStdin();
  // biome-ignore lint/suspicious/noExplicitAny: dynamic stdin body
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    uiError("invalid JSON on stdin", { code: "invalid JSON on stdin" });
    process.exit(1);
  }
  const c = new CanvasClient({ room: a.room });
  try {
    const r = await c.applyPatch(body.ops, {
      source: body.source ?? "ai",
      clientOpId: body.clientOpId,
    });
    const ui = getOutput();
    if (ui.mode === "json") {
      process.stdout.write(JSON.stringify(r) + "\n");
    } else {
      printResponse(r, { humanSuccess: "patch applied" });
    }
    if (r.ok === false) process.exit(1);
  } catch (e) {
    fail(e);
  }
}

export async function cmdClear(argv: string[]) {
  const a = parseArgs(argv);
  if (!a.confirm) {
    uiError("expected --confirm", { code: "expected --confirm" });
    process.exit(1);
  }
  const c = new CanvasClient({ room: a.room });
  try {
    const r = await c.clear();
    const ui = getOutput();
    if (ui.mode === "json") {
      process.stdout.write(JSON.stringify(r) + "\n");
    } else {
      printResponse(r, { humanSuccess: "room cleared" });
    }
  } catch (e) {
    fail(e);
  }
}

async function readStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) data += String(chunk);
  return data;
}
