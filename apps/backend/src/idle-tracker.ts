/**
 * DRW-116 Task 7 — Idle-shutdown tracker.
 *
 * Daemon self-exits after a configurable idle window (default 30 min) when no
 * HTTP requests arrive and no WebSocket connections are open. Wire `noteHttp`
 * into an `/api/*` middleware and `noteWsOpen`/`noteWsClose` into the WS
 * lifecycle callbacks. While `wsCount > 0` the timer never fires — long-running
 * editor sessions stay alive regardless of inactivity.
 *
 * Override window via env `SHEMMA_IDLE_SHUTDOWN_MS` (>=0). A value of 0 (or
 * negative) disables the tracker entirely — no interval is scheduled.
 */
const DEFAULT_IDLE_MS = Number(
  process.env.SHEMMA_IDLE_SHUTDOWN_MS ?? 1_800_000,
);

export class IdleTracker {
  private wsCount = 0;
  private lastActivity = Date.now();
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private idleMs: number = DEFAULT_IDLE_MS,
    private onIdle: () => void = () => process.exit(0),
  ) {
    if (this.idleMs > 0) {
      this.timer = setInterval(
        () => this.check(),
        Math.min(60_000, Math.max(50, this.idleMs / 4)),
      );
    }
  }

  noteHttp(): void {
    this.lastActivity = Date.now();
  }

  noteWsOpen(): void {
    this.wsCount++;
    this.lastActivity = Date.now();
  }

  noteWsClose(): void {
    this.wsCount = Math.max(0, this.wsCount - 1);
    this.lastActivity = Date.now();
  }

  private check(): void {
    if (this.wsCount > 0) return;
    if (Date.now() - this.lastActivity > this.idleMs) {
      this.onIdle();
    }
  }

  shutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
