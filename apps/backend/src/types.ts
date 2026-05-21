// apps/backend/src/types.ts
import type {
  StoreChangeBatch,
  StoreOpLogEntry,
  TLStoreSnapshot,
} from "./store-types";

export const DEFAULT_ROOM = "default";
export type RoomId = string;

export type Prompt = {
  id: string;
  selection: string[];
  text: string;
  createdAt: number;
  status: "pending" | "resolved" | "dismissed";
  response?: string;
  resolvedAt?: number;
};

export type AiActivity = {
  actor: string;
  task: string;
  startedAt: number;
};

export interface RoomMeta {
  miroExports?: MiroExportsMap;
}

export type MiroExportsMap = Record<
  string,
  {
    boardName?: string;
    lastExportedAt: string;
    items: Record<string, string>;
    connectors?: Record<string, string>;
  }
>;

export type RoomState = {
  store: TLStoreSnapshot;
  opLog: StoreOpLogEntry[];
  prompts: Prompt[];
  version: number;
  dirty: boolean;
  lastTouched: number;
  aiActivity?: AiActivity;
  // Индекс meta.didrawName → shape.id для O(1) lookup в compile.ts.
  // Перестраивается при каждой apply через store-ops.rebuildDidrawIndex().
  didrawIndex: Map<string, string>;
  // Привязка к сессии Claude Code: проставляется автоматически при первом
  // создании комнаты если CLAUDE_SESSION_ID === roomId.
  linkedSession?: string;
  // Рабочий каталог проекта, где был создан сервер. Используется для
  // группировки комнат в Gallery (DRW-033). Опционально — старые файлы
  // его не имеют и получают его при первом обращении.
  projectDir?: string;
  meta?: RoomMeta;
};

export type WsClientMessage =
  | { kind: "hello"; lastVersion: number; schema?: unknown }
  | { kind: "user-change"; changes: StoreChangeBatch; clientOpId?: string }
  | { kind: "board-focus"; room: string; focused: boolean }
  | {
      kind: "import-mermaid-result";
      requestId: string;
      ok: boolean;
      shape_ids?: string[];
      didraw_names?: string[];
      root_ids?: string[];
      error?: string;
    };

export type WsMessage =
  | { kind: "hello"; version: number }
  | { kind: "sync-ack"; version: number }
  | { kind: "replay"; changes: StoreChangeBatch[]; version: number }
  | { kind: "truncated"; version: number }
  | {
      kind: "store-change";
      source: "ai" | "user";
      changes: StoreChangeBatch;
      version: number;
      originClientId?: string;
    }
  | { kind: "prompt-created"; prompt: Prompt }
  | { kind: "prompt-resolved"; id: string; response?: string }
  | { kind: "prompt-removed"; ids: string[] }
  | { kind: "ai-activity"; activity: AiActivity | null }
  | {
      kind: "import-mermaid";
      source: string;
      requestId: string;
      /** DRW-086: viewport behavior after import. Default 'new'. */
      focus?: "new" | "fit-all" | "none";
    };

export type StoreChangeBus = {
  /**
   * Publish a store-change frame to every subscriber of `(space, room)`.
   *
   * DRW-116 Task 12 — subscriptions are composite-keyed by space + room, so
   * routes MUST thread the active space id through every publish call. Legacy
   * single-space callers (or tests that never registered a space) pass the
   * synthesized `LEGACY_SPACE_ID` ("__legacy__") to land in the default
   * bucket.
   */
  publish: (
    space: string,
    room: string,
    msg: {
      changes: StoreChangeBatch;
      source: "ai" | "user";
      version: number;
      originClientId?: string;
    },
  ) => void;
};

