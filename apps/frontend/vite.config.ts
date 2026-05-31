import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // Vite dev → ходит на backend profile=dev, default 8788. Можно переопределить env SHEMMA_PORT.
  const backendPort = Number(env.SHEMMA_PORT ?? 8788);
  return {
    plugins: [react()],
    // Minification disabled: the esbuild-minified large vendor chunk (mermaid /
    // cytoscape / katex) trips vite's build-import-analysis (rollup native parser →
    // "Parse error @1:1"). The unminified build is correct; revisit later with
    // code-splitting or terser if bundle size becomes a concern.
    build: { minify: false },
    server: {
      port: 5173,
      proxy: {
        "/api": `http://localhost:${backendPort}`,
        "/ws": { target: `ws://localhost:${backendPort}`, ws: true },
      },
    },
  };
});
