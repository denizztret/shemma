#!/usr/bin/env bun
import { cmdAiStart, cmdAiStatus, cmdAiStop } from "./ai";
import { ensure, start, status, stop, stopAll } from "./daemon";
import { cmdClear, cmdPatch, cmdState } from "./data";
import { applyStdin, connectCmd, context, define, deleteCmd, group, layoutCmd, note } from "./domain";
import {
  archiveRoom,
  duplicateRoom,
  exportRoom,
  importRoom,
  list,
  open,
  purgeArchive,
  renameRoom,
  restoreRoom,
  rmRoom,
} from "./lifecycle";
import { cmdLogs } from "./logs";
import { applyProfile, parseProfile, portFor, type Profile } from "./profile";
import { cmdPs } from "./ps";
import { cmdPrompts } from "./prompts";
import { cmdDoctor } from "./doctor";
import { cmdUpdate, cmdUpdateCheck, cmdUpdateSetChannel } from "./update";
import { cmdVersion } from "./version-cmd";

const rawArgv = process.argv.slice(2);
const profile = parseProfile(rawArgv);
// Track whether --profile was explicitly provided (affects --all logic)
const explicitProfileProvided =
  rawArgv.includes("--profile") || rawArgv.includes("--debug");
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
    if (a[i] === "--debug") {
      // consumed by parseProfile; strip from per-command args
      continue;
    }
    out.push(a[i]);
  }
  return out;
}

function assertNotAllWithProfile(all: boolean): void {
  if (all && explicitProfileProvided) {
    console.error(JSON.stringify({ ok: false, error: "--all and --profile are mutually exclusive" }));
    process.exit(1);
  }
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
  if (cmd === "layout") {
    let mode: string | undefined;
    let scope: string | undefined;
    let spacing: string | undefined;
    let room: string | undefined;
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === "--mode") mode = argv[++i];
      else if (argv[i] === "--scope") scope = argv[++i];
      else if (argv[i] === "--spacing") spacing = argv[++i];
      else if (argv[i] === "--room") room = argv[++i];
    }
    return layoutCmd({ mode, scope, spacing, profile, room });
  }
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

  if (cmd === "ps") return cmdPs();

  if (cmd === "logs") {
    let tailN = 50;
    let follow = false;
    let all = false;
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === "--tail") tailN = Number(argv[++i]);
      else if (argv[i] === "--follow") follow = true;
      else if (argv[i] === "--all") all = true;
    }
    assertNotAllWithProfile(all);
    return cmdLogs({ profile, tail: tailN, follow, all });
  }

  if (cmd === "doctor") {
    let all = false;
    let json = false;
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === "--all") all = true;
      else if (argv[i] === "--json") json = true;
    }
    assertNotAllWithProfile(all);
    return cmdDoctor({ profile, all, json });
  }

  if (cmd === "daemon") {
    if (sub === "start") return start(profile);
    if (sub === "stop") {
      const all = argv.includes("--all");
      if (all) return stopAll(explicitProfileProvided ? profile : undefined);
      return stop(profile);
    }
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
      const archive = argv.includes("--archive");
      const force = argv.includes("--force");
      if (!id) {
        console.error(JSON.stringify({ ok: false, error: "expected <id>" }));
        process.exit(1);
      }
      return rmRoom(id, { confirm, archive, force }, profile);
    }
    if (sub === "rename") {
      const oldId = argv[2];
      const newId = argv[3];
      const force = argv.includes("--force");
      if (!oldId || !newId) {
        console.error(JSON.stringify({ ok: false, error: "expected <old> <new> [--force]" }));
        process.exit(1);
      }
      return renameRoom(oldId, newId, { force }, profile);
    }
    if (sub === "duplicate") {
      const id = argv[2];
      let asVal: string | undefined;
      for (let i = 3; i < argv.length; i++) {
        if (argv[i] === "--as") asVal = argv[++i];
      }
      if (!id || !asVal) {
        console.error(JSON.stringify({ ok: false, error: "expected <id> --as <newId>" }));
        process.exit(1);
      }
      return duplicateRoom(id, asVal, profile);
    }
    if (sub === "purge-archive") {
      const confirm = argv.includes("--confirm");
      return purgeArchive({ confirm }, profile);
    }
    console.error(
      JSON.stringify({
        ok: false,
        error: `unknown rooms subcommand: ${sub ?? "(none)"}`,
      }),
    );
    process.exit(1);
  }

  if (cmd === "define") {
    const role = argv[1];
    const name = argv[2];
    if (!role || !name) { console.error(JSON.stringify({ ok: false, error: "expected <role> <name>" })); process.exit(1); }
    let label: string | undefined;
    let inContainer: string | undefined;
    let room: string | undefined;
    for (let i = 3; i < argv.length; i++) {
      if (argv[i] === "--label") label = argv[++i];
      else if (argv[i] === "--in") inContainer = argv[++i];
      else if (argv[i] === "--room") room = argv[++i];
    }
    return define({ role, name, label, in: inContainer, profile, room });
  }

  if (cmd === "connect") {
    const from = argv[1];
    const to = argv[2];
    if (!from || !to) { console.error(JSON.stringify({ ok: false, error: "expected <from> <to>" })); process.exit(1); }
    let kind: string | undefined;
    let label: string | undefined;
    let room: string | undefined;
    for (let i = 3; i < argv.length; i++) {
      if (argv[i] === "--kind") kind = argv[++i];
      else if (argv[i] === "--label") label = argv[++i];
      else if (argv[i] === "--room") room = argv[++i];
    }
    return connectCmd({ from, to, kind, label, profile, room });
  }

  if (cmd === "group") {
    const ids = argv[1]?.split(",") ?? [];
    let asKind: string | undefined;
    let name: string | undefined;
    let label: string | undefined;
    let room: string | undefined;
    for (let i = 2; i < argv.length; i++) {
      if (argv[i] === "--as") asKind = argv[++i];
      else if (argv[i] === "--name") name = argv[++i];
      else if (argv[i] === "--label") label = argv[++i];
      else if (argv[i] === "--room") room = argv[++i];
    }
    if (!asKind || !name) { console.error(JSON.stringify({ ok: false, error: "expected --as <kind> --name <name>" })); process.exit(1); }
    return group({ ids, as: asKind, name, label, profile, room });
  }

  if (cmd === "note") {
    let text: string | undefined;
    let about: string | undefined;
    let room: string | undefined;
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === "--text") text = argv[++i];
      else if (argv[i] === "--about") about = argv[++i];
      else if (argv[i] === "--room") room = argv[++i];
    }
    if (!text) { console.error(JSON.stringify({ ok: false, error: "expected --text \"...\"" })); process.exit(1); }
    return note({ text, about, profile, room });
  }

  if (cmd === "delete") {
    const ids = argv[1]?.split(",") ?? [];
    const cascade = argv.includes("--cascade");
    let room: string | undefined;
    for (let i = 2; i < argv.length; i++) {
      if (argv[i] === "--room") room = argv[++i];
    }
    if (ids.length === 0) { console.error(JSON.stringify({ ok: false, error: "expected <id1,id2,...>" })); process.exit(1); }
    return deleteCmd({ ids, cascade, profile, room });
  }

  if (cmd === "apply") {
    if (!argv.includes("--stdin")) { console.error(JSON.stringify({ ok: false, error: "expected --stdin" })); process.exit(1); }
    let room: string | undefined;
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === "--room") room = argv[++i];
    }
    return applyStdin({ profile, room });
  }

  if (cmd === "context") {
    let since: number | undefined;
    let viewport: string | undefined;
    let room: string | undefined;
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === "--since") since = Number(argv[++i]);
      else if (argv[i] === "--viewport") viewport = argv[++i];
      else if (argv[i] === "--room") room = argv[++i];
    }
    return context({ since, viewport, profile, room });
  }

  usage();
  process.exit(cmd ? 1 : 0);
}

