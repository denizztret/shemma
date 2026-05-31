import { describe, test, expect } from "bun:test";
import { parseMermaidFlowchart } from "./mermaid-parser";
import type { SchemaAction, SchemaDefineAction, SchemaConnectAction, SchemaGroupAction, Role, ConnectionKind } from "@shemma/domain";
import type { NodeId } from "@shemma/domain";

// ---- Test helpers ----

/** Deterministic ID generator: returns "<slug>-aaaaaa" */
function makeTestGenerator() {
  return function generateId(slug: string, _existing: ReadonlySet<NodeId>, _mermaidId: string): NodeId {
    if (slug === "" || slug === "shape") return `e-aaaaaa`;
    return `${slug}-aaaaaa`;
  };
}

/** Parse helper with defaults */
function parse(raw: string) {
  return parseMermaidFlowchart(raw, {
    suffixLen: 6,
    generateId: makeTestGenerator(),
  });
}

function expectDefine(actions: SchemaAction[], nodeId: string, role: Role, label?: string) {
  const a = actions.find(
    (x) => x.kind === "schema-define" && x.nodeId === nodeId,
  ) as SchemaDefineAction | undefined;
  expect(a).toBeDefined();
  expect(a!.role).toBe(role);
  if (label !== undefined) {
    expect(a!.label).toBe(label);
  }
}

function expectConnect(
  actions: SchemaAction[],
  from: string,
  to: string,
  connectionKind?: ConnectionKind,
  label?: string,
) {
  const a = actions.find(
    (x) => x.kind === "schema-connect" && x.from === from && x.to === to,
  ) as SchemaConnectAction | undefined;
  expect(a).toBeDefined();
  if (connectionKind !== undefined) expect(a!.connectionKind).toBe(connectionKind);
  if (label !== undefined) expect(a!.label).toBe(label);
}

// ---- Tests ----

describe("parseMermaidFlowchart — header parsing", () => {
  test("graph LR is accepted with direction LR", () => {
    const r = parse("graph LR\n  api[API] --> db[Database]");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.direction).toBe("LR");
  });

  test("graph TD is accepted with direction TD", () => {
    const r = parse("graph TD\n  a --> b");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.direction).toBe("TD");
  });

  test("graph TB is accepted", () => {
    const r = parse("graph TB\n  a --> b");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.direction).toBe("TB");
  });

  test("graph BT is accepted", () => {
    const r = parse("graph BT\n  a --> b");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.direction).toBe("BT");
  });

  test("graph RL is accepted", () => {
    const r = parse("graph RL\n  a --> b");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.direction).toBe("RL");
  });

  test("flowchart LR is accepted", () => {
    const r = parse("flowchart LR\n  a --> b");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.direction).toBe("LR");
  });

  test("flowchart TD is accepted", () => {
    const r = parse("flowchart TD\n  a --> b");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.direction).toBe("TD");
  });
});

describe("parseMermaidFlowchart — node shapes → roles", () => {
  test("id[Label] → schema-define role=service (rect)", () => {
    const r = parse("graph LR\n  api[API]");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expectDefine(r.actions, "api-aaaaaa", "service", "API");
  });

  test("id(Label) → schema-define role=service (round-rect)", () => {
    const r = parse("graph TD\n  user(User)");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expectDefine(r.actions, "user-aaaaaa", "service", "User");
  });

  test("id{Label} → schema-define role=service (diamond)", () => {
    const r = parse("graph TD\n  auth{Auth}");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expectDefine(r.actions, "auth-aaaaaa", "service", "Auth");
  });

  test("id[(Label)] → schema-define role=datastore (cylinder)", () => {
    const r = parse("flowchart LR\n  store[(DB)]");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expectDefine(r.actions, "db-aaaaaa", "datastore", "DB");
  });

  test("id((Label)) → schema-define role=actor (circle)", () => {
    const r = parse("graph TD\n  human((User))");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expectDefine(r.actions, "user-aaaaaa", "actor", "User");
  });

  test("id>Label] → schema-define role=external (asymmetric)", () => {
    const r = parse("graph LR\n  ext>External]");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expectDefine(r.actions, "external-aaaaaa", "external", "External");
  });
});

