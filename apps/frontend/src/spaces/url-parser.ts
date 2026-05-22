export type ShemmaUrlState =
  | { view: "landing" }
  | { view: "gallery"; spaceId: string }
  | { view: "room"; spaceId: string; roomId: string };

export function parseShemmaUrl(input: string | URL): ShemmaUrlState {
  const url = typeof input === "string" ? new URL(input, "http://x") : input;
  const params = url.searchParams;
  const space = params.get("space");
  if (!space) return { view: "landing" };
  const room = params.get("room");
  return room
    ? { view: "room", spaceId: space, roomId: room }
    : { view: "gallery", spaceId: space };
}

export function spaceUrl(spaceId: string, roomId?: string): string {
  const space = encodeURIComponent(spaceId);
  return roomId
    ? `/?space=${space}&room=${encodeURIComponent(roomId)}`
    : `/?space=${space}`;
}
