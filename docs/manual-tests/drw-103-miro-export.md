# DRW-103 — Export selection → Miro (Manual E2E checklist)

Version: 0.19.0
Date: 2026-05-20

This checklist validates the Miro export feature end-to-end against a real
Miro board. Run it after backend / frontend / MCP changes are merged but
before tagging 0.19.0.

## Pre-requisites

- [ ] Miro account with at least one accessible board (create "shemma-e2e" if needed).
- [ ] Miro developer token obtained from https://miro.com/app/settings/user-profile/apps
- [ ] shemma daemon ≥ 0.19.0 installed (or running from `bun run` source).
- [ ] No existing `~/.config/shemma/config.json` (or back it up — token will be overwritten).

## 1. CLI — token lifecycle

- [ ] `shemma config get miro.token` → outputs `miro.token = [unset]`
- [ ] `shemma config set miro.token <real-token>` → outputs `✓ miro.token saved to ~/.config/shemma/config.json`
- [ ] Inspect file: `ls -la ~/.config/shemma/config.json` → mode shown as `-rw-------` (chmod 600)
- [ ] `shemma config get miro.token` → outputs `miro.token = [set] (N chars)`; the raw token must NOT appear in output
- [ ] `shemma config set miro.token bad-token` → outputs `✗ miro.token validation failed (401 Unauthorized)` and exits with code 1; original valid token preserved
- [ ] `shemma config set miro.token <real-token> --json` → stdout is parseable JSON `{ok:true,...}`
- [ ] `shemma config unset miro.token` → outputs `· miro.token removed`

Re-set the valid token before continuing.

## 2. Backend — board list

- [ ] `curl http://localhost:8787/api/export/miro/boards` (using release profile port) → returns JSON `{ boards: [...] }` with at least the "shemma-e2e" board.
- [ ] Delete `~/.config/shemma/config.json`, retry → returns 412 with `{ "error": "miro-token-missing", "hint": "Run: shemma config set miro.token <token>..." }`. Restore token.

## 3. Frontend — modal flow

Open shemma in browser at the default room. Draw / paste in selection:

- 3 geo shapes (rectangle, ellipse, diamond)
- 2 sticky notes (different colors)
- 2 arrows between shapes
- 1 frame with 2 child shapes

Select all 10 shapes + 2 arrows.

- [ ] Press `⌘⇧E` (Mac) or `Ctrl+Shift+E` (Linux/Win) → "Export to Miro" modal opens
- [ ] Modal lists Miro boards; "shemma-e2e" appears
- [ ] Search box filters by name
- [ ] Click "shemma-e2e" → board id is highlighted; "Open ↗" link goes to https://miro.com/app/board/<id>
- [ ] Click "Next →" → confirmation screen shows selection count
- [ ] Click "Export" → spinner; result screen shows `✓ Exported N items + M connectors`
- [ ] Click "Open in Miro →" → browser opens the target Miro board

## 4. Visual verification in Miro

Open the "shemma-e2e" board in Miro. Verify:

- [ ] 3 geo shapes present with correct mapped shapes (rectangle → rectangle, ellipse → circle, diamond → rhombus)
- [ ] 2 sticky notes with named colors mapping reasonably to the source hex
- [ ] 2 connectors between correct shape pairs; snapTo sides plausibly match canvas anchors
- [ ] 1 frame with title; 2 child shapes inside the frame in Miro UI
- [ ] Text labels (richText) extract as plain text correctly

## 5. Tracking persistence

- [ ] In a new shell: `curl http://localhost:8787/api/rooms/default/export -o /tmp/room.json` (or open `~/.claude/projects/<slug>/canvas/default.json` directly) → contains `"meta": { "miroExports": { "<boardId>": { "boardName": "...", "items": { ... }, "connectors": { ... } } } }`
- [ ] Repeat export of the same selection to the same board → new items appear in Miro (append-only); tracking entries overwrite with new miroItemId values (old items remain orphaned in Miro)

## 6. Context menu

- [ ] Right-click in canvas with no selection → "Export to Miro" item is NOT visible
- [ ] Select 1 shape, right-click → "Export to Miro ⌘⇧E" item appears; clicking opens the modal

## 7. MCP tool

- [ ] Spin up `shemma mcp start` and invoke `shemma_export_miro({ boardId: "<id>", selection: ["shape:<id>"], dryRun: true })` via your MCP client → returns `{ ok: true, dryRun: true, itemCount: 1, ... }`
- [ ] Drop `dryRun` → tool returns `{ ok: true, itemsCreated: 1, boardUrl: "...", ... }`
- [ ] With missing token (after `shemma config unset miro.token`): tool returns `{ ok: false, code: "miro-token-missing", hint: "..." }`

## 8. Edge cases

- [ ] Free-floating arrow (no bindings) → skipped with `reason: "unsupported-type"`
- [ ] Cross-selection connector (target outside selection) → skipped with `reason: "cross-selection-connector"`
- [ ] Selection contains a group → group dropped, children exported individually
- [ ] Frame inside frame (nested) → outer becomes Miro frame, inner becomes shape (Miro frame-nesting limitation documented in §5.2)

## 9. Probe verification (Task 1 deferred items)

Task 1 used Miro SDK source as proxy for live API. Validate with real token:

- [ ] Run `scripts/probe-miro.sh` against a sandbox board (need `~/.config/shemma/probe-board-id.txt`)
- [ ] Section A — confirm 16 `style.fillColor` enum values returned in error match `SHAPE_PRESETS` in `apps/backend/src/export/miro/color-mapping.ts`
- [ ] Sections B/C/D — confirm whether `metadata` or `appData` field round-trips through GET items. If neither — current implementation (no inline tracking on Miro side) is correct.
- [ ] Section E — confirm `BULK_CHUNK_SIZE = 50` is safe; if 422 on 60-item bulk, lower the constant in `apps/backend/src/export/miro/upload.ts`.

## Sign-off

If all boxes are checked, DRW-103 is ready for the 0.19.0 release commit.
