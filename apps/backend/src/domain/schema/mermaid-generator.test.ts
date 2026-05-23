import { describe, test, expect } from "bun:test";
import { generateMermaid } from "./mermaid-generator";
import { parseMermaidFlowchart } from "./mermaid-parser";
import type {
  SchemaAction,
  SchemaDefineAction,
  SchemaConnectAction,
  SchemaGroupAction,
} from "@shemma/domain";
import type { NodeId } from "@shemma/domain";
import type { Role } from "@shemma/domain";
import type { ConnectionKind } from "@shemma/domain";

// ---- Test helpers ----

/** Deterministic ID generator for round-trip tests */
function makeTestGenerator() {
  return function generateId(slug: string, _existing: ReadonlySet<NodeId>, _mermaidId: string): NodeId {
    if (slug === "" || slug === "shape") return `e-aaaaaa`;
    return `${slug}-aaaaaa`;
  };
}

function parse(raw: string) {
  return parseMermaidFlowchart(raw, {
    suffixLen: 6,
    generateId: makeTestGenerator(),
  });
}

function define(
  nodeId: NodeId,
  role: Role,
  label?: string,
): SchemaDefineAction {
  return { kind: "schema-define", nodeId, role, ...(label !== undefined ? { label } : {}) };
}

function connect(
  from: NodeId,
  to: NodeId,
  connectionKind?: ConnectionKind,
  label?: string,
): SchemaConnectAction {
  return {
    kind: "schema-connect",
    from,
    to,
    ...(connectionKind !== undefined ? { connectionKind } : {}),
    ...(label !== undefined ? { label } : {}),
  };
}

function group(
  name: NodeId,
  label: string,
  nodeIds: NodeId[],
  as: "boundary" | "network" = "boundary",
): SchemaGroupAction {
  return { kind: "schema-group", name, label, nodeIds, as };
}

// ---- Tests: node shape syntax per role ----

describe("generateMermaid — node shape syntax (role → mermaid)", () => {
  test("service role → rect [Label]", () => {
    const result = generateMermaid({
      actions: [define("api-x9k2lm", "service", "API")],
      direction: "LR",
    });
    expect(result).toBe("graph LR\n  api-x9k2lm[API]");
  });

  test("datastore role → cylinder [(Label)]", () => {
    const result = generateMermaid({
      actions: [define("db-x9k2lm", "datastore", "Database")],
      direction: "TD",
    });
    expect(result).toBe("graph TD\n  db-x9k2lm[(Database)]");
  });

  test("actor role → circle ((Label))", () => {
    const result = generateMermaid({
      actions: [define("user-x9k2lm", "actor", "User")],
      direction: "LR",
    });
    expect(result).toBe("graph LR\n  user-x9k2lm((User))");
  });

  test("external role → asymmetric >Label]", () => {
    const result = generateMermaid({
      actions: [define("ext-x9k2lm", "external", "External")],
      direction: "LR",
    });
    expect(result).toBe("graph LR\n  ext-x9k2lm>External]");
  });

  test("queue role → rect [Label] (mapped to service shape)", () => {
    const result = generateMermaid({
      actions: [define("q-x9k2lm", "queue", "Queue")],
      direction: "LR",
    });
    expect(result).toBe("graph LR\n  q-x9k2lm[Queue]");
  });

  test("note role → rect [Label]", () => {
    const result = generateMermaid({
      actions: [define("n-x9k2lm", "note", "Note")],
      direction: "LR",
    });
    expect(result).toBe("graph LR\n  n-x9k2lm[Note]");
  });
});

// ---- Tests: edge arrow syntax ----

