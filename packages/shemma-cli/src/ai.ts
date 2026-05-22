import { CanvasClient } from "@shemma/client";
import { fail } from "./util";
import {
  error as uiError,
  getOutput,
  printResponse,
  responseHasError,
} from "./ui";

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

function emit(res: unknown, humanSuccess: string): void {
  const ui = getOutput();
  if (ui.mode === "json") {
    process.stdout.write(JSON.stringify(res) + "\n");
  } else {
    printResponse(res, { humanSuccess });
  }
  if (responseHasError(res)) process.exit(1);
}

// DRW-131: thread top-level --space so ai/* commands hit the right space.
function clientFor(room: string | undefined, space: string | undefined): CanvasClient {
  return new CanvasClient({
    ...(room !== undefined ? { room } : {}),
    ...(space !== undefined ? { space } : {}),
  });
}

export async function cmdAiStart(argv: string[], space?: string) {
  const a = parseArgs(argv);
  if (!a.actor || !a.task) {
    uiError("expected --actor X --task Y", { code: "expected --actor X --task Y" });
    process.exit(1);
  }
  const c = clientFor(a.room, space);
  try {
    emit(await c.aiStart(a.actor, a.task), `ai started (actor=${a.actor})`);
  } catch (e) {
    fail(e);
  }
}

export async function cmdAiStop(argv: string[], space?: string) {
  const a = parseArgs(argv);
  const c = clientFor(a.room, space);
  try {
    emit(await c.aiStop(), "ai stopped");
  } catch (e) {
    fail(e);
  }
}

export async function cmdAiStatus(argv: string[], space?: string) {
  const a = parseArgs(argv);
  const c = clientFor(a.room, space);
  try {
    emit(await c.aiActivity(), "ai status fetched");
  } catch (e) {
    fail(e);
  }
}
