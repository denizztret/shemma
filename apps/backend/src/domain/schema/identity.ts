// apps/backend/src/domain/schema/identity.ts
// Backend-side wrapper над @shemma/domain identity API.
// Использует crypto.randomBytes вместо Math.random — необходимо для
// production-grade энтропии на сервере (spec §Risks#4, DRW-134 Task 1.2).

import { randomBytes } from "node:crypto";
import { type NodeId, generateNodeId, slugify } from "@shemma/domain";

/** Crypto-based RNG возвращает [0,1).
 *  4 bytes → uint32BE → делим на 2^32. */
function cryptoRng(): number {
  return randomBytes(4).readUInt32BE(0) / 0x1_0000_0000;
}

/** Генерирует NodeId с backend-grade entropy (crypto.randomBytes).
 *  Единственная точка на backend, знающая о RNG;
 *  downstream code (apply, duplicate) импортирует только этот модуль. */
export function generateNodeIdServer(opts: {
  slug: string;
  suffixLen?: number;
  existingIds: ReadonlySet<NodeId>;
}): NodeId {
  return generateNodeId({ ...opts, rng: cryptoRng });
}

/** Удобный хелпер: slugify label → generateNodeIdServer.
 *  Empty label → slug "" → anonymous form `e-<Nchar>` (per Task 1.1 contract).
 *
 *  Тонкость: `slugify("")` возвращает `"shape"` (fallback), что даёт `shape-<Nchar>`.
 *  Для явно пустого label нужна anonymous form `e-<Nchar>`, поэтому передаём `""`
 *  напрямую в generateNodeIdServer, минуя slugify-fallback. */
export function nodeIdFromLabel(
  label: string,
  existingIds: ReadonlySet<NodeId>,
  suffixLen?: number,
): NodeId {
  const slug = label === "" ? "" : slugify(label);
  return generateNodeIdServer({ slug, existingIds, suffixLen });
}

// Re-export часто нужных утилит, чтобы downstream не смешивал импорты.
export { slugify, isValidNodeId, nodeIdRegex } from "@shemma/domain";