describe("generateMermaid — edge arrow syntax (connectionKind → mermaid)", () => {
  test("define + connect (sync) → rect nodes + --> arrow", () => {
    const result = generateMermaid({
      actions: [
        define("api-x9k2lm", "service", "API"),
        define("db-x9k2lm", "datastore", "DB"),
        connect("api-x9k2lm", "db-x9k2lm", "sync"),
      ],
      direction: "LR",
    });
    expect(result).toContain("api-x9k2lm[API]");
    expect(result).toContain("  api-x9k2lm --> db-x9k2lm");
  });

  test("dep connectionKind → -.->", () => {
    const result = generateMermaid({
      actions: [
        define("a-x9k2lm", "service", "A"),
        define("b-x9k2lm", "service", "B"),
        connect("a-x9k2lm", "b-x9k2lm", "dep"),
      ],
      direction: "LR",
    });
    expect(result).toContain("a-x9k2lm -.-> b-x9k2lm");
  });

  test("data connectionKind → ==>", () => {
    const result = generateMermaid({
      actions: [
        define("a-x9k2lm", "service", "A"),
        define("b-x9k2lm", "service", "B"),
        connect("a-x9k2lm", "b-x9k2lm", "data"),
      ],
      direction: "LR",
    });
    expect(result).toContain("a-x9k2lm ==> b-x9k2lm");
  });

  test("async connectionKind → --x", () => {
    const result = generateMermaid({
      actions: [
        define("a-x9k2lm", "service", "A"),
        define("b-x9k2lm", "service", "B"),
        connect("a-x9k2lm", "b-x9k2lm", "async"),
      ],
      direction: "LR",
    });
    expect(result).toContain("a-x9k2lm --x b-x9k2lm");
  });

  test("undefined connectionKind → --> (default sync)", () => {
    const result = generateMermaid({
      actions: [
        define("a-x9k2lm", "service"),
        define("b-x9k2lm", "service"),
        connect("a-x9k2lm", "b-x9k2lm"),
      ],
      direction: "LR",
    });
    expect(result).toContain("a-x9k2lm --> b-x9k2lm");
  });

  test("edge with label → -->|label| syntax", () => {
    const result = generateMermaid({
      actions: [
        define("a-x9k2lm", "service", "A"),
        define("b-x9k2lm", "service", "B"),
        connect("a-x9k2lm", "b-x9k2lm", "sync", "calls"),
      ],
      direction: "LR",
    });
    expect(result).toContain("a-x9k2lm -->|calls| b-x9k2lm");
  });
});

// ---- Tests: subgraph blocks ----

describe("generateMermaid — subgraph blocks", () => {
  test("group action → subgraph block with children inside", () => {
    const result = generateMermaid({
      actions: [
        define("a-aaaaaa", "service", "Service A"),
        define("b-aaaaaa", "service", "Service B"),
        group("auth-aaaaaa", "Authentication", ["a-aaaaaa", "b-aaaaaa"]),
      ],
      direction: "LR",
    });

    expect(result).toContain("subgraph auth-aaaaaa [Authentication]");
    expect(result).toContain("    a-aaaaaa[Service A]");
    expect(result).toContain("    b-aaaaaa[Service B]");
    expect(result).toContain("  end");
    // Children should NOT appear in top-level declarations
    const lines = result.split("\n");
    const topLevel = lines.filter(
      (l) => l.startsWith("  ") && !l.startsWith("    ") && !l.includes("subgraph") && !l.includes("end"),
    );
    // Only edges or standalone nodes would be at top level; a-aaaaaa and b-aaaaaa are in subgraph
    expect(topLevel.every((l) => !l.includes("a-aaaaaa[") && !l.includes("b-aaaaaa["))).toBe(true);
  });

  test("subgraph block uses name as mermaid id", () => {
    const result = generateMermaid({
      actions: [
        define("svc-aaaaaa", "service", "Service"),
        group("sg-aaaaaa", "My Group", ["svc-aaaaaa"]),
      ],
      direction: "TD",
    });
    expect(result).toContain("subgraph sg-aaaaaa [My Group]");
  });
});

// ---- Tests: direction in header ----

describe("generateMermaid — direction header", () => {
  test("direction LR → graph LR header", () => {
    const result = generateMermaid({
      actions: [define("a-x9k2lm", "service", "A")],
      direction: "LR",
    });
    expect(result.startsWith("graph LR")).toBe(true);
  });

  test("direction TD → graph TD header", () => {
    const result = generateMermaid({
      actions: [define("a-x9k2lm", "service", "A")],
      direction: "TD",
    });
    expect(result.startsWith("graph TD")).toBe(true);
  });

  test("direction BT → graph BT header", () => {
    const result = generateMermaid({
      actions: [define("a-x9k2lm", "service", "A")],
      direction: "BT",
    });
    expect(result.startsWith("graph BT")).toBe(true);
  });

  test("direction RL → graph RL header", () => {
    const result = generateMermaid({
      actions: [define("a-x9k2lm", "service", "A")],
      direction: "RL",
    });
    expect(result.startsWith("graph RL")).toBe(true);
  });
});