describe("parseMermaidFlowchart — edges → connections", () => {
  test("A --> B → connectionKind sync (2 defines + 1 connect)", () => {
    const r = parse("graph LR\n  api[API] --> db[Database]");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.actions.filter((a) => a.kind === "schema-define")).toHaveLength(2);
    expect(r.actions.filter((a) => a.kind === "schema-connect")).toHaveLength(1);
    expectConnect(r.actions, "api-aaaaaa", "database-aaaaaa", "sync");
  });

  test("A -.-> B → connectionKind dep", () => {
    const r = parse("graph LR\n  a -.-> b");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expectConnect(r.actions, "a-aaaaaa", "b-aaaaaa", "dep");
  });

  test("A ==> B → connectionKind data", () => {
    const r = parse("graph LR\n  a ==> b");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expectConnect(r.actions, "a-aaaaaa", "b-aaaaaa", "data");
  });

  test("A --x B → connectionKind async", () => {
    const r = parse("graph LR\n  a --x b");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expectConnect(r.actions, "a-aaaaaa", "b-aaaaaa", "async");
  });

  test("A --o B → connectionKind async", () => {
    const r = parse("graph LR\n  a --o b");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expectConnect(r.actions, "a-aaaaaa", "b-aaaaaa", "async");
  });

  test("A -->|label| B → connect with label", () => {
    const r = parse("graph LR\n  a -->|calls| b");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expectConnect(r.actions, "a-aaaaaa", "b-aaaaaa", "sync", "calls");
  });

  test("A --- B → connectionKind sync (open link)", () => {
    const r = parse("graph LR\n  a --- b");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expectConnect(r.actions, "a-aaaaaa", "b-aaaaaa", "sync");
  });
});

describe("parseMermaidFlowchart — anonymous nodes (bare identifiers)", () => {
  test("a --> b (no label) → slugify mermaid id, label defaults to mermaid id", () => {
    const r = parse("graph LR\n  a --> b");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 'a' slugifies to 'a', id = 'a-aaaaaa'
    expect(r.actions.filter((a) => a.kind === "schema-define")).toHaveLength(2);
    expectConnect(r.actions, "a-aaaaaa", "b-aaaaaa");
  });

  test("bare id node doesn't emit label field (it would be the id itself)", () => {
    const r = parse("graph LR\n  api --> db");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const define = r.actions.find(
      (a) => a.kind === "schema-define" && a.nodeId === "api-aaaaaa",
    ) as SchemaDefineAction | undefined;
    expect(define).toBeDefined();
    // Bare id: label is not emitted as it would equal the mermaid id
    expect(define!.label).toBeUndefined();
  });
});

describe("parseMermaidFlowchart — subgraph", () => {
  test("subgraph block produces schema-group with children", () => {
    const raw = `graph LR
  subgraph Auth [Authentication]
    a --> b
  end`;
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const groups = r.actions.filter((a) => a.kind === "schema-group") as SchemaGroupAction[];
    expect(groups).toHaveLength(1);
    const grp = groups[0]!;
    expect(grp.label).toBe("Authentication");
    expect(grp.as).toBe("boundary");
    expect(grp.nodeIds).toContain("a-aaaaaa");
    expect(grp.nodeIds).toContain("b-aaaaaa");
  });

  test("subgraph id without explicit [Label] uses id as label", () => {
    const raw = `graph LR
  subgraph myGroup
    a --> b
  end`;
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const groups = r.actions.filter((a) => a.kind === "schema-group") as SchemaGroupAction[];
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBe("myGroup");
  });

  test("nodes inside subgraph also get define actions", () => {
    const raw = `graph LR
  subgraph Auth [Auth]
    a[Service A] --> b[Service B]
  end`;
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const defines = r.actions.filter((a) => a.kind === "schema-define");
    // Should have defines for a and b (subgraph itself doesn't get a define action separately)
    expect(defines.length).toBeGreaterThanOrEqual(2);
  });
});

