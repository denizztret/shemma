// apps/backend/src/envelope.ts
import { config } from "./config";
import type { StoreOpLogEntry, TLStoreSnapshot } from "./store-types";
import type { Prompt, RoomMeta, RoomState } from "./types";

// Schema v3 extension policy (since 0.19.0, DRW-103):
// - Additive optional fields (например `meta?: RoomMeta`) НЕ бампят SCHEMA_VERSION.
// - Required fields / shape changes к existing fields — bump до v4 + migrate-v3.ts.
export const ENVELOPE_SCHEMA_VERSION = 3;
export const SUPPORTED_SCHEMA_VERSIONS = [2, 3] as const; // 2 для migrator; runtime читает 3.

const SHEMMA_VERSION = "0.10.0";

export type EnvelopeHeader = {
  schemaVersion: 2 | 3;
  roomId: string;
  version: number;
  lastTouched: string;
  elementCount: number;
};

export type EnvelopeV3 = EnvelopeHeader & {
  schemaVersion: 3;
  shemma: { shemmaVersion: string; createdAt: string };
  store: TLStoreSnapshot;
  prompts: Prompt[];
  opLog: StoreOpLogEntry[];
  linkedSession?: string;
  // DRW-033: workspace directory, stored optionally (additive, doesn't break existing v3).
  projectDir?: string;
  // DRW-103: room metadata extension (additive optional, no schema bump).
  meta?: RoomMeta;
};

export type ExportEnvelope = EnvelopeV3 & { exportedAt: string };

function countShapes(store: Record<string, { typeName?: string }>): number {
  let n = 0;
  for (const id in store) if (store[id]?.typeName === "shape") n++;
  return n;
}

function buildV3(roomId: string, s: RoomState): EnvelopeV3 {
  const env: EnvelopeV3 = {
    schemaVersion: 3,
    roomId,
    version: s.version,
    lastTouched: new Date(s.lastTouched).toISOString(),
    elementCount: countShapes(s.store.store),
    shemma: { shemmaVersion: SHEMMA_VERSION, createdAt: new Date().toISOString() },
    store: s.store,
    prompts: s.prompts,
    opLog: s.opLog.slice(-config.opLogMaxSize),
  };
  if (s.linkedSession !== undefined) env.linkedSession = s.linkedSession;
  if (s.projectDir !== undefined) env.projectDir = s.projectDir;
  if (s.meta !== undefined) env.meta = s.meta;
  return env;
}

export function serialize(roomId: string, s: RoomState): string {
  return JSON.stringify(buildV3(roomId, s), null, 2);
}

export function serializeExport(roomId: string, s: RoomState): string {
  const exp: ExportEnvelope = { ...buildV3(roomId, s), exportedAt: new Date().toISOString() };
  return JSON.stringify(exp, null, 2);
}

export function parseHeader(raw: string): EnvelopeHeader | null {
  try {
    const j = JSON.parse(raw) as Partial<EnvelopeHeader>;
    if (
      typeof j.schemaVersion !== "number" ||
      typeof j.roomId !== "string" ||
      typeof j.version !== "number" ||
      typeof j.lastTouched !== "string" ||
      typeof j.elementCount !== "number"
    ) return null;
    if (j.schemaVersion !== 2 && j.schemaVersion !== 3) return null;
    return {
      schemaVersion: j.schemaVersion,
      roomId: j.roomId,
      version: j.version,
      lastTouched: j.lastTouched,
      elementCount: j.elementCount,
    };
  } catch { return null; }
}

// v3 only. v2 envelope парсится через `parseV2OrThrow(raw)` в migrate-v2.ts.
// parseFull кидает, если schemaVersion !== 3 — caller (rooms.load) сам решает мигрировать.
function normalizeShemmaMeta(j: Partial<EnvelopeV3> & {
  didraw?: { didrawVersion?: string; createdAt?: string };
}): { shemmaVersion: string; createdAt: string } {
  if (j.shemma) {
    const legacyVer = (j.shemma as { didrawVersion?: string }).didrawVersion;
    return {
      shemmaVersion: j.shemma.shemmaVersion ?? legacyVer ?? SHEMMA_VERSION,
      createdAt: j.shemma.createdAt ?? new Date().toISOString(),
    };
  }
  if (j.didraw) {
    return {
      shemmaVersion: j.didraw.didrawVersion ?? SHEMMA_VERSION,
      createdAt: j.didraw.createdAt ?? new Date().toISOString(),
    };
  }
  return { shemmaVersion: SHEMMA_VERSION, createdAt: new Date().toISOString() };
}

export function parseFull(raw: string): EnvelopeV3 {
  const j = JSON.parse(raw) as Partial<EnvelopeV3>;
  if (j.schemaVersion !== 3) {
    throw new Error(`unsupported schemaVersion: ${String(j.schemaVersion)} (expected 3; v2 must be migrated first)`);
  }
  if (
    typeof j.roomId !== "string" ||
    typeof j.version !== "number" ||
    !j.store ||
    typeof (j.store as { store?: unknown }).store !== "object" ||
    !Array.isArray(j.prompts)
  ) {
    throw new Error("malformed envelope");
  }
  const parsed: EnvelopeV3 = {
    schemaVersion: 3,
    roomId: j.roomId,
    version: j.version,
    lastTouched: typeof j.lastTouched === "string" ? j.lastTouched : new Date().toISOString(),
    elementCount: typeof j.elementCount === "number" ? j.elementCount : countShapes(j.store.store as Record<string, { typeName?: string }>),
    // Legacy compat: pre-0.10.0 envelopes used `didraw` key with `didrawVersion`.
    // Accept both keys; normalize to the new `shemma` key with `shemmaVersion`.
    shemma: normalizeShemmaMeta(j),
    store: j.store as TLStoreSnapshot,
    prompts: j.prompts,
    opLog: Array.isArray(j.opLog) ? j.opLog : [],
  };
  if (typeof j.linkedSession === "string") parsed.linkedSession = j.linkedSession;
  if (typeof j.projectDir === "string") parsed.projectDir = j.projectDir;
  if (j.meta !== undefined && typeof j.meta === "object" && j.meta !== null) {
    parsed.meta = j.meta as RoomMeta;
  }
  return parsed;
}

// Используется migrate-v2.ts. Принимает schemaVersion 2 или 1 (treat v1 as v2 для migrator).
export function parseV2OrThrow(raw: string): { schemaVersion: 2; roomId: string; version: number; lastTouched: string; elementCount: number; canvas: unknown; prompts: Prompt[]; opLog: unknown[] } {
  const j = JSON.parse(raw);
  if (j?.schemaVersion !== 2 && j?.schemaVersion !== 1) throw new Error(`expected v1|v2 envelope, got: ${j?.schemaVersion}`);
  return {
    schemaVersion: 2,
    roomId: String(j.roomId ?? "default"),
    version: typeof j.version === "number" ? j.version : 0,
    lastTouched: typeof j.lastTouched === "string" ? j.lastTouched : new Date().toISOString(),
    elementCount: typeof j.elementCount === "number" ? j.elementCount : 0,
    canvas: j.canvas,
    prompts: Array.isArray(j.prompts) ? j.prompts : [],
    opLog: Array.isArray(j.opLog) ? j.opLog : [],
  };
}
