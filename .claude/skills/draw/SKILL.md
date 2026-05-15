---
name: draw
description: Use when user mentions canvas, drawing, schemas, architecture diagrams, or says "нарисуй", "доска", "схема", "обнови canvas", or invokes /draw. Injects current canvas state and pending user prompts; AI uses didraw CLI through Bash to update the board.
---

# draw

You have a live canvas board for this Claude Code session. State below is auto-injected; use the `didraw` CLI through Bash to read and modify it.

## Current canvas state (compact JSON)

!`didraw state --compact 2>/dev/null || echo '{"canvas":{"nodes":[],"edges":[],"groups":[]},"version":0}'`

## Pending user prompts

!`didraw prompts list --status pending 2>/dev/null || echo '{"prompts":[]}'`

## Commands (use the Bash tool)

Read:
```
didraw state --compact                          # full snapshot
didraw state --since <last_version>             # diff only
```

Write:
```
echo '{"ops":[...],"source":"ai","clientOpId":"<uuid>"}' | didraw patch --stdin
didraw clear --confirm                          # wipe canvas (destructive!)
```

Bulk-import a graph (Mermaid) — **browser-only per ADR-0001**:
The `@tldraw/mermaid` package requires a live tldraw `Editor` (mounted in DOM with full SVG layout); it cannot run server-side. To import Mermaid, open the canvas in a browser tab (`didraw open <room>`) and run in the page's DevTools console:
```js
await window.didrawImportMermaid(`graph LR
  app --> server --> db`)
```
Returns `{ok, version}` and broadcasts to all tabs. There is no `didraw import mermaid` CLI command.

Auto-layout new nodes:
```
didraw layout --algorithm elk-layered
didraw layout --node-ids n1,n2          # only specific
```

Targeted prompts (user-attached questions on objects):
```
didraw prompts list --status pending
didraw prompts resolve <id> --response "text"
didraw prompts dismiss <id>
```

## PatchOp format

- `{op:"add", target:"node"|"edge"|"group", value:{...}}` — create
- `{op:"update", target, id, set:{...}}` — partial; `style`/`meta` deep-merge
- `{op:"delete", target, id}` — remove

## Node fields

- `id` (UUID), `kind` (`rect|ellipse|diamond|sticky|text|freeform`), `x`, `y`
- Optional: `w`, `h` (default 120×60; sticky 200×120), `label`, `style{color,fill,stroke,fontSize}`, `meta`

## Edge fields

- `id`, `from`, `to` — endpoints are `{kind:"node",id}` (anchored) or `{kind:"point",x,y}` (free in space)
- Optional: `label`, `style{color,dashed,arrow:"none"|"to"|"both"}`

## Coordinates

Pixels, centre of canvas ≈ (0,0). Spacing 150–250px between nodes feels natural.

## If you reply to a pending user prompt

Always call `didraw prompts resolve <id> --response "what you did"` after — so the marker on the canvas updates and the user sees your response.
