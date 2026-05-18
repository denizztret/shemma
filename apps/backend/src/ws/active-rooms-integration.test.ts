import { describe, expect, it } from "bun:test";
import { WsHub } from "../ws";

describe("WsHub.getActiveRooms()", () => {
  it("returns the same tracker instance across calls", () => {
    const bus = new WsHub();
    const t1 = bus.getActiveRooms();
    const t2 = bus.getActiveRooms();
    expect(t1).toBe(t2);
  });

  it("tracker state is observable via getActiveRooms()", () => {
    const bus = new WsHub();
    bus.getActiveRooms().onFocus("room-a", "client-1");
    expect(bus.getActiveRooms().list()).toHaveLength(1);
    expect(bus.getActiveRooms().list()[0]).toMatchObject({
      room: "room-a",
      clientCount: 1,
    });
  });

  it("tracker state reflects blur via getActiveRooms()", () => {
    const bus = new WsHub();
    bus.getActiveRooms().onFocus("room-a", "client-1");
    bus.getActiveRooms().onBlur("room-a", "client-1");
    expect(bus.getActiveRooms().list()).toEqual([]);
  });
});
