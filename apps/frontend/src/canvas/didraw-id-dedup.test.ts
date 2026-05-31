import { describe, expect, test } from "bun:test";
import { type DidrawRegen, planDidrawRegen } from "./didraw-id-dedup";

// Deterministic generator: <slug>-0, -1, … skipping reserved ids.
function makeGen() {
  return (slug: string, existing: ReadonlySet<string>): string => {
    let i = 0;
    let id = `${slug}-${i}`;
    while (existing.has(id)) id = `${slug}-${++i}`;
    return id;
  };
}

describe("planDidrawRegen", () => {
  test("no collision → empty plan, ids reserved", () => {
    const existing = new Set(["api-aaaaaa"]);
    const plan = planDidrawRegen(
      [{ id: "shape:1", didrawId: "db-bbbbbb" }],
      existing,
      makeGen(),
    );
    expect(plan).toEqual([]);
    expect(existing.has("db-bbbbbb")).toBe(true); // first sighting reserved
  });

  test("collision → regen with same slug, fresh id", () => {
    const existing = new Set(["api-gateway-aaaaaa"]);
    const plan = planDidrawRegen(
      [{ id: "shape:copy", didrawId: "api-gateway-aaaaaa" }],
      existing,
      makeGen(),
    );
    expect(plan).toHaveLength(1);
    const r = plan[0] as DidrawRegen;
    expect(r.shapeId).toBe("shape:copy");
    expect(r.oldDidrawId).toBe("api-gateway-aaaaaa");
    expect(r.newDidrawId).toBe("api-gateway-0"); // slug preserved
    expect(existing.has("api-gateway-0")).toBe(true);
  });

  test("multiple duplicates of same id → all unique", () => {
    const existing = new Set(["n-aaaaaa"]);
    const plan = planDidrawRegen(
      [
        { id: "shape:a", didrawId: "n-aaaaaa" },
        { id: "shape:b", didrawId: "n-aaaaaa" },
      ],
      existing,
      makeGen(),
    );
    expect(plan.map((p) => p.newDidrawId)).toEqual(["n-0", "n-1"]);
  });

  test("shape without didrawId skipped", () => {
    const plan = planDidrawRegen(
      [{ id: "shape:x" }],
      new Set<string>(),
      makeGen(),
    );
    expect(plan).toEqual([]);
  });

  test("gen exhaustion (throws) → keep as-is, no plan entry", () => {
    const existing = new Set(["n-aaaaaa"]);
    const throwing = () => {
      throw new Error("nodeId-collision");
    };
    const plan = planDidrawRegen(
      [{ id: "shape:a", didrawId: "n-aaaaaa" }],
      existing,
      throwing,
    );
    expect(plan).toEqual([]);
  });

  test("slug fallback for malformed id (no dash)", () => {
    const existing = new Set(["weird"]);
    const plan = planDidrawRegen(
      [{ id: "shape:a", didrawId: "weird" }],
      existing,
      makeGen(),
    );
    expect(plan[0]?.newDidrawId).toBe("e-0"); // slugOf("weird") → "e"
  });
});
