import { CanvasClient } from "@shemma/client";
import { fail } from "./util";
import { error as uiError, getOutput, printResponse } from "./ui";

const VALID_STATUSES = ["pending", "resolved", "dismissed", "all"] as const;
type Status = (typeof VALID_STATUSES)[number];

function isStatus(v: unknown): v is Status {
  return (
    typeof v === "string" && (VALID_STATUSES as readonly string[]).includes(v)
  );
}

function emit(res: unknown, humanSuccess: string): void {
  const ui = getOutput();
  if (ui.mode === "json") {
    process.stdout.write(JSON.stringify(res) + "\n");
  } else {
    printResponse(res, { humanSuccess });
  }
}

export async function cmdPrompts(argv: string[]) {
  const sub = argv[0];
  const rest = argv.slice(1);
  let room: string | undefined;
  let status: Status | undefined;
  let response: string | undefined;
  let id: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--room") room = rest[++i];
    else if (rest[i] === "--status") {
      const v = rest[++i];
      if (!isStatus(v)) {
        uiError(
          `invalid --status: ${v}. Expected one of: ${VALID_STATUSES.join("|")}`,
          { code: `invalid --status: ${v}` },
        );
        process.exit(1);
      }
      status = v;
    } else if (rest[i] === "--response") response = rest[++i];
    else if (!id && !rest[i].startsWith("--")) id = rest[i];
  }
  const c = new CanvasClient({ room });
  try {
    if (sub === "list") {
      emit(await c.getPrompts(status ?? "pending"), "prompts listed");
    } else if (sub === "resolve") {
      if (!id) throw new Error("missing id");
      emit(await c.resolvePrompt(id, response), `prompt ${id} resolved`);
    } else if (sub === "dismiss") {
      if (!id) throw new Error("missing id");
      emit(await c.dismissPrompt(id), `prompt ${id} dismissed`);
    } else if (sub === "delete") {
      if (!id) throw new Error("missing id");
      emit(await c.deletePrompt(id), `prompt ${id} deleted`);
    } else if (sub === "purge") {
      emit(await c.purgePrompts(), "prompts purged");
    } else {
      uiError(`unknown prompts subcommand: ${sub}`, {
        code: `unknown prompts subcommand: ${sub}`,
      });
      process.exit(1);
    }
  } catch (e) {
    fail(e);
  }
}
