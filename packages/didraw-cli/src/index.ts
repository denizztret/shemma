#!/usr/bin/env bun
import { ensure, start, status, stop } from "./daemon";
import { exportRoom, list, open, rmRoom } from "./lifecycle";
import { applyProfile, parseProfile } from "./profile";

const argv = process.argv.slice(2);
const profile = parseProfile(argv);
applyProfile(profile);

const cmd = argv[0];
const sub = argv[1];

async function main() {
  if (cmd === "internal-server") {
    const { startServer } = await import("@didraw/backend/src/index");
    const { getConfig } = await import("@didraw/backend/src/config");
    const c = getConfig();
    const srv = await startServer({ port: c.port });
    console.log(`[didraw] listening on :${srv.port} (profile=${c.profile})`);
    await new Promise(() => {});
    return;
  }

  if (cmd === "daemon") {
    if (sub === "start") return start(profile);
    if (sub === "stop") return stop(profile);
    if (sub === "status")
      return console.log(JSON.stringify(await status(profile), null, 2));
    if (sub === "ensure" || sub === "--ensure") return ensure(profile);
    usage();
    process.exit(1);
  }
  if (cmd === "open") {
    if (!argv[1]) {
      usage();
      process.exit(1);
    }
    return open(argv[1], profile);
  }
  if (cmd === "list") return list();
  if (cmd === "export") {
    const [, room, flag, to] = argv;
    if (!room || flag !== "--to" || !to) {
      usage();
      process.exit(1);
    }
    return exportRoom(room, to);
  }
  if (cmd === "rm") {
    if (!argv[1]) {
      usage();
      process.exit(1);
    }
    return rmRoom(argv[1]);
  }
  usage();
  process.exit(cmd ? 1 : 0);
}

function usage() {
  console.log(`didraw <command> [--profile dev|release|debug]

Lifecycle:
  daemon start|stop|status|ensure
  open <room>
  list
  export <room> --to <path>
  rm <room>

Data:
  state    --room <id> [--compact] [--since <v>]
  patch    --room <id> --stdin
  import   mermaid --room <id> --stdin | --file <path>
  layout   --room <id> --algorithm elk-layered [--node-ids <id,...>]
  prompts  list --room <id> [--status pending|resolved|dismissed|all]
  prompts  resolve <id> --room <id> [--response <text>]
  prompts  dismiss <id> --room <id>
  clear    --room <id> --confirm

Versioning:
  version
  update [--check] [--channel stable|nightly|dev]

(internal-server: private subcommand used by daemon self-spawn)
`);
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: String(e) }));
  process.exit(1);
});
