import { Hono } from "hono";
import { config } from "../config";

export const sessionRoutes = new Hono().get("/api/session", (c) =>
  c.json({
    sessionId: config.sessionId,
    projectSlug: config.projectSlug,
    workspaceDir: config.workspaceDir,
  }),
);
