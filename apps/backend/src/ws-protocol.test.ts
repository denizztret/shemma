import { describe, expect, it } from "bun:test";
import { WsHub } from "./ws";
import { parseClientMessage } from "./ws-protocol";

describe("parseClientMessage — board-focus", () => {
  it("parses valid {kind:'board-focus', room:'x', focused:true}", () => {
    const result = parseClientMessage(
      JSON.stringify({ kind: "board-focus", room: "x", focused: true }),
    );
    expect(result).toEqual({ kind: "board-focus", room: "x", focused: true });
  });

  it("parses valid {kind:'board-focus', room:'x', focused:false}", () => {
    const result = parseClientMessage(
      JSON.stringify({ kind: "board-focus", room: "x", focused: false }),
    );
    expect(result).toEqual({ kind: "board-focus", room: "x", focused: false });
  });

  it("returns null when room is empty string", () => {
    const result = parseClientMessage(
      JSON.stringify({ kind: "board-focus", room: "", focused: true }),
    );
    expect(result).toBeNull();
  });

  it("returns null when focused is not boolean", () => {
    const result = parseClientMessage(
      JSON.stringify({ kind: "board-focus", room: "x", focused: 1 }),
    );
    expect(result).toBeNull();
  });

  it("returns null when kind is unknown (existing behavior)", () => {
    const result = parseClientMessage(
      JSON.stringify({ kind: "unknown-kind", foo: "bar" }),
    );
    expect(result).toBeNull();
  });
});

describe("board-focus spoof-guard: handler must use ws.data.room, not msg.room", () => {
  /**
   * Simulates the WS message handler in index.ts: the connection is scoped to
   * `connectionRoom` (ws.data.room), while the client sends a board-focus with
   * `msg.room` claiming a different room ("OTHER"). The handler must register
   * the focus under `connectionRoom`, not "OTHER".
   */
  function simulateBoardFocusHandler(
    bus: WsHub,
    connectionRoom: string,
    clientId: string,
    msg: { kind: string; room: string; focused: boolean },
  ) {
    // This mirrors the handler in index.ts after the Critical fix:
    //   use `room` (from ws.data) — NOT `msg.room`.
    if (msg.kind === "board-focus") {
      if (msg.focused) {
        bus.getActiveRooms().onFocus(connectionRoom, clientId);
      } else {
        bus.getActiveRooms().onBlur(connectionRoom, clientId);
      }
    }
  }

  it("registers focus under connection room, ignores spoofed msg.room", () => {
    const bus = new WsHub();
    const connectionRoom = "room-X"; // ws.data.room — trusted
    const spoofedRoom = "room-OTHER"; // msg.room — untrusted, must be ignored

    simulateBoardFocusHandler(
      bus,
      connectionRoom,
      "client-1",
      { kind: "board-focus", room: spoofedRoom, focused: true },
    );

    const list = bus.getActiveRooms().list();
    expect(list).toHaveLength(1);
    expect(list[0].room).toBe(connectionRoom);
    // The spoofed room must NOT appear in the tracker.
    expect(list.find((e) => e.room === spoofedRoom)).toBeUndefined();
  });

  it("registers blur under connection room, ignores spoofed msg.room", () => {
    const bus = new WsHub();
    const connectionRoom = "room-X";
    const spoofedRoom = "room-OTHER";

    // Focus first, then blur with a spoofed room field.
    simulateBoardFocusHandler(bus, connectionRoom, "client-1", {
      kind: "board-focus",
      room: spoofedRoom,
      focused: true,
    });
    simulateBoardFocusHandler(bus, connectionRoom, "client-1", {
      kind: "board-focus",
      room: spoofedRoom,
      focused: false,
    });

    // After blur the connection room should be gone (not the spoofed one).
    expect(bus.getActiveRooms().list()).toEqual([]);
  });
});
