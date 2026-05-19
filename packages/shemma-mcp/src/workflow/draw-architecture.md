# Drawing architecture

## Domain actions

- `shemma_define { name, role, label? }` — create a new element. `role` ∈ `actor|service|datastore|queue|external|note`.
- `shemma_connect { from, to, connectionKind, label? }` — arrow between two element names. `connectionKind` ∈ `sync|async|data|dep`.
- `shemma_group { name, label?, children: [...] }` — container that frames children.
- `shemma_note { name, text }` — sticky note.
- `shemma_layout { mode?, scope?, spacing? }` — explicit re-layout. `mode` ∈ `layered-lr|layered-tb|tree|pack|force`.
- `shemma_delete { ids, cascade? }` — destructive. Containers with children require `cascade: true`.
- `shemma_apply { actions: [...] }` — atomic batch of any of the above.

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
- `geo` shape labels don't shrink-to-fit programmatically (no public auto-resize API in tldraw 5.x; mitigated by 220×80 defaults).
- ELK layered routing crowds parallel edges in dense graphs.

For these cases prefer **Mermaid import**, then fall back to `shemma_*` calls for incremental tweaks.

### How import works

1. User (or AI, via "type this mermaid into the canvas") opens the room and presses **⌘M / Ctrl+M** (or clicks the toolbar button) — modal appears. Paste mermaid source, confirm.
2. `@tldraw/mermaid.createMermaidDiagram(editor, source)` parses + lays out via its own engine and writes shapes to the tldraw store via `editor.createShape` (which triggers `onBeforeCreate` / `onBeforeUpdate` hooks → correct `growY`, no overflow).
3. Each imported node gets `meta.didrawName` (slugified label) so it becomes **domain-aware** — `shemma_define`/`shemma_connect`/`shemma_layout` find it by that name.
4. WS sync streams the new shapes back to backend; persistence is automatic.
5. Dev-console fallback: `window.shemmaImportMermaid("flowchart LR\n  A --> B")` does the same thing programmatically.

### Post-import interactivity

- **Add nodes**: `shemma_define { name: "new_service", role: "service", label: "..." }` — appended; subsequent `shemma_layout` repositions everything including imported shapes.
- **Add edges**: `shemma_connect { from: "<imported_name>", to: "new_service", connectionKind: "sync" }` — finds imported node by slug.
- **Group existing**: `shemma_group { name: "boundary1", as: "boundary", ids: ["<imported_name>", ...] }` — wraps imported nodes in a frame container.
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

### Hybrid pattern (recommended)

1. AI writes mermaid for the initial structure → paste via ⌘M.
2. AI follows up with `shemma_define`/`shemma_connect` for any later additions.
3. Single `shemma_layout` at the end re-spaces both populations together.

> Reference docs/decisions/0001-mermaid-import-location.md for the architectural rationale (mermaid lives frontend-side; the import path is `mermaid source → editor.createShape → store.put → WS → backend`).
