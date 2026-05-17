import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const BACKEND = path.resolve(ROOT, "apps/backend");
const FRONTEND = path.resolve(ROOT, "apps/frontend");

export default defineConfig({
  testDir: "./tests",
  // Use `.pw.ts` suffix so root `bun test` auto-discovery (which scans for
  // `*.spec.ts` / `*.test.ts`) does not pick up Playwright specs and crash
  // when it encounters playwright's `test()` API in bun runtime (DRW-023).
  testMatch: /.*\.pw\.ts$/,
  use: { baseURL: "http://localhost:5173" },
  // Run two web servers: backend on :8788, frontend vite on :5173.
  webServer: [
    {
      command: `DIDRAW_PROFILE=dev bun ${BACKEND}/src/index.ts`,
      url: "http://localhost:8788/healthz",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "bun run dev",
      cwd: FRONTEND,
      url: "http://localhost:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
  // Run tests sequentially — they share backend state.
  workers: 1,
  reporter: [["list"]],
});
