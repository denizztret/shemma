import { Hono } from "hono";
import { config } from "../config";
import { checkLatest } from "../update-check";
import { VERSION } from "../version";

export const versionRoutes = new Hono().get("/api/version", async (c) => {
  const upd = await checkLatest();
  return c.json({ ...VERSION, profile: config.profile, ...upd });
});