describe("parseMermaidFlowchart — comments and frontmatter", () => {
  test("%% comments are stripped", () => {
    const r = parse("graph LR\n  %% this is a comment\n  a --> b");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.actions.filter((a) => a.kind === "schema-connect")).toHaveLength(1);
  });

  test("inline comments after node are stripped", () => {
    const r = parse("graph LR\n  a[API] --> b[DB] %% inline comment");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.actions.filter((a) => a.kind === "schema-connect")).toHaveLength(1);
  });

  test("frontmatter (--- title: ... ---) is stripped before parse", () => {
    const raw = `---
title: My Diagram
---
graph LR
  a --> b`;
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.direction).toBe("LR");
    expectConnect(r.actions, "a-aaaaaa", "b-aaaaaa");
  });
});

describe("parseMermaidFlowchart — unsupported diagram types", () => {
  test("sequenceDiagram → unsupported-diagram-type", () => {
    const r = parse("sequenceDiagram\n  A->>B: hi");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("unsupported-diagram-type");
    expect(r.detectedType).toBe("sequenceDiagram");
  });

  test("classDiagram → unsupported-diagram-type", () => {
    const r = parse("classDiagram\n  Animal <|-- Duck");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("unsupported-diagram-type");
  });

  test("gitGraph → unsupported-diagram-type", () => {
    const r = parse("gitGraph\n  commit");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("unsupported-diagram-type");
  });

  test("erDiagram → unsupported-diagram-type", () => {
    const r = parse("erDiagram\n  CUSTOMER ||--o{ ORDER : places");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("unsupported-diagram-type");
  });

  test("pie → unsupported-diagram-type", () => {
    const r = parse("pie title Pets\n  \"Dogs\" : 386");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("unsupported-diagram-type");
  });

  test("gantt → unsupported-diagram-type", () => {
    const r = parse("gantt\n  title A Gantt Diagram");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("unsupported-diagram-type");
  });

  test("stateDiagram-v2 → unsupported-diagram-type", () => {
    const r = parse("stateDiagram-v2\n  [*] --> s1");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("unsupported-diagram-type");
  });
});

describe("parseMermaidFlowchart — invalid / edge cases", () => {
  test("empty string → invalid-mermaid", () => {
    const r = parse("");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Could be invalid-mermaid or unsupported-diagram-type; document: empty → invalid-mermaid
    expect(r.code).toBe("invalid-mermaid");
  });

  test("only whitespace → invalid-mermaid", () => {
    const r = parse("   \n\n  ");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("invalid-mermaid");
  });

  test("graph without direction → invalid-mermaid", () => {
    const r = parse("graph\n  a --> b");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("invalid-mermaid");
  });

  test("graph with invalid direction → invalid-mermaid", () => {
    const r = parse("graph XY\n  a --> b");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("invalid-mermaid");
  });
});

describe("parseMermaidFlowchart — multiple nodes and complex graphs", () => {
  test("2 defines + 1 connect for simple edge", () => {
    const r = parse("graph LR\n  api[API] --> db[Database]");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.actions).toHaveLength(3); // 2 define + 1 connect
  });

  test("node defined once even if referenced in multiple edges", () => {
    const r = parse("graph LR\n  api[API] --> db[(DB)]\n  api --> cache[(Cache)]");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const defines = r.actions.filter((a) => a.kind === "schema-define");
    // api, db, cache — each defined once
    expect(defines).toHaveLength(3);
    const connects = r.actions.filter((a) => a.kind === "schema-connect");
    expect(connects).toHaveLength(2);
  });

  test("role=service for round-rect + role=service for diamond (spec: both default)", () => {
    const r = parse("graph TD\n  user(User) --> auth{Auth}");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expectDefine(r.actions, "user-aaaaaa", "service", "User");
    expectDefine(r.actions, "auth-aaaaaa", "service", "Auth");
  });

  test("mixed node shapes in one graph", () => {
    const r = parse(
      "graph LR\n  svc[Service] --> db[(Database)]\n  actor((User)) --> svc\n  ext>External] --> svc",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expectDefine(r.actions, "service-aaaaaa", "service", "Service");
    expectDefine(r.actions, "database-aaaaaa", "datastore", "Database");
    expectDefine(r.actions, "user-aaaaaa", "actor", "User");
    expectDefine(r.actions, "external-aaaaaa", "external", "External");
  });

  test("style/classDef/class directives are skipped without error", () => {
    const raw = `graph LR
  classDef default fill:#fff
  a[A] --> b[B]
  style a fill:#f9f
  class a default`;
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.actions.filter((a) => a.kind === "schema-connect")).toHaveLength(1);
  });
});

