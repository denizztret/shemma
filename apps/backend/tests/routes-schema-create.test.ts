import { describe, expect, it } from "bun:test";
import { makeApp } from "../src/index";

async function postSchemaCreate(
  app: ReturnType<typeof makeApp>["app"],
  body: unknown,
  room = "sc-test",
) {
  return app.fetch(
    new Request(`http://localhost/api/schema/create?room=${room}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function getState(
  app: ReturnType<typeof makeApp>["app"],
  room = "sc-test",
) {
  const res = await app.fetch(new Request(`http://localhost/api/state?room=${room}`));
  return res.json() as Promise<{ store: { store: Record<string, unknown> } }>;
}

function schemaContainerShapes(store: Record<string, unknown>) {
  return Object.values(store).filter(
    (r) => (r as { typeName?: string; type?: string }).typeName === "shape" &&
            (r as { type?: string }).type === "schema-container",
  ) as Array<{ props: { dash: string } }>;
}

describe("POST /api/schema/create — dash prop from mermaid stroke-dasharray", () => {
  it("subgraph with stroke-dasharray:5,5 → schema-container dash:dashed", async () => {
    const { app } = makeApp({ inMemory: true });
    // NOTE: style directive must appear AFTER the subgraph declaration (parser limitation).
    const raw = `flowchart LR
subgraph OUTER
  A[Alpha]
  B[Beta]
end
style OUTER stroke-dasharray:5,5`;

    const res = await postSchemaCreate(app, { label: "DashTest", raw }, "sc-dash-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const state = await getState(app, "sc-dash-1");
    const containers = schemaContainerShapes(state.store.store);
    expect(containers.length).toBeGreaterThan(0);
    expect(containers[0]!.props.dash).toBe("dashed");
  });

  it("subgraph with stroke-dasharray:1,4 → schema-container dash:dotted", async () => {
    const { app } = makeApp({ inMemory: true });
    const raw = `flowchart LR
subgraph INNER
  C[Gamma]
end
style INNER stroke-dasharray:1,4`;

    const res = await postSchemaCreate(app, { label: "DotTest", raw }, "sc-dash-2");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const state = await getState(app, "sc-dash-2");
    const containers = schemaContainerShapes(state.store.store);
    expect(containers.length).toBeGreaterThan(0);
    expect(containers[0]!.props.dash).toBe("dotted");
  });
});
