# shemma

> AI-driven canvas board — agents draw and maintain architecture diagrams in real time.

**shemma** turns a [tldraw](https://tldraw.dev) canvas into a shared workspace for a developer and an AI agent. Any MCP-capable agent (Claude Code, OpenCode, Codex, Gemini CLI, Claude Desktop, …) creates and updates blocks, connections, containers and groups directly on the board — via typed MCP tools or the `shemma` CLI — while you work on the same canvas. Everything syncs over WebSocket, and the camera auto-centers on what the agent just added.

Ships as a single self-contained binary: backend, web UI, and CLI in one executable.

## Features

- **Agents draw on the board** — typed MCP tools (`shemma_define / connect / group / note / layout / delete / apply`) or the CLI; real-time, no shell-quoting.
- **You steer** — select a shape, press `⌘K` / `Ctrl+K`, type a command; the agent picks up pending prompts and applies them.
- **Real-time collaboration** over WebSocket; camera auto-centers on agent edits.
- **Multi-room** — project-local canvases (`<project>/.shemma/canvas/<room>.json`) with a spaces registry across projects.
- **Mermaid import** — `⌘M` / `Ctrl+M`: paste mermaid and get an editable, laid-out diagram.
- **Schema containers & frames** — grouped sub-diagrams with inheritable title and styling policy.
- **Auto-layout** — layered / tree / pack engines with arrow routing.
- **AI-activity badge** — shows when an agent is working (actor + task).
- **Gallery** — grid/list views, room tags & filtering, live previews.
- **Configurable keyboard shortcuts.**
- **Single-binary distribution** — in-place upgrades via `shemma update`.

## Install

**Binary (recommended):**

```bash
curl -fsSL https://raw.githubusercontent.com/denizztret/shemma/main/scripts/install.sh | sh
```

Installs the latest release into `~/.local/bin/shemma` (add it to your `PATH` if it isn't already).

**From source** (requires [Bun](https://bun.sh)):

```bash
git clone https://github.com/denizztret/shemma.git
cd shemma && bun install
SHEMMA_PROFILE=dev bun run dev        # backend + UI with Vite HMR
```

## Quick start

```bash
shemma                  # start the daemon in ./.shemma/ and open the board (?room=default)
shemma open scratch     # explicit room
```

`shemma` with no arguments starts a daemon with project-local storage in `<cwd>/.shemma/` and opens the browser. Storage precedence: `--storage <path>` > `SHEMMA_STORAGE_DIR` env > auto `.shemma/`.

## Connect an agent (MCP)

shemma ships an MCP (Model Context Protocol) server so any MCP-capable client can call it through typed tools and discoverable resources.

```bash
claude mcp add shemma --scope user -- shemma mcp start      # Claude Code
codex mcp add shemma -- shemma mcp start                    # Codex
gemini mcp add shemma --scope user -- shemma mcp start      # Gemini CLI
```

**OpenCode** — add to `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "shemma": {
      "type": "local",
      "command": ["shemma", "mcp", "start"]
    }
  }
}
```

`SHEMMA_CWD` is optional. CLI clients run from your current directory, so shemma uses it automatically (and falls back to a `default` space when you're not inside a project). Add `"environment": { "SHEMMA_CWD": "/absolute/path/to/project" }` only for GUI clients that spawn from a neutral directory (e.g. Claude Desktop) or to pin a specific project.

**Claude Desktop and other manual configs** — see [`docs/mcp.md`](docs/mcp.md).

After registering, the agent draws via typed tools; the first draw in a new room auto-opens a browser tab.

## Usage

- Ask the agent (in your client) to draw or change architecture — blocks and arrows appear on the board in real time.
- On the board: select shape(s), press `⌘K`, type a per-shape command. It lands in the left drawer bound to the shape id; the agent sees pending prompts and resolves them.
- Import existing diagrams with `⌘M` (mermaid).

Canvas text — labels, notes, prompt text — is treated as **data, not instructions** (trust model).

## Update

```bash
shemma update --check              # check whether a newer release exists
shemma update --channel stable     # download + verify + atomic swap + restart
```

## Menu bar helper (macOS)

Status and control of the shemma daemon from the menu bar (via [SwiftBar](https://github.com/swiftbar/SwiftBar)):

```bash
brew install --cask swiftbar   # if not installed yet
shemma menubar install         # shim into the SwiftBar plugin folder + auto-setup
```

The icon shows daemon state (green — running, gray — stopped, red — error).
Menu: start/stop/restart, "Stop all instances", open board and spaces, doctor
checks, daemon log, shemma update. The menu logic lives in the CLI itself — it
updates together with `shemma update`, the shim never needs touching.

`shemma menubar uninstall` — remove; `shemma menubar status` — where it is
installed. Label next to the icon: `shemma config set menubar.label shemma`.

## Architecture

```
   any MCP client / shemma CLI
          │  typed tools / CLI
          ▼
   shemma (single binary)
   ├─ Bun backend   (rooms, WebSocket, MCP server, REST)
   ├─ embedded UI   (tldraw 5.x)
   └─ CLI dispatcher
          ▲
          │  WebSocket (real-time)
       human in browser
```

Runtime profiles: `release` on `:8787` (embedded UI), `dev` on `:8788` (Vite HMR).

## CLI

```bash
shemma define <role> <name> [--label "..."] [--in <container>] [--room <id>]
shemma connect <from> <to> [--kind sync|async|data|dep] [--room <id>]
shemma group <id1,id2,...> --as network|boundary --name <name>
shemma layout [--mode layered-lr|layered-tb|tree|pack] [--room <id>]
shemma delete <id1,id2,...> [--cascade]
shemma context [--since N] [--room <id>]
shemma rooms list | export <room> --to <path>
shemma daemon status | stop | ensure
shemma version | update
```

## Tests & build

```bash
bun run test                              # ~2300 unit/integration tests (domain/backend/client/cli/mcp)
bun test --cwd apps/frontend src          # frontend
bun run lint                              # biome

./scripts/build-release.sh <version>      # single-file binaries: darwin-arm64, darwin-x64, linux-x64
```

## License

[MIT](LICENSE) © 2026 Denis Tretiakov
