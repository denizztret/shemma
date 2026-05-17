import { CanvasClient } from "@shemma/client";
import { fail } from "./util";

const VALID_STATUSES = ["pending", "resolved", "dismissed", "all"] as const;
type Status = (typeof VALID_STATUSES)[number];

function isStatus(v: unknown): v is Status {
  return (
    typeof v === "string" && (VALID_STATUSES as readonly string[]).includes(v)
  );
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
        console.error(
          JSON.stringify({
            ok: false,
            error: `invalid --status: ${v}. Expected one of: ${VALID_STATUSES.join("|")}`,
          }),
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
      console.log(JSON.stringify(await c.getPrompts(status ?? "pending")));
    } else if (sub === "resolve") {
      if (!id) throw new Error("missing id");
      console.log(JSON.stringify(await c.resolvePrompt(id, response)));
    } else if (sub === "dismiss") {
      if (!id) throw new Error("missing id");
      console.log(JSON.stringify(await c.dismissPrompt(id)));
    } else if (sub === "delete") {
      if (!id) throw new Error("missing id");
      console.log(JSON.stringify(await c.deletePrompt(id)));
    } else if (sub === "purge") {
      console.log(JSON.stringify(await c.purgePrompts()));
    } else {
      console.error(
        JSON.stringify({
          ok: false,
          error: `unknown prompts subcommand: ${sub}`,
        }),
      );
      process.exit(1);
    }
  } catch (e) {
    fail(e);
  }
}
