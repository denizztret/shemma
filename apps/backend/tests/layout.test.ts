import { describe, expect, test } from "bun:test";
import { layoutNodes } from "../src/layout-engine";

test("layered layout assigns distinct x for chained nodes", async () => {
  const positions = await layoutNodes(
    [
      { id: "a", w: 80, h: 40 },
      { id: "b", w: 80, h: 40 },
    ],
    [
      {
        id: "e",
        from: { kind: "node", id: "a" },
        to: { kind: "node", id: "b" },
      },
    ],
  );
  expect(positions.a.x).not.toBe(positions.b.x);
}, 30_000);
