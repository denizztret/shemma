import { expect, test } from "@playwright/test";

const BACKEND_URL = "http://localhost:8788"; // dev backend (matches root `dev` script)

test("AI patch appears in canvas; user move sends back to backend", async ({
  page,
}) => {
  // Use a unique room per test run to avoid state pollution.
  const room = `golden-${Date.now()}`;
  await page.goto(`/?room=${room}`);

  // Wait for tldraw to mount.
  await page.locator(".tl-canvas").waitFor({ timeout: 10_000 });

  // 1. AI sends patch via backend → WS broadcast → frontend creates shape
  const addRes = await page.request.post(
    `${BACKEND_URL}/api/patch?room=${room}`,
    {
      headers: { "content-type": "application/json" },
      data: {
        ops: [
          {
            op: "add",
            target: "node",
            value: { id: "n1", kind: "rect", x: 100, y: 100, label: "AI" },
          },
        ],
        source: "ai",
      },
    },
  );
  expect(addRes.ok()).toBe(true);

  // Wait for the tldraw shape to render. The shape's label appears inside
  // .tl-shape (the actual shape element) — not in .tl-text-measure (hidden
  // measurement div). We scope to .tl-shapes to avoid the hidden clone.
  const shapeContainer = page.locator(".tl-shapes .tl-shape");
  await expect(shapeContainer).toBeVisible({ timeout: 5_000 });

  // Also assert the label text is visible within the shape.
  await expect(shapeContainer.getByText("AI", { exact: true })).toBeVisible({
    timeout: 5_000,
  });

  // 2. User drags the shape — frontend should diff and POST a patch
  const shapeBB = await shapeContainer.boundingBox();
  if (!shapeBB) throw new Error("Shape bounding box not found");

  // Use mouse API for reliable drag on tldraw canvas.
  const startX = shapeBB.x + shapeBB.width / 2;
  const startY = shapeBB.y + shapeBB.height / 2;
  const endX = 350;
  const endY = 250;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Move in small steps to trigger tldraw's drag detection.
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      startX + ((endX - startX) * i) / steps,
      startY + ((endY - startY) * i) / steps,
    );
  }
  await page.mouse.up();

  // Allow store-listen → sendPatch → backend save round-trip.
  await page.waitForTimeout(800);

  // 3. Verify backend has updated state
  const stateRes = await page.request.get(
    `${BACKEND_URL}/api/state?room=${room}&fmt=full`,
  );
  const state = await stateRes.json();
  const node = state.canvas.nodes.find((n: { id: string }) => n.id === "n1");
  expect(node).toBeDefined();
  expect(node.x).toBeGreaterThan(150);
});
