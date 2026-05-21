import { type FormEvent, useState } from "react";
import { addSpaceApi, expandHomePath } from "./api";

/**
 * Minimal form to register a new space by absolute filesystem path.
 * Supports `~` and `~/...` shorthand (expanded via `/api/session`).
 */
export function AddSpaceForm({ onAdded }: { onAdded: (id: string) => void }) {
  const [pathInput, setPathInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const resolved = await expandHomePath(pathInput.trim());
      const { space } = await addSpaceApi(resolved);
      setPathInput("");
      onAdded(space.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="add-space-form" onSubmit={submit}>
      <input
        type="text"
        value={pathInput}
        onChange={(e) => setPathInput(e.target.value)}
        placeholder="/Users/me/Projects/my-app or ~/Projects/my-app"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
      />
      <button type="submit" disabled={busy || pathInput.trim().length === 0}>
        {busy ? "Adding…" : "Add"}
      </button>
      {error && <div className="error">{error}</div>}
    </form>
  );
}
