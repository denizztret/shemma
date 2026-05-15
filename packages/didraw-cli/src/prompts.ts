import { CanvasClient } from "@didraw/client";

type Status = "pending" | "resolved" | "dismissed" | "all";

export async function cmdPrompts(argv: string[]) {
  const sub = argv[0];
  const rest = argv.slice(1);
  let room: string | undefined;
  let status: Status | undefined;
  let response: string | undefined;
  let id: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--room") room = rest[++i];
    else if (rest[i] === "--status") status = rest[++i] as Status;
    else if (rest[i] === "--response") response = rest[++i];
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
    console.error(JSON.stringify({ ok: false, error: String(e) }));
    process.exit(1);
  }
}
