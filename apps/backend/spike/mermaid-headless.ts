import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
});
// @ts-expect-error
globalThis.window = dom.window;
// @ts-expect-error
globalThis.document = dom.window.document;
// @ts-expect-error
globalThis.navigator = dom.window.navigator;

const t0 = performance.now();
const mod = await import("@tldraw/mermaid");
const t1 = performance.now();

console.log("loaded keys:", Object.keys(mod));
console.log("ms to load:", (t1 - t0).toFixed(1));

try {
  // @ts-expect-error — runtime spike, exact API verified post-install
  const result = await mod.createMermaidDiagram?.({
    source: "graph LR\n a --> b",
  });
  console.log("ok, nodes:", result?.nodes?.length ?? result);
} catch (err) {
  console.error("FAIL:", (err as Error).message);
  process.exit(1);
}
