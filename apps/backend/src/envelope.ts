import { config } from "./config";
import type { OpLogEntry, RoomState } from "./types";

// Envelope schemaVersion history:
//   1 — initial canvas + prompts payload (Phase 1).
//   2 — adds durable `opLog` (Phase 2.2). Serializer always emits v2;
//       parser still accepts v1 for backward-compat (opLog defaulted to []).
export const ENVELOPE_SCHEMA_VERSION = 2;
export const SUPPORTED_SCHEMA_VERSIONS = [1, 2] as const;

export type EnvelopeHeader = {
  schemaVersion: 1 | 2;
  roomId: string;
  version: number;
  lastTouched: string; // ISO
  elementCount: number;
};

export type PersistedEnvelope = EnvelopeHeader & {
  canvas: RoomState["canvas"];
  prompts: RoomState["prompts"];
  opLog?: OpLogEntry[]; // present on v2 envelopes; absent on legacy v1 files
};

export type ExportEnvelope = PersistedEnvelope & {
  exportedAt: string; // ISO
};

function buildEnvelope(roomId: string, s: RoomState): PersistedEnvelope {
  return {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    roomId,
    version: s.version,
    lastTouched: new Date(s.lastTouched).toISOString(),
    elementCount:
      s.canvas.nodes.length + s.canvas.edges.length + s.canvas.groups.length,
    canvas: s.canvas,
    prompts: s.prompts,
    opLog: s.opLog.slice(-config.opLogMaxSize),
  };
}

export function serialize(roomId: string, s: RoomState): string {
  return JSON.stringify(buildEnvelope(roomId, s), null, 2);
}

export function parseHeader(raw: string): EnvelopeHeader | null {
  try {
    const j = JSON.parse(raw) as Partial<PersistedEnvelope>;
    if (
      typeof j.schemaVersion !== "number" ||
      typeof j.roomId !== "string" ||
      typeof j.version !== "number" ||
      typeof j.lastTouched !== "string" ||
      typeof j.elementCount !== "number"
    ) {
      return null;
    }
    if (j.schemaVersion !== 1 && j.schemaVersion !== 2) return null;
    return {
      schemaVersion: j.schemaVersion,
      roomId: j.roomId,
      version: j.version,
      lastTouched: j.lastTouched,
      elementCount: j.elementCount,
    };
  } catch {
    return null;
  }
}

export function serializeExport(roomId: string, s: RoomState): string {
  const exp: ExportEnvelope = {
    ...buildEnvelope(roomId, s),
    exportedAt: new Date().toISOString(),
  };
  return JSON.stringify(exp, null, 2);
}

export function parseFull(raw: string): PersistedEnvelope {
  const j = JSON.parse(raw) as Partial<PersistedEnvelope>;
  if (j.schemaVersion !== 1 && j.schemaVersion !== 2) {
    throw new Error(
      `unsupported schemaVersion: ${j.schemaVersion} (expected ${SUPPORTED_SCHEMA_VERSIONS.join("|")})`,
    );
  }
  if (
    typeof j.roomId !== "string" ||
    typeof j.version !== "number" ||
    !j.canvas ||
    !Array.isArray((j.canvas as { nodes?: unknown }).nodes) ||
    !Array.isArray((j.canvas as { edges?: unknown }).edges) ||
    !Array.isArray((j.canvas as { groups?: unknown }).groups) ||
    !Array.isArray(j.prompts)
  ) {
    throw new Error("malformed envelope");
  }
  // v1 → []: graceful migration. v2 → opLog ?? [] (defensive: a malformed v2
  // file with no opLog field still loads; we just lose replay history).
  const opLog: OpLogEntry[] =
    j.schemaVersion === 2 && Array.isArray(j.opLog) ? j.opLog : [];
  // Backfill optional header fields so the returned envelope is fully typed
  // even for legacy files that pre-date strict header validation.
  return {
    schemaVersion: j.schemaVersion,
    roomId: j.roomId,
    version: j.version,
    lastTouched:
      typeof j.lastTouched === "string"
        ? j.lastTouched
        : new Date().toISOString(),
    elementCount:
      typeof j.elementCount === "number"
        ? j.elementCount
        : j.canvas.nodes.length + j.canvas.edges.length + j.canvas.groups.length,
    canvas: j.canvas,
    prompts: j.prompts,
    opLog,
  };
}
