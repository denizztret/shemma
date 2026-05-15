import { Hono } from "hono";
export const layoutRoutes = new Hono().post("/api/layout", (c) =>
  c.json({ ok: false, error: "not implemented (Task 24)" }, 501),
);
