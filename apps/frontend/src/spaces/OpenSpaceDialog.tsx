import { useEffect, useState } from "react";
import type { SpaceLocalDTO } from "@shemma/spaces";
import { tokens } from "../design-tokens";
import { addSpaceApi, expandHomePath, listSpacesApi } from "./api";
import { relativeTime, truncatePath } from "./format";
import { spaceUrl } from "./url-parser";

type Status =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "confirm-init"; absPath: string }
  | { kind: "error"; message: string };

/**
 * Modal switcher invoked from the Gallery header.
 *
 * Two affordances:
 *   1. Pick a registered space from the list → navigate to `/?space=<id>`.
 *   2. Type a path → resolve:
 *        - exact-match registered space → switch
 *        - new path with existing `.shemma/canvas/` → register + switch
 *        - new path, no `.shemma/` → confirm "initialize?" → register + switch
 *        - missing path → error
 *
 * Backend currently auto-creates `.shemma/canvas/` on register (project layout
 * resolver). The confirm step is UX-only — guards accidental clicks in
 * arbitrary directories. Once user confirms, we POST /api/spaces and let the
 * backend do the directory creation.
 */
export function OpenSpaceDialog({
  currentSpaceId,
  onClose,
}: {
  currentSpaceId: string;
  onClose: () => void;
}) {
  const [spaces, setSpaces] = useState<SpaceLocalDTO[]>([]);
  const [pathInput, setPathInput] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    void listSpacesApi()
      .then((items) => {
        if (!cancelled) setSpaces(items);
      })
      .catch((err) => {
        if (!cancelled) {
          setStatus({ kind: "error", message: (err as Error).message });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function open(spaceId: string) {
    window.location.href = spaceUrl(spaceId);
  }

  async function register(absPath: string) {
    try {
      const { space } = await addSpaceApi(absPath);
      open(space.id);
    } catch (err) {
      setStatus({ kind: "error", message: (err as Error).message });
    }
  }

  async function submitPath() {
    if (!pathInput.trim()) return;
    setStatus({ kind: "busy" });
    try {
      const absPath = await expandHomePath(pathInput.trim());

      // 1. Path matches an already-registered space → just switch.
      const existing = spaces.find((s) => s.path === absPath);
      if (existing) {
        open(existing.id);
        return;
      }

      // 2. Probe filesystem via a register attempt. Backend already validates
      // existence (`ENOENT → path_not_found`) and creates `.shemma/canvas/`
      // on success. For "no .shemma yet" we route through a confirm step so
      // the user knows we're about to initialize a new gallery.
      const probe = await fetch("/api/probe-space-path", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: absPath }),
      });
      if (!probe.ok) {
        const data = (await probe.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        const msg =
          data.error === "path_not_found"
            ? `Path does not exist: ${absPath}`
            : (data.message ?? data.error ?? "Probe failed");
        setStatus({ kind: "error", message: msg });
        return;
      }
      const probeData = (await probe.json()) as {
        hasShemma: boolean;
        absolutePath: string;
      };

      if (probeData.hasShemma) {
        await register(probeData.absolutePath);
      } else {
        setStatus({ kind: "confirm-init", absPath: probeData.absolutePath });
      }
    } catch (err) {
      setStatus({ kind: "error", message: (err as Error).message });
    }
  }

  const isLegacy = currentSpaceId.startsWith("__");
  const filteredSpaces = isLegacy
    ? spaces
    : spaces.filter((s) => s.id !== currentSpaceId);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Open Space"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        zIndex: tokens.z.modal,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "10vh",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: tokens.color.bgOverlay,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.lg,
          width: 520,
          maxWidth: "92vw",
          maxHeight: "70vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          fontFamily: tokens.font.sans,
          boxShadow: "0 24px 64px rgba(0,0,0,0.18)",
        }}
      >
        <header
          style={{
            padding: "16px 20px",
            borderBottom: `1px solid ${tokens.color.border}`,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <strong style={{ fontSize: 15 }}>Open Space</strong>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              fontSize: 20,
              cursor: "pointer",
              color: tokens.color.textMuted,
            }}
          >
            ×
          </button>
        </header>

        <div style={{ flex: 1, overflowY: "auto" }}>
          {filteredSpaces.length === 0 ? (
            <div
              style={{
                padding: "16px 20px",
                color: tokens.color.textMuted,
                fontSize: tokens.font.sm,
              }}
            >
              No other registered spaces.
            </div>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: "8px 0" }}>
              {filteredSpaces.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => open(s.id)}
                    style={{
                      width: "100%",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-start",
                      gap: 2,
                      padding: "10px 20px",
                      background: "transparent",
                      border: "none",
                      borderBottom: `1px solid ${tokens.color.border}`,
                      cursor: "pointer",
                      textAlign: "left",
                      fontFamily: "inherit",
                    }}
                  >
                    <span
                      style={{
                        fontWeight: 600,
                        fontSize: tokens.font.base,
                        color: tokens.color.text,
                      }}
                    >
                      {s.label ?? s.id}
                    </span>
                    <span
                      style={{
                        fontFamily: tokens.font.mono,
                        fontSize: tokens.font.sm,
                        color: tokens.color.textMuted,
                      }}
                      title={s.path}
                    >
                      {truncatePath(s.path)}
                    </span>
                    {s.lastUsedAt && (
                      <span
                        style={{
                          fontSize: 11,
                          color: tokens.color.textMuted,
                        }}
                      >
                        {relativeTime(s.lastUsedAt)}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div
          style={{
            padding: "16px 20px",
            borderTop: `1px solid ${tokens.color.border}`,
            background: "rgba(0,0,0,0.02)",
          }}
        >
          <label
            style={{
              display: "block",
              fontSize: tokens.font.sm,
              fontWeight: 600,
              marginBottom: 6,
              color: tokens.color.text,
            }}
          >
            Open by path
          </label>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submitPath();
            }}
            style={{ display: "flex", gap: 8 }}
          >
            <input
              type="text"
              placeholder="~/projects/my-canvas"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              disabled={status.kind === "busy"}
              style={{
                flex: 1,
                padding: "8px 10px",
                fontFamily: tokens.font.mono,
                fontSize: tokens.font.sm,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.sm,
                background: "#fff",
              }}
            />
            <button
              type="submit"
              disabled={status.kind === "busy" || pathInput.trim().length === 0}
              style={{
                padding: "8px 14px",
                fontFamily: tokens.font.sans,
                fontSize: tokens.font.sm,
                fontWeight: 600,
                color: "#fff",
                background: tokens.color.accent,
                border: "none",
                borderRadius: tokens.radius.sm,
                cursor: "pointer",
                opacity: status.kind === "busy" ? 0.5 : 1,
              }}
            >
              Open
            </button>
          </form>

          {status.kind === "error" && (
            <div
              style={{
                marginTop: 10,
                padding: "8px 10px",
                fontSize: tokens.font.sm,
                color: "#b91c1c",
                background: "#fef2f2",
                border: "1px solid #fecaca",
                borderRadius: tokens.radius.sm,
              }}
            >
              {status.message}
            </div>
          )}

          {status.kind === "confirm-init" && (
            <div
              style={{
                marginTop: 10,
                padding: "10px 12px",
                fontSize: tokens.font.sm,
                background: "#fffbeb",
                border: "1px solid #fde68a",
                borderRadius: tokens.radius.sm,
              }}
            >
              <div style={{ marginBottom: 8 }}>
                No <code>.shemma/canvas/</code> at{" "}
                <code>{status.absPath}</code>. Initialize a new space here?
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  onClick={() => void register(status.absPath)}
                  style={{
                    padding: "6px 12px",
                    fontSize: tokens.font.sm,
                    fontWeight: 600,
                    color: "#fff",
                    background: "#16a34a",
                    border: "none",
                    borderRadius: tokens.radius.sm,
                    cursor: "pointer",
                  }}
                >
                  Initialize
                </button>
                <button
                  type="button"
                  onClick={() => setStatus({ kind: "idle" })}
                  style={{
                    padding: "6px 12px",
                    fontSize: tokens.font.sm,
                    background: "transparent",
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: tokens.radius.sm,
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
