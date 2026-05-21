import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import { spacesJsonPath, configDir } from "./paths.js";
import { generateSpaceId } from "./id-gen.js";
import type { SpaceId, SpaceRecord, SpaceStorageLayout, SpacesRegistryFile } from "./types.js";

const EMPTY: SpacesRegistryFile = { schemaVersion: 1, spaces: [] };

function ensureDir(): void {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o755 });
}

export function loadRegistry(): SpacesRegistryFile {
  const file = spacesJsonPath();
  if (!fs.existsSync(file)) return structuredClone(EMPTY);
  const raw = fs.readFileSync(file, "utf8");
  const parsed = JSON.parse(raw) as SpacesRegistryFile;
  if (parsed.schemaVersion !== 1) throw new Error(`Unsupported spaces.json schema ${parsed.schemaVersion}`);
  return parsed;
}

function writeAtomic(content: SpacesRegistryFile): void {
  ensureDir();
  const file = spacesJsonPath();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(content, null, 2), { mode: 0o644 });
  fs.renameSync(tmp, file);
}

export function loadAndModify(fn: (reg: SpacesRegistryFile) => SpacesRegistryFile): SpacesRegistryFile {
  ensureDir();
  const file = spacesJsonPath();
  if (!fs.existsSync(file)) writeAtomic(EMPTY);
  const release = lockfile.lockSync(file, { stale: 10000 });
  try {
    const before = loadRegistry();
    const after = fn(structuredClone(before));
    writeAtomic(after);
    return after;
  } finally {
    release();
  }
}

export function registerSpace(
  rawPath: string,
  opts: { id?: SpaceId; storageLayout?: SpaceStorageLayout; legacy?: boolean; label?: string } = {},
): { space: SpaceRecord; created: boolean } {
  const real = fs.realpathSync(rawPath);
  let resultSpace: SpaceRecord | undefined;
  let created = false;
  loadAndModify(reg => {
    const existing = reg.spaces.find(s => s.path === real);
    if (existing) {
      existing.lastUsedAt = new Date().toISOString();
      resultSpace = existing;
      return reg;
    }
    const usedIds = new Set(reg.spaces.map(s => s.id));
    const id = opts.id && !usedIds.has(opts.id) ? opts.id : generateSpaceId(real, usedIds);
    const now = new Date().toISOString();
    const record: SpaceRecord = {
      id,
      path: real,
      storageLayout: opts.storageLayout ?? "project",
      label: opts.label,
      createdAt: now,
      lastUsedAt: now,
      legacy: opts.legacy,
    };
    reg.spaces.push(record);
    resultSpace = record;
    created = true;
    return reg;
  });
  return { space: resultSpace!, created };
}

export function forgetSpace(id: SpaceId): void {
  loadAndModify(reg => {
    reg.spaces = reg.spaces.filter(s => s.id !== id);
    return reg;
  });
}

export function renameSpaceLabel(id: SpaceId, label: string): SpaceRecord {
  let result: SpaceRecord | undefined;
  loadAndModify(reg => {
    const s = reg.spaces.find(r => r.id === id);
    if (!s) throw new Error(`space not found: ${id}`);
    s.label = label;
    result = s;
    return reg;
  });
  return result!;
}

export function findSpaceById(id: SpaceId): SpaceRecord | undefined {
  return loadRegistry().spaces.find(s => s.id === id);
}

export function findSpaceByPath(absolutePath: string): SpaceRecord | undefined {
  const real = fs.realpathSync(absolutePath);
  return loadRegistry().spaces.find(s => s.path === real);
}

export function listSpaces(): SpaceRecord[] {
  return loadRegistry()
    .spaces
    .slice()
    .sort((a, b) => (a.lastUsedAt < b.lastUsedAt ? 1 : -1));
}

export function touchLastUsed(id: SpaceId): void {
  loadAndModify(reg => {
    const s = reg.spaces.find(r => r.id === id);
    if (s) s.lastUsedAt = new Date().toISOString();
    return reg;
  });
}