function usage() {
  console.log(`didraw <command> [--profile dev|release|debug] [--debug]

Lifecycle:
  daemon start|stop [--all]|status|ensure
  open <room>
  ps                                          # JSON status for all profiles
  rooms list
  rooms archive       <id>
  rooms restore       <id>
  rooms export        <id> --to <path>
  rooms import        <path> [--as <id>] [--force]
  rooms rename        <old> <new> [--force]
  rooms duplicate     <id> --as <newId>
  rooms rm            <id> [--archive] [--hard] [--force] --confirm
  rooms purge-archive --confirm

Domain (preferred AI interface) — каждая команда принимает [--room <id>] (default = "default"):
  define <role> <name> [--label "..."] [--in <container>] [--room <id>]
  connect <from> <to> [--kind sync|async|data|dep] [--label "..."] [--room <id>]
  group <id1,id2,...> --as network|boundary --name <name> [--label "..."] [--room <id>]
  note --text "..." [--about <name>] [--room <id>]
  layout [--mode layered-lr|layered-tb|tree|pack|force] [--scope all|<group>] [--spacing compact|normal|loose] [--room <id>]
  delete <id1,id2,...> [--cascade] [--room <id>]
  apply --stdin [--room <id>]                 # JSON batch on stdin
  context [--since N] [--viewport x,y,w,h] [--room <id>]

Data:
  state    --room <id> [--compact] [--since <v>]
  patch    --room <id> --stdin
  prompts  list --room <id> [--status pending|resolved|dismissed|all]
  prompts  resolve <id> --room <id> [--response <text>]
  prompts  dismiss <id> --room <id>
  prompts  delete <id> --room <id>
  prompts  purge --room <id>                  # remove all non-pending
  clear    --room <id> --confirm
  ai       start --actor <name> --task <text> [--room <id>]
  ai       stop [--room <id>]
  ai       status [--room <id>]

Diagnostics:
  logs     [--tail N] [--follow] [--all | --profile p]  # read daemon log
  doctor   [--all | --profile p] [--json]               # read-only health checks

Versioning:
  version
  update [--check] [--channel stable|nightly|dev]

Flags:
  --profile dev|release|debug   select runtime profile (default: release)
  --debug                       shortcut for --profile debug

Note: Mermaid import is browser-only (see ADR-0001): open canvas and run
  await window.didrawImportMermaid('graph LR\\n  app --> db')
in DevTools console.

(internal-server: private subcommand used by daemon self-spawn)

Exit codes: 0 ok, 1 usage/error, 2 not-found, 3 daemon-not-healthy/doctor-fail
`);
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: String(e) }));
  process.exit(1);
});
