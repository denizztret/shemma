import { describe, expect, test } from "bun:test";
import type { TLShape } from "tldraw";
import {
  bestLinkId,
  buildObjectLink,
  parseIdParam,
  resolveTokenToShapes,
  resolveUrlIds,
} from "./deep-link";

function shape(id: string, meta: Record<string, unknown> = {}): TLShape {
  return { id, type: "geo", meta } as unknown as TLShape;
}

describe("resolveTokenToShapes", () => {
  const shapes = [
    shape("shape:aaa", { didrawId: "api-a1b2c3", didrawLabel: "API" }),
    shape("shape:bbb", { didrawId: "db-x9y8z7", didrawLabel: "DB" }),
    shape("shape:ccc", { didrawName: "legacy-node" }),
    shape("shape:ddd", {}), // bare tldraw shape, no didraw identity
  ];

  test("раздробленный/пустой токен → []", () => {
    expect(resolveTokenToShapes(shapes, "")).toEqual([]);
    expect(resolveTokenToShapes(shapes, "   ")).toEqual([]);
  });

  test("сырой shape:id — точное совпадение", () => {
    expect(resolveTokenToShapes(shapes, "shape:ddd")).toEqual([
      "shape:ddd" as unknown as TLShape["id"],
    ]);
  });

  test("сырой shape:id — промах → []", () => {
    expect(resolveTokenToShapes(shapes, "shape:zzz")).toEqual([]);
  });

  test("didrawId — одиночное совпадение", () => {
    expect(resolveTokenToShapes(shapes, "api-a1b2c3")).toEqual([
      "shape:aaa" as unknown as TLShape["id"],
    ]);
  });

  test("didrawId — коллизия после дубля → все совпадения", () => {
    const dup = [
      shape("shape:aaa", { didrawId: "api-a1b2c3" }),
      shape("shape:eee", { didrawId: "api-a1b2c3" }), // duplicate carries same didrawId
    ];
    expect(resolveTokenToShapes(dup, "api-a1b2c3")).toEqual([
      "shape:aaa" as unknown as TLShape["id"],
      "shape:eee" as unknown as TLShape["id"],
    ]);
  });

  test("didrawName (v1)", () => {
    expect(resolveTokenToShapes(shapes, "legacy-node")).toEqual([
      "shape:ccc" as unknown as TLShape["id"],
    ]);
  });

  test("label — резолвится только если единственный", () => {
    expect(resolveTokenToShapes(shapes, "API")).toEqual([
      "shape:aaa" as unknown as TLShape["id"],
    ]);
  });

  test("label — неоднозначный (>1) не резолвится", () => {
    const ambiguous = [
      shape("shape:p", { didrawLabel: "Service" }),
      shape("shape:q", { didrawLabel: "Service" }),
    ];
    expect(resolveTokenToShapes(ambiguous, "Service")).toEqual([]);
  });

  test("приоритет: didrawId побеждает label при коллизии строки", () => {
    // токен "shared" одновременно didrawId шейпа X и label шейпа Y →
    // резолвится в X (tier 2 раньше tier 4).
    const mixed = [
      shape("shape:x", { didrawId: "shared" }),
      shape("shape:y", { didrawLabel: "shared" }),
    ];
    expect(resolveTokenToShapes(mixed, "shared")).toEqual([
      "shape:x" as unknown as TLShape["id"],
    ]);
  });
});

describe("resolveUrlIds", () => {
  const shapes = [
    shape("shape:aaa", { didrawId: "api-1" }),
    shape("shape:bbb", { didrawId: "db-2" }),
    shape("shape:ccc", { didrawId: "web-3" }),
  ];

  test("несколько токенов, порядок сохранён", () => {
    expect(resolveUrlIds(shapes, ["web-3", "api-1"])).toEqual([
      "shape:ccc" as unknown as TLShape["id"],
      "shape:aaa" as unknown as TLShape["id"],
    ]);
  });

  test("дедуп при повторных/пересекающихся токенах", () => {
    expect(resolveUrlIds(shapes, ["api-1", "shape:aaa", "api-1"])).toEqual([
      "shape:aaa" as unknown as TLShape["id"],
    ]);
  });

  test("нерезолвящиеся токены пропускаются", () => {
    expect(resolveUrlIds(shapes, ["nope", "db-2"])).toEqual([
      "shape:bbb" as unknown as TLShape["id"],
    ]);
  });
});

describe("parseIdParam", () => {
  test("null/undefined/пусто → []", () => {
    expect(parseIdParam(null)).toEqual([]);
    expect(parseIdParam(undefined)).toEqual([]);
    expect(parseIdParam("")).toEqual([]);
  });

  test("одиночный токен", () => {
    expect(parseIdParam("api-1")).toEqual(["api-1"]);
  });

  test("comma-список с пробелами и пустыми сегментами", () => {
    expect(parseIdParam("a, b , ,c")).toEqual(["a", "b", "c"]);
  });
});

describe("bestLinkId", () => {
  test("didrawId в приоритете", () => {
    expect(
      bestLinkId(shape("shape:a", { didrawId: "api-1", didrawName: "api" })),
    ).toBe("api-1");
  });

  test("fallback на didrawName", () => {
    expect(bestLinkId(shape("shape:a", { didrawName: "api" }))).toBe("api");
  });

  test("fallback на сырой shape:id", () => {
    expect(bestLinkId(shape("shape:a", {}))).toBe("shape:a");
  });
});

describe("buildObjectLink", () => {
  const base = {
    origin: "http://localhost:5173",
    pathname: "/",
    space: "di-draw",
    room: "port-test-clean",
  };

  test("одиночный объект → didrawId в id", () => {
    expect(
      buildObjectLink({
        ...base,
        shapes: [shape("shape:a", { didrawId: "api-1" })],
      }),
    ).toBe(
      "http://localhost:5173/?space=di-draw&room=port-test-clean&id=api-1",
    );
  });

  test("несколько объектов → comma-список", () => {
    expect(
      buildObjectLink({
        ...base,
        shapes: [
          shape("shape:a", { didrawId: "api-1" }),
          shape("shape:b", { didrawId: "db-2" }),
        ],
      }),
    ).toBe(
      "http://localhost:5173/?space=di-draw&room=port-test-clean&id=api-1,db-2",
    );
  });

  test("сырой shape:id кодируется (двоеточие), но разделитель-запятая сырой", () => {
    const link = buildObjectLink({
      ...base,
      shapes: [shape("shape:Abc", {}), shape("shape:Def", {})],
    });
    expect(link).toBe(
      "http://localhost:5173/?space=di-draw&room=port-test-clean&id=shape%3AAbc,shape%3ADef",
    );
    // round-trip: URLSearchParams декодирует обратно в исходные токены
    const got = new URL(link).searchParams.get("id");
    expect(parseIdParam(got)).toEqual(["shape:Abc", "shape:Def"]);
  });
});
