import { describe, expect, it } from "bun:test";
import { ActiveRoomsTracker } from "./active-rooms";

describe("WsHub board-focus integration", () => {
  it("dispatches board-focus to tracker", () => {
    const tracker = new ActiveRoomsTracker();
    function handle(
      msg: { kind: string; room?: string; focused?: boolean },
      clientId: string,
    ) {
      if (msg.kind === "board-focus" && typeof msg.room === "string") {
        if (msg.focused) tracker.onFocus(msg.room, clientId);
        else tracker.onBlur(msg.room, clientId);
      }
    }
    handle({ kind: "board-focus", room: "r-1", focused: true }, "c-1");
    expect(tracker.list()[0]).toMatchObject({ room: "r-1", clientCount: 1 });
    handle({ kind: "board-focus", room: "r-1", focused: false }, "c-1");
    expect(tracker.list()).toEqual([]);
  });
});
