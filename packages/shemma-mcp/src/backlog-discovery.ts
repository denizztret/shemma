import type { InProgressTask } from "./room-resolver";

export type DiscoveryOpts = {
  env: Record<string, string | undefined>;
  runBacklog: (args: string[]) => Promise<string>;
};

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/^\s+|\s+$/g, "")
    .replace(/[^a-z0-9а-яё.-]+/giu, "-")
    .replace(/^-+|-+$/g, "");
}

function parseBacklogPlainLine(line: string): InProgressTask | null {
  // Format: "DRW-054 - <title> (<priority>)" — first dash-separated token is id, then title.
  const m = line.match(/^([A-Z]+-\d+)\s+-\s+(.+?)(?:\s+\((?:high|medium|low)\))?\s*$/i);
  if (!m) return null;
  const id = m[1];
  const title = m[2];
  return { id, slug: `${id.toLowerCase()}-${slugify(title)}` };
}

export async function discoverInProgressTasks(opts: DiscoveryOpts): Promise<InProgressTask[]> {
  const env = opts.env.SHEMMA_TASK_ID;
  if (env) return [{ id: env, slug: env.toLowerCase() }];
  let raw: string;
  try {
    raw = await opts.runBacklog(["task", "list", "--plain", "--status", "In Progress"]);
  } catch {
    return [];
  }
  const tasks: InProgressTask[] = [];
  for (const line of raw.split("\n")) {
    const parsed = parseBacklogPlainLine(line);
    if (parsed) tasks.push(parsed);
  }
  return tasks;
}

/** Default subprocess runner; can be replaced in tests. */
export async function runBacklogCli(args: string[]): Promise<string> {
  const proc = Bun.spawn(["backlog", ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const exit = await proc.exited;
  if (exit !== 0) throw new Error(`backlog exited ${exit}`);
  return out;
}