describe("parseMermaidFlowchart — spec mapping table coverage", () => {
  test("full mapping table: all node shape → role combinations", () => {
    const shapes = [
      { line: "n1[Label]", role: "service" },
      { line: "n2(Label)", role: "service" },
      { line: "n3{Label}", role: "service" },
      { line: "n4[(Label)]", role: "datastore" },
      { line: "n5((Label))", role: "actor" },
      { line: "n6>Label]", role: "external" },
    ] as const;

    for (const { line, role } of shapes) {
      const r = parse(`graph LR\n  ${line}`);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      const define = r.actions.find(
        (a) => a.kind === "schema-define",
      ) as SchemaDefineAction | undefined;
      expect(define).toBeDefined();
      expect(define!.role).toBe(role);
    }
  });

  test("all edge type → connectionKind combinations", () => {
    const edges = [
      { line: "a --> b", kind: "sync" },
      { line: "a -.-> b", kind: "dep" },
      { line: "a ==> b", kind: "data" },
      { line: "a --x b", kind: "async" },
      { line: "a --o b", kind: "async" },
    ] as const;

    for (const { line, kind } of edges) {
      const r = parse(`graph LR\n  ${line}`);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      const connect = r.actions.find(
        (a) => a.kind === "schema-connect",
      ) as SchemaConnectAction | undefined;
      expect(connect).toBeDefined();
      expect(connect!.connectionKind).toBe(kind);
    }
  });

  test("edge with pipe label: -->|label| B → label in connect action", () => {
    const r = parse("graph LR\n  api -->|HTTP/1.1| db");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expectConnect(r.actions, "api-aaaaaa", "db-aaaaaa", "sync", "HTTP/1.1");
  });
});

// ---- DRW-153: style directive parsing ----

describe("parseMermaidFlowchart — DRW-153 style directives", () => {
  test("style directive for a node is parsed into nodeStyles map", () => {
    const raw = `graph LR
  api[API]
  db[(Database)]
  style api fill:#e3f2fd,stroke:#1565c0,color:#000`;
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.nodeStyles).toBeDefined();
    const style = r.nodeStyles?.get("api");
    expect(style).toBeDefined();
    expect(style?.fill).toBe("#e3f2fd");
    expect(style?.stroke).toBe("#1565c0");
    expect(style?.color).toBe("#000");
  });

  test("style directive only fill → fill set, stroke/color undefined", () => {
    const raw = `graph LR
  EventRouter[Event Router]
  style EventRouter fill:#fff3e0`;
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const style = r.nodeStyles?.get("EventRouter");
    expect(style?.fill).toBe("#fff3e0");
    expect(style?.stroke).toBeUndefined();
    expect(style?.color).toBeUndefined();
  });

  test("multiple style directives → each node gets its own style", () => {
    const raw = `graph TD
  a[Service A]
  b[Service B]
  a --> b
  style a fill:#e8f5e9,stroke:#2e7d32
  style b fill:#fce4ec,stroke:#c62828,color:#fff`;
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const styleA = r.nodeStyles?.get("a");
    const styleB = r.nodeStyles?.get("b");
    expect(styleA?.fill).toBe("#e8f5e9");
    expect(styleA?.stroke).toBe("#2e7d32");
    expect(styleB?.fill).toBe("#fce4ec");
    expect(styleB?.stroke).toBe("#c62828");
    expect(styleB?.color).toBe("#fff");
  });

  test("style with stroke-width and stroke-dasharray — parsed into extra map but do not fail", () => {
    const raw = `graph LR
  api[API]
  style api fill:#fff,stroke:#333,stroke-width:2px,stroke-dasharray:5 5`;
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const style = r.nodeStyles?.get("api");
    // fill and stroke captured; stroke-width and stroke-dasharray stored
    expect(style?.fill).toBe("#fff");
    expect(style?.stroke).toBe("#333");
  });

  test("style for non-existent node → still stored in nodeStyles (node may be defined later)", () => {
    const raw = `graph LR
  style phantom fill:#ff0000`;
    const r = parse(raw);
    // May fail on 'phantom' as standalone node or succeed — either way, nodeStyles populated
    if (r.ok) {
      const style = r.nodeStyles?.get("phantom");
      expect(style?.fill).toBe("#ff0000");
    }
  });

  test("malformed style value (no colon) — ignored gracefully", () => {
    const raw = `graph LR
  a[A] --> b[B]
  style a BADSTYLE`;
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // No style parsed for 'a' (bad format), but parse succeeds
    const style = r.nodeStyles?.get("a");
    // Either undefined or empty object — no crash
    expect(style?.fill).toBeUndefined();
  });

  test("diagram without any style directives → nodeStyles is empty Map", () => {
    const raw = `graph LR
  api[API] --> db[Database]`;
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.nodeStyles).toBeDefined();
    expect(r.nodeStyles?.size).toBe(0);
  });

  test("nodeStyles keyed by mermaid id (not NodeId)", () => {
    // mermaid id is 'EventRouter', NodeId would be 'event-router-aaaaaa' after slug
    const raw = `graph LR
  EventRouter[Event Router]
  style EventRouter fill:#fff3e0`;
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Key is raw mermaid id
    expect(r.nodeStyles?.has("EventRouter")).toBe(true);
    // NOT the slug-based nodeId
    expect(r.nodeStyles?.has("event-router-aaaaaa")).toBe(false);
  });
});