// ---- Tests: determinism ----

describe("generateMermaid — determinism", () => {
  test("same input produces same output bytes on repeated calls", () => {
    const actions: SchemaAction[] = [
      define("api-x9k2lm", "service", "API"),
      define("db-c8h2vx", "datastore", "DB"),
      connect("api-x9k2lm", "db-c8h2vx", "sync"),
    ];
    const first = generateMermaid({ actions, direction: "LR" });
    const second = generateMermaid({ actions, direction: "LR" });
    expect(first).toBe(second);
  });

  test("nodes are sorted by nodeId for stable output", () => {
    const actionsAB: SchemaAction[] = [
      define("zzz-aaaaaa", "service", "Z"),
      define("aaa-aaaaaa", "service", "A"),
    ];
    const actionsBA: SchemaAction[] = [
      define("aaa-aaaaaa", "service", "A"),
      define("zzz-aaaaaa", "service", "Z"),
    ];
    const resultAB = generateMermaid({ actions: actionsAB, direction: "LR" });
    const resultBA = generateMermaid({ actions: actionsBA, direction: "LR" });
    // Output should be identical regardless of input order
    expect(resultAB).toBe(resultBA);
    // And aaa should appear before zzz
    const lines = resultAB.split("\n");
    const aaaIdx = lines.findIndex((l) => l.includes("aaa-aaaaaa"));
    const zzzIdx = lines.findIndex((l) => l.includes("zzz-aaaaaa"));
    expect(aaaIdx).toBeLessThan(zzzIdx);
  });

  test("edges sorted by from then to for stable output", () => {
    const actionsForward: SchemaAction[] = [
      define("a-aaaaaa", "service"),
      define("b-aaaaaa", "service"),
      define("c-aaaaaa", "service"),
      connect("b-aaaaaa", "c-aaaaaa", "sync"),
      connect("a-aaaaaa", "b-aaaaaa", "sync"),
    ];
    const actionsReverse: SchemaAction[] = [
      define("a-aaaaaa", "service"),
      define("b-aaaaaa", "service"),
      define("c-aaaaaa", "service"),
      connect("a-aaaaaa", "b-aaaaaa", "sync"),
      connect("b-aaaaaa", "c-aaaaaa", "sync"),
    ];
    expect(generateMermaid({ actions: actionsForward, direction: "LR" })).toBe(
      generateMermaid({ actions: actionsReverse, direction: "LR" }),
    );
  });
});

// ---- Tests: labels / roles override maps ----

describe("generateMermaid — labels + roles override maps", () => {
  test("labels map overrides action label", () => {
    const result = generateMermaid({
      actions: [define("api-x9k2lm", "service", "OldLabel")],
      direction: "LR",
      labels: { "api-x9k2lm": "NewLabel" },
    });
    expect(result).toContain("api-x9k2lm[NewLabel]");
    expect(result).not.toContain("OldLabel");
  });

  test("roles map overrides action role", () => {
    const result = generateMermaid({
      actions: [define("node-aaaaaa", "service", "Node")],
      direction: "LR",
      roles: { "node-aaaaaa": "datastore" },
    });
    // datastore → [(Label)] cylinder
    expect(result).toContain("node-aaaaaa[(Node)]");
  });

  test("absent nodeId in labels map falls back to action label", () => {
    const result = generateMermaid({
      actions: [define("api-x9k2lm", "service", "API")],
      direction: "LR",
      labels: {},
    });
    expect(result).toContain("api-x9k2lm[API]");
  });

  test("node with no label in action and not in labels map uses nodeId as label", () => {
    const result = generateMermaid({
      actions: [define("api-x9k2lm", "service")],
      direction: "LR",
    });
    // Falls back to nodeId as label
    expect(result).toContain("api-x9k2lm[api-x9k2lm]");
  });
});

// ---- Round-trip tests ----

