import { Hono } from "hono";
export const healthRoutes = new Hono().get("/healthz", (c) =>
  c.json({ ok: true }),
);
