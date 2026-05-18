// packages/shemma-mcp/src/room-resolver.ts

export type ActiveRoom = { room: string; clientCount: number; lastFocusedAt: number };

export type InProgressTask = { id: string; slug: string };

export type RoomSource = "arg" | "config" | "session" | "active" | "task" | "lastTouched" | "default";

export type ResolveSuccess = { ok: true; room: string; source: RoomSource };
export type ResolveAmbiguous = {
  ok: false;
  code: "ambiguous-room";
  message: string;
  candidates: Array<{ room: string; source: RoomSource; lastFocusedAt?: number; clientCount?: number }>;
};
export type ResolveResult = ResolveSuccess | ResolveAmbiguous;

export type RoomResolverOpts = {
  configRoom: string | undefined;
  sessionEnv: string | undefined;
  getActiveRooms: () => Promise<{ rooms: ActiveRoom[] }>;
  getInProgressTasks: () => Promise<InProgressTask[]>;
};

export class RoomResolver {
  private lastTouched?: string;
  constructor(private opts: RoomResolverOpts) {}

  recordTouch(room: string): void {
    this.lastTouched = room;
  }

  async resolve(input: { argRoom?: string }): Promise<ResolveResult> {
    if (input.argRoom) return { ok: true, room: input.argRoom, source: "arg" };
    if (this.opts.configRoom) return { ok: true, room: this.opts.configRoom, source: "config" };
    if (this.opts.sessionEnv) return { ok: true, room: this.opts.sessionEnv, source: "session" };

    const active = (await this.opts.getActiveRooms()).rooms;
    if (active.length === 1) return { ok: true, room: active[0].room, source: "active" };
    if (active.length > 1) {
      return {
        ok: false,
        code: "ambiguous-room",
        message: "Multiple boards open; please specify `room` arg.",
        candidates: active.map((a) => ({
          room: a.room,
          source: "active",
          lastFocusedAt: a.lastFocusedAt,
          clientCount: a.clientCount,
        })),
      };
    }

    const tasks = await this.opts.getInProgressTasks();
    if (tasks.length === 1) return { ok: true, room: tasks[0].slug, source: "task" };
    if (tasks.length > 1) {
      return {
        ok: false,
        code: "ambiguous-room",
        message: "Multiple In Progress tasks; please specify `room` arg.",
        candidates: tasks.map((t) => ({ room: t.slug, source: "task" })),
      };
    }

    if (this.lastTouched) return { ok: true, room: this.lastTouched, source: "lastTouched" };
    return { ok: true, room: "default", source: "default" };
  }
}
