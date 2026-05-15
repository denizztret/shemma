import { Hono } from "hono";
import { config } from "./config";

const app = new Hono();
app.get("/healthz", (c) => c.json({ ok: true, version: "0.0.0" }));

if (import.meta.main) {
  const server = Bun.serve({ port: config.port, fetch: app.fetch });
  console.log(`[didraw] listening on http://localhost:${server.port}`);
}
