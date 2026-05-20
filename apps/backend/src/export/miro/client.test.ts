import { afterEach, describe, expect, it } from "bun:test";
import { MiroClient, MiroAuthError, MiroNotFoundError, MiroRateLimitError } from "./client";

function startMockMiro(
  handler: (req: Request) => Promise<Response> | Response,
): { url: string; stop: () => void } {
  const server = Bun.serve({ port: 0, fetch: handler });
  return {
    url: `http://localhost:${server.port}`,
    stop: () => server.stop(true),
  };
}

let mock: { url: string; stop: () => void } | null = null;

afterEach(() => {
  mock?.stop();
  mock = null;
});

describe("MiroClient — auth & URL encoding", () => {
  it("sends Authorization: Bearer <token>", async () => {
    let capturedAuth: string | null = null;
    mock = startMockMiro((req) => {
      capturedAuth = req.headers.get("authorization");
      return new Response(JSON.stringify({ data: [], total: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new MiroClient({ token: "tok-xyz", baseUrl: mock.url });
    await client.listBoards();
    expect(capturedAuth).toBe("Bearer tok-xyz");
  });

  it("URL-encodes board id (=  → %3D)", async () => {
    let capturedPath = "";
    mock = startMockMiro((req) => {
      capturedPath = new URL(req.url).pathname;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    const client = new MiroClient({ token: "t", baseUrl: mock.url });
    await client.bulkItems("aBcD=", [{ type: "shape", data: { shape: "rectangle" } }]);
    expect(capturedPath).toContain("aBcD%3D");
    expect(capturedPath).not.toContain("aBcD=");
  });
});

describe("MiroClient — error mapping", () => {
  it("401 → throws MiroAuthError", async () => {
    mock = startMockMiro(() =>
      new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 }),
    );
    const client = new MiroClient({ token: "bad", baseUrl: mock.url });
    await expect(client.listBoards()).rejects.toBeInstanceOf(MiroAuthError);
  });

  it("404 → throws MiroNotFoundError", async () => {
    mock = startMockMiro(() => new Response("{}", { status: 404 }));
    const client = new MiroClient({ token: "t", baseUrl: mock.url });
    await expect(client.bulkItems("nope", [])).rejects.toBeInstanceOf(MiroNotFoundError);
  });

  it("5xx → throws Error with status in message", async () => {
    mock = startMockMiro(() => new Response("oops", { status: 502 }));
    const client = new MiroClient({ token: "t", baseUrl: mock.url });
    await expect(client.listBoards()).rejects.toThrow(/502/);
  });
});

describe("MiroClient — retry on 429", () => {
  it("retries on 429 with exponential backoff, succeeds on 3rd attempt", async () => {
    let calls = 0;
    mock = startMockMiro(() => {
      calls += 1;
      if (calls < 3) return new Response("{}", { status: 429 });
      return new Response(JSON.stringify({ data: [{ id: "ok" }] }), { status: 201 });
    });
    const client = new MiroClient({
      token: "t",
      baseUrl: mock.url,
      retryDelays: [10, 20, 40],
    });
    const res = await client.bulkItems("b1", [{ type: "shape", data: { shape: "rectangle" } }]);
    expect(calls).toBe(3);
    expect(res.data[0].id).toBe("ok");
  });

  it("429 × 4 (exhausted): throws MiroRateLimitError after final attempt", async () => {
    let calls = 0;
    mock = startMockMiro(() => {
      calls += 1;
      return new Response("{}", { status: 429 });
    });
    const client = new MiroClient({
      token: "t",
      baseUrl: mock.url,
      retryDelays: [5, 10, 20],
    });
    await expect(client.bulkItems("b1", [])).rejects.toBeInstanceOf(MiroRateLimitError);
    expect(calls).toBe(4);
  });
});

describe("MiroClient — listBoards", () => {
  it("GET /v2/boards?limit=50 returns parsed array", async () => {
    let path = "";
    mock = startMockMiro((req) => {
      const u = new URL(req.url);
      path = u.pathname + u.search;
      return new Response(
        JSON.stringify({
          data: [
            { id: "b1=", name: "Board 1", viewLink: "https://miro.com/app/board/b1=" },
          ],
          total: 1,
        }),
        { status: 200 },
      );
    });
    const client = new MiroClient({ token: "t", baseUrl: mock.url });
    const boards = await client.listBoards();
    expect(path).toBe("/v2/boards?limit=50");
    expect(boards[0].id).toBe("b1=");
    expect(boards[0].name).toBe("Board 1");
  });
});

describe("MiroClient — postConnector", () => {
  it("POST /v2/boards/<id>/connectors with payload", async () => {
    let capturedBody: unknown = null;
    let capturedPath = "";
    mock = startMockMiro(async (req) => {
      capturedPath = new URL(req.url).pathname;
      capturedBody = await req.json();
      return new Response(JSON.stringify({ id: "c1" }), { status: 201 });
    });
    const client = new MiroClient({ token: "t", baseUrl: mock.url });
    const res = await client.postConnector("b1=", {
      startItem: { id: "i1", snapTo: "auto" },
      endItem: { id: "i2", snapTo: "auto" },
      shape: "straight",
    });
    expect(capturedPath).toContain("/v2/boards/b1%3D/connectors");
    expect((capturedBody as { shape?: string }).shape).toBe("straight");
    expect(res.id).toBe("c1");
  });
});
