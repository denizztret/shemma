import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // Vite dev → ходит на backend profile=dev, default 8788. Можно переопределить env SHEMMA_PORT.
  const backendPort = Number(env.SHEMMA_PORT ?? 8788);
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        "/api": `http://localhost:${backendPort}`,
        "/ws": { target: `ws://localhost:${backendPort}`, ws: true },
      },
    },
  };
});
