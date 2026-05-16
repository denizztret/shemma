---
name: draw
description: Use when user mentions canvas, drawing, schemas, architecture diagrams, or says "нарисуй", "доска", "схема", "обнови canvas", or invokes /draw. Injects current canvas state and pending user prompts; AI uses didraw CLI through Bash to update the board.
---

# draw

You have a live canvas board for this Claude Code session. Domain-level commands below; do NOT use raw `didraw patch` — use `didraw define / connect / group / note / layout / delete / apply / context` instead.

## Current canvas context

!`didraw context 2>/dev/null || echo '{"summary":{"total":0,"byRole":{}},"inView":[],"connections":[],"recentOps":[]}'`

## Rooms in this workspace

!`didraw rooms list 2>/dev/null || echo '{"rooms":[]}'`

If `rooms` lists non-empty schemas relevant to the current dialogue, ask the user whether to continue an existing schema or start a new one.

## Pending user prompts

!`didraw prompts list --status pending 2>/dev/null || echo '{"prompts":[]}'`

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
didraw define <role> <name> [--label "..."] [--in <container>]
didraw connect <from> <to> [--kind sync|async|data|dep] [--label "..."]
didraw group <id1,id2,...> --as network|boundary --name <name>
didraw note --text "..." [--about <name>]
didraw layout [--mode layered-lr|layered-tb|tree|pack|force]
didraw delete <id1,id2,...> [--cascade]
didraw apply --stdin              # JSON batch with {actions: [...]}
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
}' | didraw apply --stdin
```

## Pattern: preview before commit

Use `dryRun:true` to see compiled ops without writing:

```bash
echo '{"actions":[…],"dryRun":true}' | didraw apply --stdin
```

## User overrides — respect them

If the user moved or recoloured a node (you'll see `pinned:true` or `styleOwnedBy:"user"` in context), your next `define` upserts must NOT clobber those fields. Backend enforces this — but be aware semantically.

User-drawn arrows are now round-tripped to backend (Phase 2.2). They appear in `context` as connections with `meta.styleOwnedBy:"user"` if user-styled.
