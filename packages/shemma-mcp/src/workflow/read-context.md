# Reading canvas context

Two layers of detail:

1. **Compact (default).** `shemma_context` or `shemma://room/{room}/context` — returns element list with id, type, label, role, connectionKind, from/to, children. No geometry. Use this first; it's small and cheap.

2. **Geometry.** Append `viewport` or use `shemma://room/{room}/context/geometry` — adds `bounds: {x,y,w,h}` per element. Use only when positions or freehand drawings matter.

3. **Full snapshot.** `shemma://room/{room}/state/full` — opaque tldraw store JSON. May be large (see `shemma://status.rooms.estimatedFullStateBytes`). Avoid unless you need pixel-level shape props.

Use `since: <previousVersion>` to get only changes since a known version (visual diff).

Always verify writes with a follow-up read when the operation is multi-step.
