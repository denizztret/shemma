import { CanvasClient } from "@shemma/client";

export function clientForRoom(base: CanvasClient, room: string | undefined): CanvasClient {
  if (!room) return base;
  return new CanvasClient({ baseUrl: base.baseUrl, room });
}
