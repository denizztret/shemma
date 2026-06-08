# Drawing architecture

## Domain actions

- `shemma_define { name, role, label? }` — create a new element. `role` ∈ `actor|service|datastore|queue|external|note`.
- `shemma_connect { from, to, connectionKind, label? }` — arrow between two element names. `connectionKind` ∈ `sync|async|data|dep`.
- `shemma_group { name, label?, children: [...] }` — container that frames children.
- `shemma_note { name, text }` — sticky note.
- `shemma_layout { mode?, scope?, spacing? }` — explicit re-layout. `mode` ∈ `layered-lr|layered-tb|tree|pack|force`.
- `shemma_layout_selection { ids?, mode?, spacing? }` — tidy layout for a subset of shapes only (DRW-088). See "Tidy selection" section below.
- `shemma_delete { ids, cascade? }` — destructive. Containers with children require `cascade: true`.
- `shemma_apply { actions: [...] }` — atomic batch of any of the above.

## Action format for `shemma_apply`

`shemma_apply` takes `actions: [ { kind, …fields }, … ]`. The schema is intentionally open (`additionalProperties`), so the per-`kind` shape is documented here rather than enforced by the JSON schema. `kind` is the discriminator; one of `define | connect | group | note | layout | delete`.

| kind | fields (`?` = optional) | notes |
|---|---|---|
| `define` | `role, name, label?, in?` | upsert an element. `role` ∈ `actor\|service\|datastore\|queue\|external\|note`. `in` = container name to nest into. |
| `connect` | `from, to, connectionKind?, label?` | directed edge between element **names**. `connectionKind` ∈ `sync\|async\|data\|dep`. |
| `group` | `children:[name,…], as, name, label?` | container around members. **Members go in `children`, not `ids`.** `as` ∈ `network\|boundary`. |
| `note` | `text, about?, name?` | sticky note; `about` = element name it annotates. |
| `layout` | `mode?, scope?, spacing?` | explicit re-layout. `mode` ∈ `layered-lr\|layered-tb\|tree\|pack\|force`. |
| `delete` | `ids:[name,…], cascade?` (or `id`) | destructive; `cascade:true` also drops dependent edges. |

Forward references resolve within one batch — define a name, then `connect`/`group` by it in a later entry.

```json
{ "actions": [
  { "kind": "define", "role": "service", "name": "api", "label": "API" },
  { "kind": "define", "role": "datastore", "name": "db" },
  { "kind": "connect", "from": "api", "to": "db", "connectionKind": "data" },
  { "kind": "group", "children": ["api", "db"], "as": "boundary", "name": "backend" }
] }
```

> ⚠️ The single most common mistake is sending group members as `ids` in a `shemma_apply` group action (copied from a different tool). Use `children`. (The backend now also accepts `ids` as a legacy alias, but `children` is canonical — see DRW-220.)

### Label semantics (verified, DRW-222)

- **Multi-line labels are supported.** A `\n` inside `label` (define/connect) or `text` (note) renders as a **hard line break** — the canvas uses `white-space: pre-wrap`, so newlines are honored, not collapsed.
- **Emoji are safe.** Variation-selector sequences (e.g. ⚙️) and supplementary-plane codepoints (e.g. 🚀) pass through and render intact.

### Placement — you don't set coordinates (DRW-223)

New shapes are auto-placed; you never pass `x`/`y`:

- **Single / incremental creates don't pile.** Each new free shape (`shemma_define`, `note`) is dropped into an empty slot beside the existing content, so creating nodes one at a time no longer stacks them at the origin.
- **Connected batches are laid out.** A batch that contains edges (`define` + `connect`) is additionally distributed by the ELK layout engine — a chain/tree comes out spaced, not overlapping.
- **Tidying is explicit.** To re-arrange an existing diagram use `shemma_layout` (whole canvas) or `shemma_layout_selection` (a subset). Per the no-auto-relayout contract, **don't** call layout after incremental edits unless the user asks — their manual arrangement must survive your edits.

### Text fit — boxes hug their label (DRW-228)

A `geo`/`note` box is auto-sized to its text (optimal width, minimal height) so labels don't overflow or leave the box oversized:

