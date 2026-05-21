import { useEffect, useState } from "react";
import type { SpaceLocalDTO } from "@shemma/spaces";
import { AddSpaceForm } from "./AddSpaceForm";
import { forgetSpaceApi, listSpacesApi } from "./api";
import { relativeTime, truncatePath } from "./format";

/**
 * Landing page (spec §7.2): list of registered spaces + form to add a new one.
 *
 * Routing convention: clicking a space navigates to `/?space=<id>` — the
 * single-column form parseShemmaUrl already recognises. Multi-column open
 * comes in later tasks.
 */
export function SpacesPage() {
  const [spaces, setSpaces] = useState<SpaceLocalDTO[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setSpaces(await listSpacesApi());
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const open = (id: string) => {
    window.location.href = `/?space=${encodeURIComponent(id)}`;
  };

  const forget = async (id: string) => {
    await forgetSpaceApi(id);
    await refresh();
  };

  return (
    <main className="spaces-page">
      <h1>Spaces ({spaces.length})</h1>
      <AddSpaceForm onAdded={open} />
      {loadError && <div className="error">{loadError}</div>}
      <ul className="spaces-list">
        {spaces.map((s) => (
          <li key={s.id}>
            <button type="button" onClick={() => open(s.id)}>
              {s.label ?? s.id}
            </button>
            <code title={s.path}>{truncatePath(s.path)}</code>
            {s.legacy && <span className="badge">Legacy</span>}
            {s.orphaned && <span className="badge">Orphaned</span>}
            <time dateTime={s.lastUsedAt}>{relativeTime(s.lastUsedAt)}</time>
            <button type="button" onClick={() => forget(s.id)}>
              Forget
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
