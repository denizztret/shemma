import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "@shemma/client";
import type { AutoOpenManager } from "../auto-open";
import { toolResult, type ToolResult } from "../errors";
import { resolveSpaceOrError, type ResolveSpaceFn } from "../space-resolver";

export type OpenDeps = {
  autoOpen: AutoOpenManager;
  defaultRoom: string;
  /** DRW-116 Task 26: DI seam for tests; defaults to real resolver. */
  resolveSpace?: ResolveSpaceFn;
  /**
   * DRW-133 (P1.4): client used to poll /api/active-rooms when the caller
   * passes `waitForClient: true`. Reuses the shared CanvasClient (same base
   * URL as other read-only MCP tools) so the test seam stays simple.
   */
  client: CanvasClient;
  /** DRW-133: DI seam for sleeping during polling; defaults to real timer. */
  sleep?: (ms: number) => Promise<void>;
};

export type OpenInput = {
  room?: string;
  space?: string;
  noBrowser?: boolean;
  /** DRW-133: poll /api/active-rooms after spawn until target room has a WS client. */
  waitForClient?: boolean;
  /** DRW-133: cap for the wait loop. Default 5000 when `waitForClient: true`. */
  timeoutMs?: number;
};

export type OpenHandles = {
  open: { call: (input: OpenInput) => Promise<ToolResult> };
};

// DRW-133: tuned for "WS reconnect after hard-reload usually lands within
// 200-500ms" while not hammering the daemon. 100ms initial keeps the latency
// for the happy path snappy; capping at 500ms keeps slow-start cases bounded.
const POLL_INITIAL_MS = 100;
const POLL_MAX_MS = 500;
const DEFAULT_WAIT_TIMEOUT_MS = 5000;

/**
 * DRW-133: polls `/api/active-rooms?space=<id>` until the target room shows
 * up with `clientCount > 0`, or the budget runs out. Returns `null` on
 * timeout so the caller surfaces `connected: false` in the tool response —
 * the agent can decide whether to retry or fall back to a DevTools-driven
 * import path.
 */
export async function waitForClientConnection(args: {
  client: CanvasClient;
  space: string;
  room: string;
  timeoutMs: number;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<{ waitedMs: number } | null> {
  const now = args.now ?? (() => Date.now());
  const start = now();
  let delay = POLL_INITIAL_MS;
  while (true) {
    const elapsed = now() - start;
    if (elapsed >= args.timeoutMs) return null;
    try {
      const data = await args.client.getActiveRooms({ space: args.space });
      const found = data.rooms.some(
        (r) => r.room === args.room && r.clientCount > 0,
      );
      if (found) return { waitedMs: now() - start };
    } catch {
      // Treat transient fetch errors as "not connected yet" — the next poll
      // attempt may succeed. Hard failures (daemon dead) will keep failing
      // and naturally surface as `connected: false` at timeout.
    }
    const remaining = args.timeoutMs - (now() - start);
    if (remaining <= 0) return null;
    await args.sleep(Math.min(delay, remaining));
    delay = Math.min(delay * 2, POLL_MAX_MS);
  }
}

export function registerOpenTool(server: McpServer, deps: OpenDeps): OpenHandles {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  async function openCall(input: OpenInput): Promise<ToolResult> {
    // Resolve space first — even though the spawn subprocess does not yet
    // thread `space` through, surfacing ambiguity here keeps the contract
    // uniform across MCP tools (Task 26).
    const spaceRes = resolveSpaceOrError(deps, input.space);
    if ("error" in spaceRes) return spaceRes.error;

    const room = input.room ?? deps.defaultRoom;
    if (input.noBrowser) {
      return toolResult({ ok: true, room, data: { spawned: false, reason: "noBrowser" } });
    }
    try {
      await deps.autoOpen.open(room);
      if (!input.waitForClient) {
        return toolResult({ ok: true, room, data: { spawned: true } });
      }
      // DRW-133: poll the daemon's ActiveRoomsTracker until the browser
      // establishes a WS connection. Returns `connected: false` on timeout
      // so the caller can decide whether to retry/escalate.
      const timeoutMs = input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
      const waited = await waitForClientConnection({
        client: deps.client,
        space: spaceRes.spaceId,
        room,
        timeoutMs,
        sleep,
      });
      if (waited) {
        return toolResult({
          ok: true,
          room,
          data: { spawned: true, connected: true, waitedMs: waited.waitedMs },
        });
      }
      return toolResult({
        ok: true,
        room,
        data: { spawned: true, connected: false, waitedMs: timeoutMs },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return toolResult({ ok: false, code: "unexpected-error", message: `failed to open: ${msg}` });
    }
  }

  server.registerTool(
    "shemma_open",
    {
      description:
        "Open a browser tab on the canvas. By default uses the resolved/default room.\n\nResponse `spawned: true` means a browser launch was attempted — it does NOT guarantee that the page loaded or established a WebSocket. Pass `waitForClient: true` (with optional `timeoutMs`, default 5000) to block until the daemon sees a connected WS client for the target room (or the budget runs out); response then includes `connected: boolean` and `waitedMs` (DRW-133).\n\nFor workflows that depend on a live client (e.g. `shemma_import_mermaid`), prefer `waitForClient: true` over open-then-retry loops.\n\nTroubleshooting:\n- spawned:true, connected:false after wait: the browser opened the URL but failed to subscribe — usually a stale frontend bundle or an extension blocking WS. Hard-reload (Cmd+Shift+R); if still empty, `shemma daemon stop && shemma daemon start` to rebuild.\n- Multiple tabs open on the same room: native `open <url>` reuses the tab in Chrome, opens a new one in Safari. Currently no MCP-side dedupe (tracked as Q9 follow-up).\n- Space errors (invalid_space_id / space_not_found): see `shemma_rooms_list` for registered spaces; pass `space=<id>`.",
      inputSchema: {
        room: z.string().optional(),
        space: z.string().optional(),
        noBrowser: z.boolean().optional(),
        waitForClient: z.boolean().optional(),
        timeoutMs: z.number().optional(),
      },
      annotations: { openWorldHint: true },
    },
    async (args) => openCall(args as OpenInput),
  );

  return { open: { call: openCall } };
}
