import { useEffect, useState } from "react";
import type { SpaceLocalDTO } from "@shemma/spaces";
import { tokens } from "../design-tokens";
import { expandHomePath, fetchSession } from "../transport/session";
import {
  addSpaceApi,
  forgetSpaceApi,
  listSpacesApi,
  probeSpacePathApi,
} from "./api";
import { relativeTime, tildify, truncatePath } from "./format";
import { spaceUrl } from "./url-parser";

type Status =
  | { kind: "loading" }
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "confirm-init"; absPath: string }
  | { kind: "error"; message: string };

/**
 * Shared inner panel for both the landing `SpacesPage` and the
 * `OpenSpaceDialog` modal. Renders:
 *   - list of registered spaces (clickable rows; optional Forget action)
 *   - "Open by path" input with probe → switch / register / confirm-init / error
 *
 * Visual chrome (backdrop / page background / close button) lives in the
 * two call-sites so the same panel can act as either a modal body or a
 * full landing card.
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
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [home, setHome] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetchSession()
      .then((s) => {
        if (!cancelled) setHome(s.home ?? "");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    listSpacesApi()
      .then((items) => {
        if (cancelled) return;
        setSpaces(items);
        setStatus({ kind: "idle" });
      })
      .catch((err) => {
        if (cancelled) return;
        setStatus({ kind: "error", message: (err as Error).message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function open(spaceId: string) {
    window.location.href = spaceUrl(spaceId);
  }

  async function forget(id: string) {
    try {
      await forgetSpaceApi(id);
      setSpaces(await listSpacesApi());
    } catch (err) {
      setStatus({ kind: "error", message: (err as Error).message });
    }
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
    const trimmed = pathInput.trim();
    if (!trimmed || status.kind === "loading" || status.kind === "submitting") {
      return;
    }
    setStatus({ kind: "submitting" });
    try {
      const absPath = await expandHomePath(trimmed);
      const existing = spaces.find((s) => s.path === absPath);
      if (existing) {
        open(existing.id);
        return;
      }
      const probe = await probeSpacePathApi(absPath);
      if (!probe.ok) {
        const msg =
          probe.error === "path_not_found"
            ? `Path does not exist: ${absPath}`
            : (probe.message ?? probe.error);
        setStatus({ kind: "error", message: msg });
        return;
      }
      if (probe.hasShemma) {
        await register(probe.absolutePath);
      } else {
        setStatus({ kind: "confirm-init", absPath: probe.absolutePath });
      }
    } catch (err) {
      setStatus({ kind: "error", message: (err as Error).message });
    }
  }

  const visibleSpaces = currentSpaceId
    ? spaces.filter((s) => s.id !== currentSpaceId)
    : spaces;
  const submitDisabled =
    status.kind === "loading" ||
    status.kind === "submitting" ||
    pathInput.trim().length === 0;

  return (
    <>
      <div style={{ flex: 1, overflowY: "auto" }}>
        {status.kind === "loading" && (
          <div
            style={{
              padding: 20,
              color: tokens.color.textMuted,
              fontSize: tokens.font.sm,
              textAlign: "center",
            }}
          >
            Loading…
          </div>
        )}
        {status.kind !== "loading" && visibleSpaces.length === 0 && (
          <div
            style={{
              padding: 20,
              color: tokens.color.textMuted,
              fontSize: tokens.font.sm,
              textAlign: "center",
            }}
          >
            {emptyMessage}
          </div>
        )}
        {visibleSpaces.length > 0 && (
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
                    {truncatePath(tildify(s.path, home))}
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
            disabled={status.kind === "submitting"}
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
              background: tokens.color.bg,
            }}
          />
          <button
            type="submit"
            disabled={submitDisabled}
            style={{
              padding: "8px 14px",
              fontFamily: tokens.font.sans,
              fontSize: tokens.font.sm,
              fontWeight: 600,
              color: tokens.color.bg,
              background: tokens.color.accent,
              border: "none",
              borderRadius: tokens.radius.sm,
              cursor: "pointer",
              opacity: submitDisabled ? 0.5 : 1,
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
              color: tokens.color.dangerText,
              background: tokens.color.dangerBg,
              border: `1px solid ${tokens.color.dangerBorder}`,
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
              color: tokens.color.warnText,
              background: tokens.color.warnBg,
              border: `1px solid ${tokens.color.warnBorder}`,
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
                  color: tokens.color.bg,
                  background: tokens.color.successBg,
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
      ? {
          bg: tokens.color.warnBg,
          color: tokens.color.warnText,
          border: tokens.color.warnBorder,
        }
      : {
          bg: tokens.color.badgeBg,
          color: tokens.color.badgeText,
          border: tokens.color.badgeBorder,
        };
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
