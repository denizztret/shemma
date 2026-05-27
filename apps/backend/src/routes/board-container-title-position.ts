import { Hono } from "hono";

// DRW-186 phase 2: split "outside" → "outside-frame" / "outside-banner".
// Legacy "outside" больше не принимается endpoint'ом — миграция значения
// `room.meta.containerTitlePosition` происходит на стороне frontend через
// normalizeTitlePosition() при чтении (см. SettingsPopover useEffect для
// containerTitlePosition). Backend остаётся strict — новые POST'ы должны
// присылать только canonical 4-value enum.
const VALID = [
  "outside-frame",
  "outside-banner",
  "inside-center",
  "inside-left",
] as const;
type ContainerTitlePosition = (typeof VALID)[number];

export type BoardContainerTitlePositionDeps = {
  getRoom: (
    space: string,
    room: string,
  ) => Promise<{ meta?: Record<string, unknown> } | undefined>;
  persistRoom: (space: string, room: string) => void;
  broadcastRoomMeta: (space: string, room: string) => void;
};

export function boardContainerTitlePositionRoutes(
  deps: BoardContainerTitlePositionDeps,
) {
  return new Hono()
    .get("/api/board/container-title-position", async (c) => {
      const space = c.req.query("space");
      const room = c.req.query("room");
      if (!space || !room) {
        return c.json({ error: "space and room required" }, 400);
      }

      const r = await deps.getRoom(space, room);
      const value =
        (r?.meta?.containerTitlePosition as
          | ContainerTitlePosition
          | undefined) ?? null;
      return c.json({ value });
    })
    .post("/api/board/container-title-position", async (c) => {
      const space = c.req.query("space");
      const room = c.req.query("room");
      if (!space || !room) {
        return c.json({ error: "space and room required" }, 400);
      }

      const body = await c.req
        .json<{ value?: ContainerTitlePosition | null }>()
        .catch(
          () => ({}) as { value?: ContainerTitlePosition | null },
        );
      const value = body.value;

      if (value !== null && value !== undefined) {
        if (!VALID.includes(value as ContainerTitlePosition)) {
          return c.json(
            {
              error: `value must be one of ${VALID.join(", ")} or null`,
            },
            400,
          );
        }
      }

      const r = await deps.getRoom(space, room);
      if (!r) return c.json({ error: "room not found" }, 404);

      if (!r.meta) r.meta = {};
      const meta = r.meta as Record<string, unknown>;
      if (value === null || value === undefined) {
        delete meta.containerTitlePosition;
      } else {
        meta.containerTitlePosition = value;
      }

      deps.persistRoom(space, room);
      deps.broadcastRoomMeta(space, room);

      return c.json({ ok: true });
    });
}
