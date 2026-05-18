import { describe, expect, it } from "bun:test";
import type { WsClientMessage } from "./types";

describe("WsClientMessage", () => {
  it("accepts board-focus variant with room+focused", () => {
    const m: WsClientMessage = { kind: "board-focus", room: "drw-054", focused: true };
    expect(m.kind).toBe("board-focus");
  });

  it("accepts board-focus with focused=false", () => {
    const m: WsClientMessage = { kind: "board-focus", room: "x", focused: false };
    expect(m.focused).toBe(false);
  });
});
