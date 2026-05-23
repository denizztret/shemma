/**
 * DRW-141 — backend-side fractional index assignment for batches of newly
 * created shapes within a single parent.
 *
 * Before this helper, every shape constructed by `schema-create` / `schema-patch`
 * /`schema-duplicate` got the hardcoded `index: "a1"`. tldraw 5.x uses fractional
 * indexing to order siblings within a parent; collisions are tolerated for
 * rendering but break operations that compute a "between" index — most notably
 * `editor.duplicateShapes` (it throws `Error: a1 >= a1` when low >= high).
 *
 * The helper assigns lexicographically-ordered, parent-scoped indices to all
 * `added` shapes of a `StoreChangeBatch`. Existing shapes in the store retain
 * whatever index they already have — we only touch records introduced by the
 * batch.
 *
 * Index format: `a{NN}` where NN is base36 padded to 3 chars (`a000`..`azzz`,
 * 46656 unique values per parent — plenty for any realistic schema).
 * Lexicographic order matches numeric order because of the fixed width.
 */

import type { StoreChangeBatch, TLRecord } from "../../store-types";

const PAD = 3;
const MAX_PER_PARENT = 36 ** PAD;

/**
 * tldraw 5.x `IndexKey` validation rule: an index key may NOT end with `"0"`
 * because fractional indexing treats trailing zeros as implicit (so `a01` and
 * `a010` would denote the same position). Earlier this helper produced
 * `a000`/`a010`/`a020` which tldraw rejected at hydrate:
 *   `ValidationError: Expected an index key, got "a000"`.
 *
 * Fix: append a stable `"z"` suffix so generated indices never end in `"0"`.
 * Lexicographic order is preserved (the suffix is constant) and the format
 * `a<3-char base36>z` reads cleanly as 4 chars after the bucket letter.
 */
function indexAt(i: number): string {
  if (i < 0) throw new Error(`indexAt: negative index ${i}`);
  if (i >= MAX_PER_PARENT) {
    throw new Error(`indexAt: too many siblings (${i} ≥ ${MAX_PER_PARENT})`);
  }
  return `a${i.toString(36).padStart(PAD, "0")}z`;
}

/**
 * Assign incremental, lexicographically-ordered indices to every newly added
 * shape in `batch`. Records grouped by `parentId`; existing siblings (already
 * in `priorStore`) are ignored — newcomers start from the highest existing
 * index + 1 (in lexicographic order). Each new shape gets a unique index
 * within its parent.
 *
 * Idempotent if no `added` shapes exist.
 */
export function assignBatchIndices(
  batch: StoreChangeBatch,
  priorStore: Record<string, TLRecord | undefined>,
): void {
  // Group new shapes by parentId — preserve insertion order via Map.
  const byParent = new Map<string, string[]>();
  for (const id in batch.added) {
    const rec = batch.added[id];
    if (!rec || rec.typeName !== "shape") continue;
    const parentId = rec.parentId;
    if (typeof parentId !== "string") continue;
    const list = byParent.get(parentId) ?? [];
    list.push(id);
    byParent.set(parentId, list);
  }

  for (const [parentId, ids] of byParent) {
    // Find highest existing index among siblings already in the store
    // (don't double-count records that ALSO appear in batch.added — but
    // priorStore is the pre-batch snapshot, so collision is unlikely).
    let maxOrdinal = 0;
    for (const otherId in priorStore) {
      const r = priorStore[otherId];
      if (!r || r.typeName !== "shape") continue;
      if (r.parentId !== parentId) continue;
      const idx = typeof r.index === "string" ? r.index : "";
      // Best effort parse — match our own `a<3-char base36>z` shape exactly.
      // tldraw native indices (e.g. `a4q9xb6V`, `a10ydSfkl`) don't match this
      // form and are intentionally ignored — they'd overflow as a base36 int.
      const m = /^a([0-9a-z]{3})z$/i.exec(idx);
      if (!m) continue;
      const n = Number.parseInt(m[1]!.toLowerCase(), 36);
      if (!Number.isFinite(n)) continue;
      if (n + 1 > maxOrdinal) maxOrdinal = n + 1;
    }
    // Assign new indices starting from maxOrdinal.
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      const rec = batch.added[id];
      if (!rec) continue;
      // biome-ignore lint/suspicious/noExplicitAny: TLRecord index field is opaque
      (rec as any).index = indexAt(maxOrdinal + i);
    }
  }
}
