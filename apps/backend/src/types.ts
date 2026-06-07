// apps/backend/src/types.ts
import type { StyleDefaults } from "@shemma/domain";
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

/** Fixed tag colour palette (room-list metadata, not canvas-domain). */
export type RoomTagColor =
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "purple"
  | "gray";

/** A single room tag. Identity is `name`; `color` is from the fixed palette. */
export type RoomTag = { name: string; color: RoomTagColor };

export const ROOM_TAG_COLORS: readonly RoomTagColor[] = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "gray",
];

/** Validation caps for room tags. */
export const ROOM_TAG_MAX_COUNT = 12;
export const ROOM_TAG_MAX_NAME_LENGTH = 24;

export interface RoomMeta {
  miroExports?: MiroExportsMap;
  /** DRW-134 v2 protocol marker. Presence === "v2" → backend routes на v2 handlers. */
  didrawProtocol?: "v2";
  /** DRW-134 NodeId suffix length, range [3..12]. Default 6 если undefined. */
  didrawIdSuffixLength?: number;
  /** Room-list tags. Each tag = { name, color }. Set wholesale via PUT /api/rooms/:id/tags. */
  tags?: RoomTag[];
  /** DRW-180 board-level style defaults; DRW-207 добавил arrowKind (тип новых стрелок). */
  styleDefaults?: StyleDefaults;
}

export type MiroExportsMap = Record<
  string,
  {
    boardName?: string;
    lastExportedAt: string;
    items: Record<string, string>;
    connectors?: Record<string, string>;
    groups?: Record<string, string>;
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
      /** DRW-149: set to true for layout-selection broadcasts so the frontend
       * can route through markHistoryStoppingPoint + editor.run instead of
       * mergeRemoteChanges, making the layout undoable via Cmd+Z. */
      layoutAction?: true;
    },
  ) => void;
};

