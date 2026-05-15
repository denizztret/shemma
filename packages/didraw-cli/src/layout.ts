import { CanvasClient } from "@didraw/client";

export async function cmdLayout(argv: string[]) {
  let room: string | undefined;
  let algorithm: "elk-layered" | "dagre" = "elk-layered";
  let nodeIds: string[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--room") room = argv[++i];
    else if (argv[i] === "--algorithm")
      algorithm = argv[++i] as "elk-layered" | "dagre";
    else if (argv[i] === "--node-ids") nodeIds = argv[++i].split(",");
  }
  const c = new CanvasClient({ room });
  try {
    const r = await c.layout(algorithm, nodeIds);
    console.log(JSON.stringify(r));
    if (r.ok === false) process.exit(1);
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: String(e) }));
    process.exit(1);
  }
}
