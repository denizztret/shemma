---
name: draw
description: Use when user mentions canvas, drawing, schemas, architecture diagrams, or says "нарисуй", "доска", "схема", "обнови canvas", or invokes /draw. Injects current canvas state and pending user prompts; AI uses shemma CLI through Bash to update the board.
---

# draw

You have a live canvas board for this Claude Code session. Domain-level commands below; do NOT use raw `shemma patch` — use `shemma define / connect / group / note / layout / delete / apply / context` instead.

## MCP nudge

If `shemma` MCP is available in this Claude session, prefer:
- Read context via `shemma://room/{room}/context` resource or `shemma_context` tool.
- Write via `shemma_define / connect / apply` instead of `bash shemma define ...`.
- Read `shemma://workflow/overview` once at session start.

Fall back to CLI commands described below if MCP tools are not registered.

## Current canvas context

!`shemma context 2>/dev/null || echo '{"summary":{"total":0,"byRole":{}},"inView":[],"connections":[],"recentOps":[]}'`

## Rooms in this workspace

!`shemma rooms list 2>/dev/null || echo '{"rooms":[]}'`

If `rooms` lists non-empty schemas relevant to the current dialogue, ask the user whether to continue an existing schema or start a new one.

## Pending user prompts

!`shemma prompts list --status pending 2>/dev/null || echo '{"prompts":[]}'`

## Roles

| Role | When | Example name |
|---|---|---|
| `actor` | user/customer/external person | `customer`, `admin` |
| `service` | app, API, microservice, function | `auth`, `payment-api` |
| `datastore` | DB, cache, S3, file store | `users-db`, `redis-sessions` |
| `queue` | broker/event-bus/stream | `kafka-events` |
| `network` | VPC, subnet, perimeter (container) | `vpc-prod` |
| `boundary` | logical/security boundary (container) | `dmz` |
| `external` | 3rd-party service | `stripe`, `sendgrid` |
| `note` | annotation/ADR pointer | `note-1` (auto) |

## Connection kinds

| Kind | Default label | Visual |
|---|---|---|
| `sync` (default) | "calls" | solid → |
| `async` | "publishes" | dashed → |
| `data` | "reads" | solid → |
| `dep` | (none) | dotted → |

## Commands

```
shemma define <role> <name> [--label "..."] [--in <container>]
shemma connect <from> <to> [--kind sync|async|data|dep] [--label "..."]
shemma group <id1,id2,...> --as network|boundary --name <name>
shemma note --text "..." [--about <name>]
shemma layout [--mode layered-lr|layered-tb|tree|pack|force]
shemma delete <id1,id2,...> [--cascade]
shemma apply --stdin              # JSON batch with {actions: [...]}
```

## Pattern: batch via apply

For multi-step changes, prefer one `apply --stdin` over many `define`/`connect` calls — one auto-layout, one transaction:

```bash
echo '{
  "actions": [
    {"kind":"define","role":"service","name":"auth"},
    {"kind":"define","role":"datastore","name":"users-db"},
    {"kind":"connect","from":"auth","to":"users-db","connectionKind":"data"}
  ],
  "layoutHint": {"mode": "layered-lr"}
}' | shemma apply --stdin
```

## Pattern: preview before commit

Use `dryRun:true` to see compiled ops without writing:

```bash
echo '{"actions":[…],"dryRun":true}' | shemma apply --stdin
```

## User overrides — respect them

If the user moved or recoloured a node (you'll see `pinned:true` or `styleOwnedBy:"user"` in context), your next `define` upserts must NOT clobber those fields. Backend enforces this — but be aware semantically.

User-drawn arrows are now round-tripped to backend (Phase 2.2). They appear in `context` as connections with `meta.styleOwnedBy:"user"` if user-styled.
