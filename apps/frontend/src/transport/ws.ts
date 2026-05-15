import { room } from "./api";

export type WsMessage =
  | { kind: "hello"; version: number }
  | {
      kind: "patch";
      source: "ai" | "user";
      // biome-ignore lint/suspicious/noExplicitAny: patch ops are opaque backend schema
      ops: any[];
      version: number;
      originClientId?: string;
    }
  // biome-ignore lint/suspicious/noExplicitAny: prompt schema is opaque backend type
  | { kind: "prompt-created"; prompt: any }
  | { kind: "prompt-resolved"; id: string; response?: string };

export function openWs(handlers: {
  // biome-ignore lint/suspicious/noExplicitAny: patch message passed through opaquely
  onPatch?: (m: any) => void;
  // biome-ignore lint/suspicious/noExplicitAny: prompt message passed through opaquely
  onPromptCreated?: (m: any) => void;
  // biome-ignore lint/suspicious/noExplicitAny: prompt-resolved message passed through opaquely
  onPromptResolved?: (m: any) => void;
}) {
  let ws: WebSocket | null = null;
  let attempt = 0;
  let stopped = false;
  const connect = () => {
    if (stopped) return;
    ws = new WebSocket(
      `ws://${location.host}/ws?room=${encodeURIComponent(room)}`,
    );
    ws.onopen = () => {
      attempt = 0;
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data as string) as WsMessage;
      if (m.kind === "patch") handlers.onPatch?.(m);
      if (m.kind === "prompt-created") handlers.onPromptCreated?.(m);
      if (m.kind === "prompt-resolved") handlers.onPromptResolved?.(m);
    };
    ws.onclose = () => {
      if (stopped) return;
      const d = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
      attempt++;
      setTimeout(connect, d);
    };
    ws.onerror = () => ws?.close();
  };
  connect();
  return () => {
    stopped = true;
    ws?.close();
  };
}
