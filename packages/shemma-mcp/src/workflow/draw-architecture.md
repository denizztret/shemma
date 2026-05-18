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