describe("generateMermaid — round-trip (parse → generate → parse)", () => {
  /**
   * Round-trip assertion: parse(raw) → actions; generate(actions) → raw2;
   * parse(raw2) → actions2; compare key properties of actions vs actions2.
   */
  function assertRoundTrip(
    raw: string,
    description: string,
  ) {
    test(description, () => {
      const r1 = parse(raw);
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;

      const generated = generateMermaid({
        actions: r1.actions,
        direction: r1.direction,
      });

      const r2 = parse(generated);
      if (!r2.ok) {
        throw new Error(
          `Round-trip parse failed: ${r2.code} — ${r2.message}\nGenerated:\n${generated}`,
        );
      }

      // Compare number of each action kind
      const countKind = (acts: SchemaAction[], kind: string) =>
        acts.filter((a) => a.kind === kind).length;

      expect(countKind(r2.actions, "schema-define")).toBe(
        countKind(r1.actions, "schema-define"),
      );
      expect(countKind(r2.actions, "schema-connect")).toBe(
        countKind(r1.actions, "schema-connect"),
      );
      expect(countKind(r2.actions, "schema-group")).toBe(
        countKind(r1.actions, "schema-group"),
      );

      // Compare direction preserved
      expect(r2.direction).toBe(r1.direction);
    });
  }

  assertRoundTrip(
    "graph LR\n  api[API] --> db[Database]",
    "roundtrip: simple define + connect (sync)",
  );

  assertRoundTrip(
    "graph TD\n  user(User) --> auth{Auth}",
    "roundtrip: round-rect + diamond shapes",
  );

  assertRoundTrip(
    "flowchart LR\n  store[(DB)]",
    "roundtrip: datastore cylinder shape",
  );

  assertRoundTrip(
    "graph TD\n  human((User))",
    "roundtrip: actor circle shape",
  );

  assertRoundTrip(
    "graph LR\n  ext>External]",
    "roundtrip: external asymmetric shape",
  );

  assertRoundTrip(
    "graph LR\n  a -.-> b",
    "roundtrip: dep edge (-.->)",
  );

  assertRoundTrip(
    "graph LR\n  a ==> b",
    "roundtrip: data edge (==>)",
  );

  assertRoundTrip(
    "graph LR\n  a --x b",
    "roundtrip: async edge (--x)",
  );

  assertRoundTrip(
    "graph LR\n  a -->|label| b",
    "roundtrip: labeled edge",
  );

  test("roundtrip: subgraph block — structure preserved", () => {
    const raw = `graph LR
  subgraph Auth [Authentication]
    a --> b
  end`;

    const r1 = parse(raw);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    const generated = generateMermaid({ actions: r1.actions, direction: r1.direction });

    const r2 = parse(generated);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;

    // Group count preserved
    const groups1 = r1.actions.filter((a) => a.kind === "schema-group");
    const groups2 = r2.actions.filter((a) => a.kind === "schema-group");
    expect(groups2).toHaveLength(groups1.length);

    // Group label preserved
    const grp1 = groups1[0] as SchemaGroupAction;
    const grp2 = groups2[0] as SchemaGroupAction;
    expect(grp2.label).toBe(grp1.label);

    // Same number of nodeIds in group
    expect(grp2.nodeIds).toHaveLength(grp1.nodeIds.length);
  });

  test("roundtrip: multi-node, multi-edge graph", () => {
    const raw = `graph LR
  api[API] --> db[(DB)]
  api --> cache[(Cache)]
  user((User)) --> api`;

    const r1 = parse(raw);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    const generated = generateMermaid({ actions: r1.actions, direction: r1.direction });

    const r2 = parse(generated);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;

    const defines2 = r2.actions.filter((a) => a.kind === "schema-define");
    const connects2 = r2.actions.filter((a) => a.kind === "schema-connect");

    expect(defines2).toHaveLength(
      r1.actions.filter((a) => a.kind === "schema-define").length,
    );
    expect(connects2).toHaveLength(
      r1.actions.filter((a) => a.kind === "schema-connect").length,
    );
  });

  test("roundtrip: all edge kinds in one graph", () => {
    const raw = `graph LR
  a[A] --> b[B]
  b -.-> c[C]
  c ==> d[D]
  d --x e[E]`;

    const r1 = parse(raw);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    const generated = generateMermaid({ actions: r1.actions, direction: r1.direction });
    const r2 = parse(generated);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;

    const getEdgeKinds = (acts: SchemaAction[]) =>
      acts
        .filter((a): a is SchemaConnectAction => a.kind === "schema-connect")
        .map((a) => a.connectionKind)
        .sort();

    expect(getEdgeKinds(r2.actions)).toEqual(getEdgeKinds(r1.actions));
  });
});
