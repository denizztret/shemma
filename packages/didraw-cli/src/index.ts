#!/usr/bin/env bun
import { cmdAiStart, cmdAiStatus, cmdAiStop } from "./ai";
import { ensure, start, status, stop } from "./daemon";
import { cmdClear, cmdPatch, cmdState } from "./data";
import { cmdLayout } from "./layout";
import {
  archiveRoom,
  exportRoom,
  importRoom,
  list,
  open,
  restoreRoom,
  rmRoom,
} from "./lifecycle";
import { applyProfile, parseProfile, portFor } from "./profile";
import { cmdPrompts } from "./prompts";
import { cmdUpdate, cmdUpdateCheck, cmdUpdateSetChannel } from "./update";
import { cmdVersion } from "./version-cmd";

const rawArgv = process.argv.slice(2);
const profile = parseProfile(rawArgv);
applyProfile(profile);
// Resolve --profile → DIDRAW_PORT so any CanvasClient (data/prompts/layout/version) hits the right daemon.
// Explicit DIDRAW_PORT is honoured if already set (portFor checks env first).
process.env.DIDRAW_PORT ??= String(portFor(profile));
// Strip --profile <value> here so per-command parsers don't need to know about it.
const argv = stripProfileFlag(rawArgv);

function stripProfileFlag(a: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--profile") {
      i++; // skip value
      continue;
    }
    out.push(a[i]);
  }
  return out;
}

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

  if (cmd === "state") return cmdState(argv.slice(1));
  if (cmd === "patch") return cmdPatch(argv.slice(1));
  if (cmd === "clear") return cmdClear(argv.slice(1));
  if (cmd === "layout") return cmdLayout(argv.slice(1));
  if (cmd === "prompts") return cmdPrompts(argv.slice(1));
  if (cmd === "ai") {
    if (sub === "start") return cmdAiStart(argv.slice(2));
    if (sub === "stop") return cmdAiStop(argv.slice(2));
    if (sub === "status") return cmdAiStatus(argv.slice(2));
    usage();
    process.exit(1);
  }
  if (cmd === "version") return cmdVersion();
  if (cmd === "update") {
    if (sub === "--check") return cmdUpdateCheck();
    if (sub === "--channel" && argv[2]) return cmdUpdateSetChannel(argv[2]);
    return cmdUpdate(argv.slice(1));
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
  if (cmd === "rooms") {
    const sub = argv[1];
    if (sub === "list") return list(profile);
    if (sub === "archive") {
      const id = argv[2];
      if (!id) {
        console.error(JSON.stringify({ ok: false, error: "expected <id>" }));
        process.exit(1);
      }
      return archiveRoom(id, profile);
    }
    if (sub === "restore") {
      const id = argv[2];
      if (!id) {
        console.error(JSON.stringify({ ok: false, error: "expected <id>" }));
        process.exit(1);
      }
      return restoreRoom(id, profile);
    }
    if (sub === "export") {
      const id = argv[2];
      let to: string | undefined;
      for (let i = 3; i < argv.length; i++) {
        if (argv[i] === "--to") to = argv[++i];
      }
      if (!id || !to) {
        console.error(
          JSON.stringify({ ok: false, error: "expected <id> --to <path>" }),
        );
        process.exit(1);
      }
      return exportRoom(id, to, profile);
    }
    if (sub === "import") {
      const from = argv[2];
      let asVal: string | undefined;
      let force = false;
      for (let i = 3; i < argv.length; i++) {
        if (argv[i] === "--as") asVal = argv[++i];
        else if (argv[i] === "--force") force = true;
      }
      if (!from) {
        console.error(JSON.stringify({ ok: false, error: "expected <path>" }));
        process.exit(1);
      }
      return importRoom(from, { as: asVal, force }, profile);
    }
    if (sub === "rm") {
      const id = argv[2];
      const confirm = argv.includes("--confirm");
      if (!id) {
        console.error(JSON.stringify({ ok: false, error: "expected <id>" }));
        process.exit(1);
      }
      return rmRoom(id, { confirm }, profile);
    }
    console.error(
      JSON.stringify({
        ok: false,
        error: `unknown rooms subcommand: ${sub ?? "(none)"}`,
      }),
    );
    process.exit(1);
  }
  usage();
  process.exit(cmd ? 1 : 0);
}

function usage() {
  console.log(`didraw <command> [--profile dev|release|debug]

Lifecycle:
  daemon start|stop|status|ensure
  open <room>
  rooms list
  rooms archive  <id>
  rooms restore  <id>
  rooms export   <id> --to <path>
  rooms import   <path> [--as <id>] [--force]
  rooms rm       <id> --confirm

Data:
  state    --room <id> [--compact] [--since <v>]
  patch    --room <id> --stdin
  import   mermaid --room <id> --stdin | --file <path>
  layout   --room <id> --algorithm elk-layered [--node-ids <id,...>]
  prompts  list --room <id> [--status pending|resolved|dismissed|all]
  prompts  resolve <id> --room <id> [--response <text>]
  prompts  dismiss <id> --room <id>
  prompts  delete <id> --room <id>
  prompts  purge --room <id>                  # remove all non-pending
  clear    --room <id> --confirm
  ai       start --actor <name> --task <text> [--room <id>]
  ai       stop [--room <id>]
  ai       status [--room <id>]

Versioning:
  version
  update [--check] [--channel stable|nightly|dev]

(internal-server: private subcommand used by daemon self-spawn)

Exit codes: 0 ok, 1 usage/error, 2 not-found, 3 daemon-not-healthy
`);
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: String(e) }));
  process.exit(1);
});
