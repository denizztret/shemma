# Resolving canvas prompts

Users can press Cmd+K on the canvas to leave a prompt — a pending message attached to selected shapes (or no shapes). MCP exposes these prompts so an agent can respond.

## Discover

- `shemma_prompts_list { status?: "pending"|"resolved"|"dismissed"|"all" }` — default returns pending.
- Resource `shemma://room/{room}/prompts/pending` — same data, discoverable.

## Resolve

- For a question: `shemma_prompt_resolve { id, response: "<your answer>" }`.
- For a drawing task: do the drawing via domain tools, then `shemma_prompt_resolve { id, response: "Done: <summary>" }`.
- If you cannot act: `shemma_prompt_dismiss { id }`.

## Pull-only in v1

There is no subscription/notification yet. Poll `shemma_prompts_list` at session start and when the user references prompts.

A background agent (Phase 2.4) will react to prompts automatically. In v1, the host agent decides when to poll.
