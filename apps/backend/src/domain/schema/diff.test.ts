/**
 * Tests для schema diff (DRW-134 Task 2.4 — diff.ts).
 * 6 cases per plan acceptance.
 */

import { describe, test, expect } from "bun:test";
import { diffSchemas } from "./diff";
import type { SchemaAction } from "@shemma/domain";

// Helpers for building actions.
function define(nodeId: string, label?: string, role: string = "service"): SchemaAction {
  return {
    kind: "schema-define",
    nodeId,
    role: role as import("@shemma/domain").Role,
    ...(label !== undefined ? { label } : {}),
  };
}
function connect(
  from: string,
  to: string,
  connectionKind?: import("@shemma/domain").ConnectionKind,
  label?: string,
): SchemaAction {
  return {
    kind: "schema-connect",
    from,
    to,
    ...(connectionKind !== undefined ? { connectionKind } : {}),
    ...(label !== undefined ? { label } : {}),
  };
}
function rename(nodeId: string, label: string): SchemaAction {
  return { kind: "schema-rename", nodeId, label };
}
function setRole(nodeId: string, role: string): SchemaAction {
  return { kind: "schema-set-role", nodeId, role: role as import("@shemma/domain").Role };
}

describe("diffSchemas (DRW-134 Task 2.4)", () => {
  test("Identical schemas → empty diff", () => {
    const actions: SchemaAction[] = [
      define("api-aaaaaa", "API"),
      define("db-bbbbbb", "Database", "datastore"),
      connect("api-aaaaaa", "db-bbbbbb"),
    ];
    const result = diffSchemas(actions, actions);
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
    expect(result.renamed).toHaveLength(0);
    expect(result.roleChanged).toHaveLength(0);
    expect(result.edgesAdded).toHaveLength(0);
    expect(result.edgesRemoved).toHaveLength(0);
  });

  test("Add node → added: [{nodeId, role, label}]", () => {
    const oldActions: SchemaAction[] = [define("api-aaaaaa", "API")];
    const newActions: SchemaAction[] = [
      define("api-aaaaaa", "API"),
      define("db-bbbbbb", "Database", "datastore"),
    ];
    const result = diffSchemas(oldActions, newActions);
    expect(result.added).toHaveLength(1);
    expect(result.added[0]!.nodeId).toBe("db-bbbbbb");
    expect(result.added[0]!.label).toBe("Database");
    expect(result.added[0]!.role).toBe("datastore");
    expect(result.removed).toHaveLength(0);
  });

  test("Remove node → removed: [nodeId]", () => {
    const oldActions: SchemaAction[] = [
      define("api-aaaaaa", "API"),
      define("db-bbbbbb", "Database"),
    ];
    const newActions: SchemaAction[] = [define("api-aaaaaa", "API")];
    const result = diffSchemas(oldActions, newActions);
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0]).toBe("db-bbbbbb");
    expect(result.added).toHaveLength(0);
  });

  test("Rename (same nodeId, different label) → renamed: [{nodeId, oldLabel, newLabel}]", () => {
    const oldActions: SchemaAction[] = [define("api-aaaaaa", "API")];
    const newActions: SchemaAction[] = [define("api-aaaaaa", "API Gateway")];
    const result = diffSchemas(oldActions, newActions);
    expect(result.renamed).toHaveLength(1);
    expect(result.renamed[0]!.nodeId).toBe("api-aaaaaa");
    expect(result.renamed[0]!.oldLabel).toBe("API");
    expect(result.renamed[0]!.newLabel).toBe("API Gateway");
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
  });

  test("Rename via schema-rename action → renamed detected", () => {
    const oldActions: SchemaAction[] = [define("api-aaaaaa", "API")];
    const newActions: SchemaAction[] = [
      define("api-aaaaaa", "API"),
      rename("api-aaaaaa", "API Gateway"),
    ];
    const result = diffSchemas(oldActions, newActions);
    expect(result.renamed).toHaveLength(1);
    expect(result.renamed[0]!.newLabel).toBe("API Gateway");
  });

  test("Role change → roleChanged: [{nodeId, oldRole, newRole}]", () => {
    const oldActions: SchemaAction[] = [define("api-aaaaaa", "API", "service")];
    // New schema has same node but with schema-set-role applied.
    const newActions: SchemaAction[] = [
      define("api-aaaaaa", "API", "service"),
      setRole("api-aaaaaa", "datastore"),
    ];
    const result = diffSchemas(oldActions, newActions);
    expect(result.roleChanged).toHaveLength(1);
    expect(result.roleChanged[0]!.nodeId).toBe("api-aaaaaa");
    expect(result.roleChanged[0]!.oldRole).toBe("service");
    expect(result.roleChanged[0]!.newRole).toBe("datastore");
  });

  test("Edge added → edgesAdded contains the new edge", () => {
    const oldActions: SchemaAction[] = [
      define("api-aaaaaa", "API"),
      define("db-bbbbbb", "DB"),
    ];
    const newActions: SchemaAction[] = [
      define("api-aaaaaa", "API"),
      define("db-bbbbbb", "DB"),
      connect("api-aaaaaa", "db-bbbbbb", "sync"),
    ];
    const result = diffSchemas(oldActions, newActions);
    expect(result.edgesAdded).toHaveLength(1);
    expect(result.edgesAdded[0]!.from).toBe("api-aaaaaa");
    expect(result.edgesAdded[0]!.to).toBe("db-bbbbbb");
    expect(result.edgesAdded[0]!.connectionKind).toBe("sync");
    expect(result.edgesRemoved).toHaveLength(0);
  });

  test("Edge removed → edgesRemoved contains the removed edge", () => {
    const oldActions: SchemaAction[] = [
      define("api-aaaaaa", "API"),
      define("db-bbbbbb", "DB"),
      connect("api-aaaaaa", "db-bbbbbb"),
    ];
    const newActions: SchemaAction[] = [
      define("api-aaaaaa", "API"),
      define("db-bbbbbb", "DB"),
    ];
    const result = diffSchemas(oldActions, newActions);
    expect(result.edgesRemoved).toHaveLength(1);
    expect(result.edgesRemoved[0]!.from).toBe("api-aaaaaa");
    expect(result.edgesRemoved[0]!.to).toBe("db-bbbbbb");
    expect(result.edgesAdded).toHaveLength(0);
  });

  test("Empty old + non-empty new → all nodes added, all edges added", () => {
    const newActions: SchemaAction[] = [
      define("api-aaaaaa", "API"),
      define("db-bbbbbb", "DB"),
      connect("api-aaaaaa", "db-bbbbbb"),
    ];
    const result = diffSchemas([], newActions);
    expect(result.added).toHaveLength(2);
    expect(result.removed).toHaveLength(0);
    expect(result.edgesAdded).toHaveLength(1);
    expect(result.edgesRemoved).toHaveLength(0);
  });

  test("Non-empty old + empty new → all nodes removed, all edges removed", () => {
    const oldActions: SchemaAction[] = [
      define("api-aaaaaa", "API"),
      define("db-bbbbbb", "DB"),
      connect("api-aaaaaa", "db-bbbbbb"),
    ];
    const result = diffSchemas(oldActions, []);
    expect(result.removed).toHaveLength(2);
    expect(result.added).toHaveLength(0);
    expect(result.edgesRemoved).toHaveLength(1);
    expect(result.edgesAdded).toHaveLength(0);
  });

  test("Multiple changes simultaneously", () => {
    const oldActions: SchemaAction[] = [
      define("api-aaaaaa", "API"),
      define("cache-cccccc", "Cache"),
      connect("api-aaaaaa", "cache-cccccc"),
    ];
    const newActions: SchemaAction[] = [
      define("api-aaaaaa", "API Gateway"), // renamed
      define("db-bbbbbb", "Database"),     // added
      // cache-cccccc removed
      // old edge removed, new edge added
      connect("api-aaaaaa", "db-bbbbbb"),
    ];
    const result = diffSchemas(oldActions, newActions);
    expect(result.added).toHaveLength(1);
    expect(result.added[0]!.nodeId).toBe("db-bbbbbb");
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0]).toBe("cache-cccccc");
    expect(result.renamed).toHaveLength(1);
    expect(result.renamed[0]!.nodeId).toBe("api-aaaaaa");
    expect(result.edgesAdded).toHaveLength(1);
    expect(result.edgesAdded[0]!.to).toBe("db-bbbbbb");
    expect(result.edgesRemoved).toHaveLength(1);
  });
});
