export function fail(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: string })?.code;
  const isConnRefused =
    msg.includes("ECONNREFUSED") ||
    code === "ConnectionRefused" ||
    msg.includes("Unable to connect");
  const status = isConnRefused ? 3 : 1;
  console.error(JSON.stringify({ ok: false, error: msg }));
  process.exit(status);
}
