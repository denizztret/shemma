import type { Editor, TLRecord, TLStore } from "tldraw";

type LoadableSnapshot = { schema?: unknown; store?: Record<string, unknown> };

/**
 * Keep only records that pass the store's schema validation; drop (and log) the
 * rest. Pure over the store seam → integration-testable with a headless TLStore.
 * (DRW-231)
 */
export function partitionValidRecords(
  store: TLStore,
  records: Record<string, TLRecord>,
  warn: (msg: string, err?: unknown) => void = console.warn,
): { valid: Record<string, TLRecord>; dropped: number } {
  const valid: Record<string, TLRecord> = {};
  let dropped = 0;
  for (const id in records) {
    const rec = records[id];
    if (!rec) continue;
    try {
      store.schema.validateRecord(store, rec as never, "initialize", null);
      valid[id] = rec;
    } catch (err) {
      dropped++;
      warn(
        `[shemma] skipped invalid record ${id} during snapshot load`,
        err,
      );
    }
  }
  return { valid, dropped };
}

/**
 * Load a store snapshot, tolerating individual invalid records.
 *
 * Fast path: `editor.loadSnapshot` — atomic, runs migrations, sets up editor
 * state (current page, camera, instance). If a single record fails strict
 * validation (a raw-hex `props.color`, an out-of-enum `size`, a corrupt field),
 * tldraw throws and rolls the whole transaction back — which would otherwise
 * blank the ENTIRE board (DRW-231). On failure we migrate the snapshot, drop the
 * few records that fail validation, and re-run `editor.loadSnapshot` on the
 * cleaned set — reusing the official path so editor state is wired correctly
 * (a record-by-record `store.put` does NOT restore current page / instance).
 *
 * Caller MUST wrap this in `editor.store.mergeRemoteChanges(() => ...)`.
 */
export function loadSnapshotResilient(
  editor: Editor,
  snapshot: LoadableSnapshot,
): void {
  try {
    editor.loadSnapshot(snapshot as never);
    return;
  } catch (err) {
    console.warn(
      "[shemma] loadSnapshot failed; dropping invalid records and retrying to salvage the board",
      err,
    );
    const migrated = editor.store.schema.migrateStoreSnapshot({
      schema: snapshot.schema,
      store: snapshot.store ?? {},
    } as never);
    if (migrated.type !== "success") {
      // Can't even migrate the schema — surface the original failure.
      throw err;
    }
    const { valid, dropped } = partitionValidRecords(
      editor.store,
      migrated.value as Record<string, TLRecord>,
    );
    try {
      editor.loadSnapshot({
        schema: editor.store.schema.serialize(),
        store: valid,
      } as never);
    } catch {
      // Cleaned set still won't load — surface the original failure rather than
      // leaving the editor half-initialised.
      throw err;
    }
    console.warn(
      `[shemma] board loaded with ${dropped} invalid record(s) skipped`,
    );
  }
}
