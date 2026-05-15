import type { RoomState } from "./types";

export const ENVELOPE_SCHEMA_VERSION = 1;

export type EnvelopeHeader = {
  schemaVersion: number;
  roomId: string;
  version: number;
  lastTouched: string; // ISO
  elementCount: number;
};

export type PersistedEnvelope = EnvelopeHeader & {
  canvas: RoomState["canvas"];
  prompts: RoomState["prompts"];
};

export type ExportEnvelope = PersistedEnvelope & {
  exportedAt: string; // ISO
};

export function serialize(roomId: string, s: RoomState): string {
  const env: PersistedEnvelope = {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    roomId,
    version: s.version,
    lastTouched: new Date(s.lastTouched).toISOString(),
    elementCount:
      s.canvas.nodes.length + s.canvas.edges.length + s.canvas.groups.length,
    canvas: s.canvas,
    prompts: s.prompts,
  };
  return JSON.stringify(env, null, 2);
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
  const base = JSON.parse(serialize(roomId, s)) as PersistedEnvelope;
  const exp: ExportEnvelope = {
    ...base,
    exportedAt: new Date().toISOString(),
  };
  return JSON.stringify(exp, null, 2);
}

export function parseFull(raw: string): PersistedEnvelope {
  const j = JSON.parse(raw) as Partial<PersistedEnvelope>;
  if (j.schemaVersion !== ENVELOPE_SCHEMA_VERSION) {
    throw new Error(
      `unsupported schemaVersion: ${j.schemaVersion} (expected ${ENVELOPE_SCHEMA_VERSION})`,
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
  return j as PersistedEnvelope;
}
