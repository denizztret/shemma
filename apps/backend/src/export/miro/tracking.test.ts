import { describe, expect, it } from "bun:test";
import { makeRoomState } from "../../rooms";
import {
  commitBoardExport,
  getLastUsedBoardId,
  readBoardItems,
  readBoardTracking,
} from "./tracking";

describe("readBoardTracking", () => {
  it("returns undefined when room has no meta", () => {
    const room = makeRoomState();
    expect(readBoardTracking(room, "b1")).toBeUndefined();
  });

  it("returns undefined when board absent", () => {
    const room = makeRoomState();
    room.meta = { miroExports: {} };
    expect(readBoardTracking(room, "missing")).toBeUndefined();
  });

  it("returns existing tracking entry", () => {
    const room = makeRoomState();
    room.meta = {
      miroExports: {
        b1: {
          boardName: "B1",
          lastExportedAt: "2026-05-20T10:00:00.000Z",
          items: { "shape:e_api": "miro-1" },
        },
      },
    };
    const t = readBoardTracking(room, "b1");
    expect(t?.boardName).toBe("B1");
  });
});

describe("commitBoardExport — merges items + connectors", () => {
  it("creates miroExports[boardId] on first commit", () => {
    const room = makeRoomState();
    commitBoardExport(room, {
      boardId: "b1",
      boardName: "Board 1",
      itemMappings: [{ elementId: "shape:e_api", miroItemId: "m-1" }],
      connectorMappings: [],
    });
    expect(room.meta?.miroExports?.b1?.boardName).toBe("Board 1");
    expect(room.meta?.miroExports?.b1?.items["shape:e_api"]).toBe("m-1");
  });

  it("merges items across multiple commits to same board", () => {
    const room = makeRoomState();
    commitBoardExport(room, {
      boardId: "b1",
      itemMappings: [{ elementId: "shape:A", miroItemId: "m-A" }],
      connectorMappings: [],
    });
    commitBoardExport(room, {
      boardId: "b1",
      itemMappings: [{ elementId: "shape:B", miroItemId: "m-B" }],
      connectorMappings: [],
    });
    expect(room.meta?.miroExports?.b1?.items).toEqual({
      "shape:A": "m-A",
      "shape:B": "m-B",
    });
  });

  it("stores connectors in separate map", () => {
    const room = makeRoomState();
    commitBoardExport(room, {
      boardId: "b1",
      itemMappings: [],
      connectorMappings: [{ elementId: "shape:arr", miroConnectorId: "c-1" }],
    });
    expect(room.meta?.miroExports?.b1?.connectors?.["shape:arr"]).toBe("c-1");
  });

  it("updates lastExportedAt on each commit", async () => {
    const room = makeRoomState();
    commitBoardExport(room, { boardId: "b1", itemMappings: [], connectorMappings: [] });
    const t1 = room.meta?.miroExports?.b1?.lastExportedAt;
    await new Promise((r) => setTimeout(r, 5));
    commitBoardExport(room, { boardId: "b1", itemMappings: [], connectorMappings: [] });
    const t2 = room.meta?.miroExports?.b1?.lastExportedAt;
    expect(t2).not.toBe(t1);
  });
});

describe("getLastUsedBoardId", () => {
  it("returns undefined when no exports recorded", () => {
    const room = makeRoomState();
    expect(getLastUsedBoardId(room)).toBeUndefined();
  });

  it("returns the boardId with the most recent lastExportedAt", () => {
    const room = makeRoomState();
    room.meta = {
      miroExports: {
        old: { lastExportedAt: "2026-05-01T10:00:00.000Z", items: {} },
        recent: { lastExportedAt: "2026-05-20T10:00:00.000Z", items: {} },
        mid: { lastExportedAt: "2026-05-10T10:00:00.000Z", items: {} },
      },
    };
    expect(getLastUsedBoardId(room)).toBe("recent");
  });
});

describe("readBoardItems", () => {
  it("returns empty map when board absent", () => {
    const room = makeRoomState();
    expect(readBoardItems(room, "missing")).toEqual({});
  });

  it("returns items map", () => {
    const room = makeRoomState();
    room.meta = {
      miroExports: {
        b1: {
          lastExportedAt: "2026-05-20T10:00:00.000Z",
          items: { "shape:e_api": "m1", "shape:e_db": "m2" },
        },
      },
    };
    expect(readBoardItems(room, "b1")).toEqual({ "shape:e_api": "m1", "shape:e_db": "m2" });
  });
});
