import { Hono } from "hono";
export const importMermaidRoutes = new Hono().post("/api/import/mermaid", (c) =>
  c.json({ ok: false, error: "not implemented (Task 22)" }, 501),
);