// ---- DRW-152: per-subgraph direction ----

describe("parseMermaidFlowchart — DRW-152 per-subgraph direction", () => {
  test("subgraph with direction LR → group action has direction LR", () => {
    const raw = `graph TD
  subgraph A [Group A]
    direction LR
    a --> b
  end`;
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const groups = r.actions.filter((a) => a.kind === "schema-group") as SchemaGroupAction[];
    expect(groups).toHaveLength(1);
    expect(groups[0]!.direction).toBe("LR");
  });

  test("subgraph with direction TB → group action has direction TB", () => {
    const raw = `graph LR
  subgraph A [Group A]
    direction TB
    a --> b
  end`;
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const groups = r.actions.filter((a) => a.kind === "schema-group") as SchemaGroupAction[];
    expect(groups).toHaveLength(1);
    expect(groups[0]!.direction).toBe("TB");
  });

  test("subgraph with direction TD → group action has direction TB (TD normalizes to TB)", () => {
    const raw = `graph LR
  subgraph A [Group A]
    direction TD
    a --> b
  end`;
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const groups = r.actions.filter((a) => a.kind === "schema-group") as SchemaGroupAction[];
    expect(groups).toHaveLength(1);
    expect(groups[0]!.direction).toBe("TB");
  });

  test("subgraph with direction BT → group action has direction BT", () => {
    const raw = `graph TD
  subgraph A [Group A]
    direction BT
    a --> b
  end`;
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const groups = r.actions.filter((a) => a.kind === "schema-group") as SchemaGroupAction[];
    expect(groups).toHaveLength(1);
    expect(groups[0]!.direction).toBe("BT");
  });

  test("subgraph with direction RL → group action has direction RL", () => {
    const raw = `graph TD
  subgraph A [Group A]
    direction RL
    a --> b
  end`;
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const groups = r.actions.filter((a) => a.kind === "schema-group") as SchemaGroupAction[];
    expect(groups).toHaveLength(1);
    expect(groups[0]!.direction).toBe("RL");
  });

  test("subgraph WITHOUT direction line → group action has no direction field", () => {
    const raw = `graph TD
  subgraph A [Group A]
    a --> b
  end`;
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const groups = r.actions.filter((a) => a.kind === "schema-group") as SchemaGroupAction[];
    expect(groups).toHaveLength(1);
    expect(groups[0]!.direction).toBeUndefined();
  });

  test("two subgraphs with different directions → each gets its own direction", () => {
    const raw = `graph TD
  subgraph A [Group A]
    direction LR
    a --> b
  end
  subgraph B [Group B]
    direction BT
    c --> d
  end`;
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const groups = r.actions.filter((a) => a.kind === "schema-group") as SchemaGroupAction[];
    expect(groups).toHaveLength(2);
    const grpA = groups.find((g) => g.label === "Group A");
    const grpB = groups.find((g) => g.label === "Group B");
    expect(grpA?.direction).toBe("LR");
    expect(grpB?.direction).toBe("BT");
  });

  test("top-level direction line (not inside subgraph) does NOT create direction on group", () => {
    // direction line at top level (outside any subgraph) should be ignored / not affect groups
    const raw = `graph TD
  direction LR
  subgraph A [Group A]
    a --> b
  end`;
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const groups = r.actions.filter((a) => a.kind === "schema-group") as SchemaGroupAction[];
    expect(groups).toHaveLength(1);
    expect(groups[0]!.direction).toBeUndefined();
  });
});

