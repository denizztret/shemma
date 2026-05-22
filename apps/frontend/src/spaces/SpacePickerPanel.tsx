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
 * Shared inner panel for both the landing `SpacesPage` and the
 * `OpenSpaceDialog` modal. Renders:
 *   - list of registered spaces (clickable rows; optional Forget action)
 *   - "Open by path" input with probe → switch / register / confirm-init / error
 *
 * Visual chrome (backdrop / page background / close button) lives in the two
 * call-sites so the same panel can act as either a modal body or a full
 * landing card.
 */
export function SpacePickerPanel({
  currentSpaceId,
  emptyMessage,
  pathLabel,
  allowForget,
}: {
  currentSpaceId?: string;
  emptyMessage: string;
  pathLabel: string;
  allowForget?: boolean;
}) {
  const [spaces, setSpaces] = useState<SpaceLocalDTO[]>([]);
  const [pathInput, setPathInput] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [listError, setListError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setSpaces(await listSpacesApi());
      setListError(null);
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  function open(spaceId: string) {
    window.location.href = spaceUrl(spaceId);
  }

  async function forget(id: string) {
    const { forgetSpaceApi } = await import("./api");
    await forgetSpaceApi(id);
    await refresh();
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
      const existing = spaces.find((s) => s.path === absPath);
      if (existing) {
        open(existing.id);
        return;
      }
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

  const visibleSpaces = currentSpaceId
    ? spaces.filter((s) => s.id !== currentSpaceId)
    : spaces;

  return (
    <>
      <div style={{ flex: 1, overflowY: "auto" }}>
        {listError && (
          <div
            style={{
              margin: "12px 20px",
              padding: "8px 10px",
              fontSize: tokens.font.sm,
              color: "#b91c1c",
              background: "#fef2f2",
              border: "1px solid #fecaca",
              borderRadius: tokens.radius.sm,
            }}
          >
            {listError}
          </div>
        )}
        {visibleSpaces.length === 0 ? (
          <div
            style={{
              padding: "20px",
              color: tokens.color.textMuted,
              fontSize: tokens.font.sm,
              textAlign: "center",
            }}
          >
            {emptyMessage}
          </div>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: "8px 0" }}>
            {visibleSpaces.map((s) => (
              <li
                key={s.id}
                style={{
                  display: "flex",
                  alignItems: "stretch",
                  borderBottom: `1px solid ${tokens.color.border}`,
                }}
              >
                <button
                  type="button"
                  onClick={() => open(s.id)}
                  style={{
                    flex: 1,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    gap: 2,
                    padding: "10px 20px",
                    background: "transparent",
                    border: "none",
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
                      display: "flex",
                      gap: 8,
                      alignItems: "center",
                    }}
                  >
                    {s.label ?? s.id}
                    {s.legacy && <Badge>legacy</Badge>}
                    {s.orphaned && <Badge tone="warn">orphaned</Badge>}
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
                {allowForget && (
                  <button
                    type="button"
                    onClick={() => void forget(s.id)}
                    title="Forget this space"
                    style={{
                      padding: "0 16px",
                      background: "transparent",
                      border: "none",
                      borderLeft: `1px solid ${tokens.color.border}`,
                      color: tokens.color.textMuted,
                      fontSize: tokens.font.sm,
                      cursor: "pointer",
                    }}
                  >
                    Forget
                  </button>
                )}
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
          {pathLabel}
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
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
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
    </>
  );
}

function Badge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "warn";
}) {
  const palette =
    tone === "warn"
      ? { bg: "#fef3c7", color: "#78350f", border: "#f59e0b" }
      : { bg: "#e5e7eb", color: "#374151", border: "#d1d5db" };
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: 0.5,
        padding: "1px 6px",
        borderRadius: 999,
        background: palette.bg,
        color: palette.color,
        border: `1px solid ${palette.border}`,
      }}
    >
      {children}
    </span>
  );
}
