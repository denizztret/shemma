import { error as uiError } from "./ui";

export function fail(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: string })?.code;
  const isConnRefused =
    msg.includes("ECONNREFUSED") ||
    code === "ConnectionRefused" ||
    msg.includes("Unable to connect");
  const status = isConnRefused ? 3 : 1;
  uiError(msg, {
    code: msg,
    hint: isConnRefused ? "is the daemon running? try 'shemma daemon start'" : undefined,
  });
  process.exit(status);
}