describe("parseMermaidFlowchart — DRW-155 multi-line quoted labels", () => {
  test("collapses \\n inside [\"...\"] into a space", () => {
    const raw = `graph TB
  A["line one
  line two"]
  B["single"]
  A --> B`;
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const defines = r.actions.filter((a) => a.kind === "schema-define");
    expect(defines).toHaveLength(2);
    const aDef = defines.find((d: { kind: "schema-define"; label?: string }) =>
      d.label?.startsWith("line one"),
    );
    expect(aDef).toBeDefined();
    // continuation line is joined with a space, leading indentation preserved
    expect(aDef?.label).toContain("line two");
    expect(aDef?.label).not.toContain("\n");
  });

  test("handles 3+ line label", () => {
    const raw = `graph TB
  ED["EventDispatch
  AnalyticsPayload
  DelegatePayload"]
  ED --> X`;
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ed = r.actions.find(
      (a) => a.kind === "schema-define" && a.label?.includes("EventDispatch"),
    );
    expect(ed).toBeDefined();
    expect((ed as { label?: string }).label).toContain("AnalyticsPayload");
    expect((ed as { label?: string }).label).toContain("DelegatePayload");
  });

  test("inline node def at edge target accepts multi-line label", () => {
    const raw = `graph TB
  A["A"]
  A --> B["multi
  line target"]`;
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b = r.actions.find(
      (a) =>
        a.kind === "schema-define" && (a as { label?: string }).label?.includes("multi"),
    );
    expect(b).toBeDefined();
    expect((b as { label?: string }).label).toContain("line target");
  });

  test("single-line quoted labels are unaffected (regression guard)", () => {
    const raw = `graph TB
  A["just one line"]
  B["another"]
  A --> B`;
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const defines = r.actions.filter((a) => a.kind === "schema-define");
    expect(defines).toHaveLength(2);
  });
});

test("DRW-162: collects subgraph styles from style directives", () => {
  const src = `flowchart TB
 subgraph INPUT["Вход"]
   SE["SourceEvent"]
 end
 subgraph TRANSPORT["Доставка"]
   AS["AnalyticsSinkProtocol"]
 end
 style INPUT fill:#e3f2fd,stroke:#1565c0,color:#000
 style TRANSPORT fill:#C8E6C9,stroke:#2e7d32
 style SE fill:#fff,stroke:#000
`;
  const r = parseMermaidFlowchart(src, {
    suffixLen: 6,
    existingIds: new Set(),
    generateId: (slug, existing) => `${slug}-xxxxxx` as NodeId,
  });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.subgraphStyles).toBeDefined();
  expect(r.subgraphStyles.get("INPUT")).toEqual({ fill: "#e3f2fd", stroke: "#1565c0", color: "#000" });
  expect(r.subgraphStyles.get("TRANSPORT")).toEqual({ fill: "#C8E6C9", stroke: "#2e7d32" });
  expect(r.nodeStyles.get("SE")).toBeDefined();
});

describe("parseMermaidFlowchart — idMap exposure (Stage 1)", () => {
  test("ParseResult exposes idMap mermaidId→NodeId", () => {
    const res = parse("flowchart LR\n  api[API Gateway] --> db[DB]");
    if (!res.ok) throw new Error("expected ok parse");
    // idMap keyed by raw mermaid identifier
    expect(res.idMap.get("api")).toBeDefined();
    expect(res.idMap.get("db")).toBeDefined();
    // value is the resolved NodeId (slug-<6char> form), distinct per node
    expect(res.idMap.get("api")).toMatch(/-[a-z0-9]{6}$/);
    expect(res.idMap.get("api")).not.toEqual(res.idMap.get("db"));
  });
});
