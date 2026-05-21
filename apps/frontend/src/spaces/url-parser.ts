export type Column =
  | { kind: "gallery"; spaceId: string }
  | { kind: "room"; spaceId: string; roomId: string };

export type ShemmaUrlState =
  | { view: "landing" }
  | { view: "columns"; columns: Column[] };

const MAX_COLUMNS = 3;

export function parseShemmaUrl(input: string | URL): ShemmaUrlState {
  const url = typeof input === "string" ? new URL(input, "http://x") : input;
  const params = url.searchParams;

  // Multi-column form (cols=)
  const cols = params.get("cols");
  if (cols) {
    const columns = cols.split(",").slice(0, MAX_COLUMNS).map(tuple => {
      const [spaceId, roomId] = tuple.split(":");
      return roomId ? { kind: "room" as const, spaceId, roomId } : { kind: "gallery" as const, spaceId };
    });
    return { view: "columns", columns };
  }

  // Single-column legacy form (space + optional room)
  const space = params.get("space");
  if (space) {
    const room = params.get("room");
    return {
      view: "columns",
      columns: [room ? { kind: "room", spaceId: space, roomId: room } : { kind: "gallery", spaceId: space }],
    };
  }

  return { view: "landing" };
}

export function serializeColumns(columns: Column[]): string {
  if (columns.length === 1) {
    const c = columns[0];
    return c.kind === "room"
      ? `?space=${encodeURIComponent(c.spaceId)}&room=${encodeURIComponent(c.roomId)}`
      : `?space=${encodeURIComponent(c.spaceId)}`;
  }
  const cols = columns.map(c => c.kind === "room" ? `${c.spaceId}:${c.roomId}` : c.spaceId).join(",");
  return `?cols=${encodeURIComponent(cols).replaceAll("%2C", ",")}`;
}
