import { CanvasClient } from "@shemma/client";
import { fail } from "./util";

type Args = {
  room?: string;
  actor?: string;
  task?: string;
};

function parseArgs(argv: string[]): Args {
  const a: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--room") a.room = argv[++i];
    else if (k === "--actor") a.actor = argv[++i];
    else if (k === "--task") a.task = argv[++i];
  }
  return a;
}

export async function cmdAiStart(argv: string[]) {
  const a = parseArgs(argv);
  if (!a.actor || !a.task) {
    console.error(
      JSON.stringify({ ok: false, error: "expected --actor X --task Y" }),
    );
    process.exit(1);
  }
  const c = new CanvasClient({ room: a.room });
  try {
    console.log(JSON.stringify(await c.aiStart(a.actor, a.task)));
  } catch (e) {
    fail(e);
  }
}

export async function cmdAiStop(argv: string[]) {
  const a = parseArgs(argv);
  const c = new CanvasClient({ room: a.room });
  try {
    console.log(JSON.stringify(await c.aiStop()));
  } catch (e) {
    fail(e);
  }
}

export async function cmdAiStatus(argv: string[]) {
  const a = parseArgs(argv);
  const c = new CanvasClient({ room: a.room });
  try {
    console.log(JSON.stringify(await c.aiActivity()));
  } catch (e) {
    fail(e);
  }
}