- **Automatic when a tab is open.** When a browser tab is connected, newly added or edited text is fitted on the frontend automatically (on add — including your MCP-created shapes — and when a human finishes editing; the live tab also fits the state it loads on open). You don't need to do anything in the common case.
- **`shemma_fit_text` — explicit fit.** An agent-invokable pass to force/confirm fitting — e.g. right before a layout, or to cover any shape the live auto-fitter didn't catch. `targets` (shape ids / didrawNames) limits scope; omit to fit all fittable shapes. **Requires an open tab** (text metrics are browser-only): on `no-client-connected` open the returned `room_url` and retry, exactly like `shemma_import_mermaid` mode:"browser". Returns `count` (only un-pinned, un-fitted shapes are changed — already-fitted boxes report 0).
- **Never overwrites a user size.** Size-pinned shapes (a human's manual resize, or already-fitted boxes) are skipped — fitting respects pin discipline.
- **Order:** fit *before* a layout pass so the layout sees correct dimensions. After fit, sizes are pinned and survive layout.

## Element identity

Use the `name` arg as a stable, human-meaningful id ("api-gateway", "user-db"). Re-using a name in `define` is idempotent (no duplicate created).

## Idempotency

Pass `clientOpId` (UUID) to every write. If the call retries with the same id, the server returns the same result without re-applying. The MCP server echoes `clientOpId` back on success **and** on error.

## Layout precedence

Every successful write runs layout afterwards by default. To skip layout entirely, pass `layoutHint: null`. To override mode, pass `layoutHint: { mode: "tree" }`. An explicit `shemma_layout` action inside a batch wins over `layoutHint`.

## Pin discipline

User-pinned shapes (`meta.pinned: true`) are not moved by layout. User-drawn freehand shapes are layout-pinned automatically. Do not unset pins from MCP.

## Dry run

Pass `dryRun: true` to validate + compute the would-be batch without applying. Useful before destructive operations.

## Mermaid-first / hybrid workflow

For complex diagrams with **many nodes** (≥10) and **long multi-line labels**, the manual `shemma_define → shemma_connect → shemma_layout` path produces tight or cramped output:
- `geo` boxes are auto-fitted to their text (DRW-228, see "Text fit" above), but very long single-line labels still read better split across lines — Mermaid handles that wrapping for you.
- ELK layered routing crowds parallel edges in dense graphs.

For these cases prefer **Mermaid import via MCP**, then fall back to `shemma_*` calls for incremental tweaks.

### Primary path: `shemma_import_mermaid` MCP tool (DRW-083)

**Requires:** browser tab open in the target room (the tool sends a WS command to the frontend).

```
shemma_import_mermaid {
  source: "graph LR\n  A-->B\n  B-->C",
  room?: "my-room",
}
```

Returns: `{ shape_ids, didraw_names, root_ids }` — use `didraw_names` as element names for follow-up `shemma_connect` calls.

**APPEND-only.** The tool never replaces or deletes existing shapes — preserving the user's manual layout edits is a hard product invariant. If you genuinely need to wipe the canvas, ask the user; a future `shemma_clear_room` tool will require explicit confirmation. Never try to "redraw" — see "Edit, don't redraw" below.

**Flow:**
1. AI calls `shemma_import_mermaid` with mermaid source.
2. Backend sends WS frame `{kind:"import-mermaid", source, requestId}` to the browser tab.
3. Frontend calls `@tldraw/mermaid.createMermaidDiagram(editor, source)` → shapes appear in canvas.
4. Frontend sends back `{kind:"import-mermaid-result", requestId, ok:true, shape_ids, didraw_names, root_ids}`.
5. Backend resolves the pending promise → MCP tool returns result to AI.
6. Normal store-change sync persists the shapes to backend.

**Error cases:**
- No browser tab open → `503 {error:"no client connected", room_url:"http://…"}` — see "Handling no-client-connected error" below.
- Frontend timed out (>10s, e.g. JS blocked) → `500 {error:"client did not respond"}`.
- Invalid mermaid syntax → `500 {error:"<mermaid parser error>"}`.

### Edit, don't redraw

When iterating on a diagram, do **not** "wipe and re-import" — that destroys the user's manual layout work and is explicitly disallowed.

Guidelines:
- **Always call `shemma_context` first** to see what already exists (didraw_names, roles, connections). Plan additions/edits against that snapshot.
- Use Mermaid-first for the **initial** diagram only. After that, prefer point edits via `shemma_define` / `shemma_connect` / `shemma_group`.
- If the user has manually rearranged shapes, **do not call `shemma_layout`** unless they explicitly ask — it will reflow everything.
- If a node is wrong, **rename or relabel** (`shemma_define { name, role, label }` is idempotent on `name`). Don't delete and recreate.
- Never try to "delete everything and start over" to fix a layout. If the canvas is too cluttered, ask the user.

### Handling no-client-connected error

When `shemma_import_mermaid` returns `code: "no-client-connected"`, the 503 response includes a `room_url` field (also surfaced in the error message). Retry pattern:

1. Read `room_url` from `structuredContent.details.room_url` (or parse it out of the message).
2. Main agent: open the URL — either via `chrome-devtools` MCP `navigate_page` (if a tab is already open) or `new_page` (cold start).
3. Wait for canvas ready — easiest signal is the toolbar **M** button or the tldraw canvas SVG mounting.
4. Retry `shemma_import_mermaid` once with the same `source`.

If the second call also returns `no-client-connected` (e.g. the browser isn't available), surface the URL to the user verbally and stop — don't retry in a loop.

### Fallback path: ⌘M / Ctrl+M modal (manual)

When no browser tab is available, or when the user wants to manually edit mermaid source:
1. Open the room in a browser.
2. Press **⌘M / Ctrl+M** (or click the toolbar mermaid button) — modal appears.
3. Paste mermaid source, confirm.

This path bypasses the MCP layer entirely and is useful for human-driven iterative editing.

### How import works internally

`@tldraw/mermaid.createMermaidDiagram(editor, source)` parses + lays out via its own engine and writes shapes to the tldraw store via `editor.createShape` (which triggers `onBeforeCreate` / `onBeforeUpdate` hooks → correct `growY`, no overflow).

Each imported node gets `meta.didrawName` (slugified label) so it becomes **domain-aware** — `shemma_define`/`shemma_connect`/`shemma_layout` find it by that name.

Dev-console fallback: `window.shemmaImportMermaid("flowchart LR\n  A --> B")` does the same thing programmatically.

### Layout engine: DAGRE only (DRW-093)

`@tldraw/mermaid@5.0.0` ships with mermaid but does **not** register `@mermaid-js/layout-elk` via `mermaid.registerLayoutLoaders`. Any `config: layout: elk` frontmatter in source — explicit or auto-prepended — silently degrades to DAGRE: mermaid does not raise an error when a requested layout loader is absent.

For ELK-style output after import, run `shemma_layout` or `shemma_layout_selection` against the imported shapes — those go through our own ELK pipeline (`elkjs`) which is independent of mermaid's layout engine and produces orthogonal edges with tight ranking.

### Post-import interactivity

- **Add nodes**: `shemma_define { name: "new_service", role: "service", label: "..." }` — appended; subsequent `shemma_layout` repositions everything including imported shapes.
- **Add edges**: `shemma_connect { from: "<imported_name>", to: "new_service", connectionKind: "sync" }` — finds imported node by slug.
- **Group existing**: `shemma_group { name: "boundary1", as: "boundary", children: ["<imported_name>", ...] }` — wraps imported nodes in a frame container.
- **Ungroup**: `editor.ungroupShapes([rootId])` in browser console; imported shapes flatten to page root, edges and labels are preserved (bindings reference shape ids, not group).
- **Layout**: `shemma_layout` works on mixed mermaid+manual schemas — ELK reads all top-level shapes uniformly.

### When to choose Mermaid-first

- ≥10 nodes with long labels / type signatures.
- Diagram naturally expressed in mermaid syntax (flowchart, sequence, class).
- Initial bulk creation — manual `shemma_define` × 10+ is slow.

### When to stay manual

- Iterative diagram building (≤5 nodes, additive design).
- AI doesn't have a mermaid representation of the target in context.
- Need explicit control over each element's role/kind during creation.
- No browser tab is open (MCP tool requires an active tab).

### Hybrid pattern (recommended)

1. AI calls `shemma_import_mermaid` with initial mermaid structure.
2. AI follows up with `shemma_define`/`shemma_connect` for any later additions.
3. Single `shemma_layout` at the end re-spaces both populations together.

> Reference docs/decisions/0001-mermaid-import-location.md for the architectural rationale (mermaid lives frontend-side; the import path is `mermaid source → editor.createShape → store.put → WS → backend`).

## Tidy selection (DRW-088)

`shemma_layout_selection` runs ELK layout on **only the specified shapes**, leaving the rest of the canvas untouched. Pinned shapes (`meta.pinned: true`) are never moved even if included in `ids`.

### Use case 1: post-import cleanup of a specific zone

After `shemma_import_mermaid` returns `root_ids`, call `shemma_layout_selection` with those ids to tidy just the newly imported diagram without disturbing the manually arranged rest of the canvas:

```
// Step 1: import
const result = await shemma_import_mermaid({ source: "flowchart LR\n  A --> B", room: "my-room" });
// result.root_ids = ["shape:e_frame-1"]

// Step 2: tidy only the new group
await shemma_layout_selection({ ids: result.root_ids, mode: "layered-tb", room: "my-room" });
```

If the imported shapes carry `meta.mermaidSource` with a flowchart direction (`flowchart LR`, `graph TB`, etc.), the tool auto-detects the matching `mode` — you can omit `mode` and it will use the source's direction.

### Use case 2: partial reorg of an existing zone

When the user has manually added or moved several shapes in one area of the canvas and wants to re-arrange just that zone:

1. User selects the shapes in the browser UI.
2. User presses **⌘⇧L** (Mac) / **Ctrl+Shift+L** (Linux/Windows), or right-clicks and chooses **Tidy selection**.
3. The selected shapes are re-laid out; everything else stays put.
4. The viewport zooms to the tidied shapes' bounding box.

From MCP (AI agent perspective):

```
// Use didrawNames from shemma_context
await shemma_layout_selection({ ids: ["api-gateway", "auth-service", "users-db"], mode: "layered-tb" });
```

### Edge cases

- **Empty `ids`** (or omitted) → returns `{ok:true, count:0, hint:"..."}` — equivalent to a no-op. Use `shemma_layout` for full-canvas layout instead.
- **Single id** → same noop response — need ≥2 shapes to produce a meaningful layout.
- **All ids unresolved** → `{ok:false, error:"no shapes found", unresolved:[...]}` 400.
- **Mixed resolved/unresolved** → resolved shapes are laid out; `unresolved` list is returned in the response for debugging.
- **Pinned shapes in selection** → pinned shapes are included in `ids` but their coordinates are restored after ELK, so they effectively stay in place.
