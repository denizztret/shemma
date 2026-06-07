import { useCallback, useEffect, useRef, useState } from "react";
import type { SpaceLocalDTO } from "@shemma/spaces";
import { tokens } from "../design-tokens";
import {
  LEGACY_SPACE_ID,
  type RoomListItem,
  type RoomTag,
  listRooms,
  purgeArchive,
} from "../transport/api";
import { fetchSession } from "../transport/session";
import { pushError } from "../state/error-bus";
import { ErrorBanner } from "../chrome/ErrorBanner";
import { OpenSpaceDialog } from "../spaces/OpenSpaceDialog";
import { getSpaceApi } from "../spaces/api";
import { type FilterTab, FilterTabs } from "./FilterTabs";
import { GroupHeader, type SortMode } from "./GroupHeader";
import { NewRoomForm } from "./NewRoomForm";
import { RoomCard } from "./RoomCard";
import { RoomListRow } from "./RoomListRow";
import { SpacePathButton } from "./SpacePathButton";
import { TagChip } from "./TagChip";
import { roomMatchesTagFilter } from "./tag-filter";
import {
  type ViewMode,
  ViewModeToggle,
  loadViewMode,
  saveViewMode,
} from "./ViewModeToggle";

type RoomGroup = {
  title: string;
  rooms: RoomListItem[];
  sortMode: SortMode;
};

function sortRooms(rooms: RoomListItem[], mode: SortMode): RoomListItem[] {
  return [...rooms].sort((a, b) => {
    if (mode === "name") {
      return a.id.localeCompare(b.id);
    }
    // lastTouched DESC
    return (
      Date.parse(b.lastTouched) - Date.parse(a.lastTouched)
    );
  });
}

export function Gallery({ space }: { space: string }) {
  const [filterTab, setFilterTab] = useState<FilterTab>("current");
  const [rooms, setRooms] = useState<RoomListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [workspaceDir, setWorkspaceDir] = useState<string>("");
  const [home, setHome] = useState<string>("");
  const [spaceRecord, setSpaceRecord] = useState<SpaceLocalDTO | null>(null);
  const [openSwitcher, setOpenSwitcher] = useState(false);
  // Per-group sort state; keyed by group title
  const [sortModes, setSortModes] = useState<Record<string, SortMode>>({});
  const [viewMode, setViewMode] = useState<ViewMode>(loadViewMode);
  // Ephemeral tag filter (AND logic). Stored as RoomTag so the active-filter
  // bar can show each tag's colour; matching is by name (case-insensitive).
  const [activeTags, setActiveTags] = useState<RoomTag[]>([]);

  useEffect(() => {
    saveViewMode(viewMode);
  }, [viewMode]);

  function handleTagClick(tag: RoomTag) {
    setActiveTags((prev) =>
      prev.some((t) => t.name.toLowerCase() === tag.name.toLowerCase())
        ? prev
        : [...prev, tag],
    );
  }

  function removeActiveTag(name: string) {
    setActiveTags((prev) =>
      prev.filter((t) => t.name.toLowerCase() !== name.toLowerCase()),
    );
  }

  function handleTagsChanged(roomId: string, tags: RoomTag[]) {
    setRooms((prev) =>
      prev.map((r) => (r.id === roomId ? { ...r, tags } : r)),
    );
  }

  useEffect(() => {
    fetchSession()
      .then((s) => {
        setSessionId(s.sessionId);
        setWorkspaceDir(s.workspaceDir ?? "");
        setHome(s.home ?? "");
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (space === LEGACY_SPACE_ID) {
      setSpaceRecord(null);
      return;
    }
    let cancelled = false;
    void getSpaceApi(space)
      .then((r) => {
        if (!cancelled) setSpaceRecord(r);
      })
      .catch(() => {
        if (!cancelled) setSpaceRecord(null);
      });
    return () => {
      cancelled = true;
    };
  }, [space]);

  useEffect(() => {
    setLoading(true);
    listRooms(space, { includeArchived: filterTab === "archived" })
      .then((res) => setRooms(res.rooms))
      .catch((e) => pushError(`Failed to load rooms: ${(e as Error).message}`))
      .finally(() => setLoading(false));
  }, [filterTab, space]);

  function handleArchived(id: string) {
    setRooms((prev) => prev.filter((r) => r.id !== id));
  }

  function handleRestored(id: string) {
    // If we're in archived tab, remove from list on restore (it goes to active)
    // If we're in current tab, add it back
    if (filterTab === "archived") {
      setRooms((prev) => prev.filter((r) => r.id !== id));
    } else {
      // Re-fetch to get restored room in active list
      listRooms(space, { includeArchived: false })
        .then((res) => setRooms(res.rooms))
        .catch(() => {});
    }
  }

  function handleDeleted(id: string) {
    setRooms((prev) => prev.filter((r) => r.id !== id));
  }

  // Last time a (silent) refetch actually fired. Used to coalesce focus +
  // visibilitychange + interval so they don't trigger a burst of requests.
  const lastRefetchRef = useRef(0);
  const REFETCH_MIN_GAP_MS = 4000;

  // Silent refetch used by auto-refresh (focus / visibility / poll). Errors are
  // swallowed — a transient failure shouldn't spam the banner during background
  // polling. `handleRefresh` (explicit) still surfaces errors.
  const silentRefetch = useCallback(() => {
    const now = Date.now();
    if (now - lastRefetchRef.current < REFETCH_MIN_GAP_MS) return;
    lastRefetchRef.current = now;
    listRooms(space, { includeArchived: filterTab === "archived" })
      .then((res) => setRooms(res.rooms))
      .catch(() => {});
  }, [space, filterTab]);

  function handleRefresh() {
    lastRefetchRef.current = Date.now();
    listRooms(space, { includeArchived: filterTab === "archived" })
      .then((res) => setRooms(res.rooms))
      .catch((e) => pushError(`Failed to reload rooms: ${(e as Error).message}`));
  }

  // Auto-refresh: keep thumbnails fresh (server SVG is cache-busted by
  // room.version, so a new list → new version → new image). Fires on tab/window
  // focus, on visibility→visible, and on a gentle interval while visible. All
  // routed through silentRefetch which coalesces bursts via REFETCH_MIN_GAP_MS.
  useEffect(() => {
    function onFocus() {
      silentRefetch();
    }
    function onVisibility() {
      if (document.visibilityState === "visible") silentRefetch();
    }
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);

    const interval = setInterval(() => {
      if (document.visibilityState === "visible") silentRefetch();
    }, 13000);

    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(interval);
    };
  }, [silentRefetch]);

  function toggleSort(groupTitle: string) {
    setSortModes((prev) => ({
      ...prev,
      [groupTitle]: prev[groupTitle] === "name" ? "lastTouched" : "name",
    }));
  }

  async function handlePurgeArchive() {
    if (
      !window.confirm(
        "Empty the archive? All archived rooms will be permanently deleted.",
      )
    )
      return;
    try {
      const result = await purgeArchive(space);
      setRooms([]);
      pushError(`Removed ${result.removed} archived room(s).`);
    } catch (e) {
      pushError(`Failed to empty archive: ${(e as Error).message}`);
    }
  }

  // ─── Tag filter (AND logic) ──────────────────────────────────────────────────
  // Composes with FilterTabs: tag filter narrows the already-tab-scoped list.
  const activeTagNames = activeTags.map((t) => t.name);
  const filteredRooms =
    activeTagNames.length === 0
      ? rooms
      : rooms.filter((r) => roomMatchesTagFilter(r, activeTagNames));

  // ─── Grouping logic ──────────────────────────────────────────────────────────
  // Current tab: group by "Current workspace" vs "Past sessions"
  // Archived tab: single group "Archived"
  const groups: RoomGroup[] = [];

  if (filterTab === "archived") {
    const groupTitle = "Archived";
    const archivedRooms = filteredRooms.filter((r) => r.archived === true);
    groups.push({
      title: groupTitle,
      rooms: sortRooms(archivedRooms, sortModes[groupTitle] ?? "lastTouched"),
      sortMode: sortModes[groupTitle] ?? "lastTouched",
    });
  } else {
    // Current tab — split into current session vs past sessions
    const currentRooms: RoomListItem[] = [];
    const pastRooms: RoomListItem[] = [];

    for (const r of filteredRooms) {
      if (r.archived) continue;
      // "Past sessions": rooms where linkedSession is set but NOT the current session
      const isPast =
        r.linkedSession !== undefined &&
        (sessionId === null || r.linkedSession !== sessionId);
      if (isPast) {
        pastRooms.push(r);
      } else {
        currentRooms.push(r);
      }
    }

    if (currentRooms.length > 0 || rooms.length === 0) {
      const groupTitle = "Current workspace";
      groups.push({
        title: groupTitle,
        rooms: sortRooms(currentRooms, sortModes[groupTitle] ?? "lastTouched"),
        sortMode: sortModes[groupTitle] ?? "lastTouched",
      });
    }

    if (pastRooms.length > 0) {
      const groupTitle = "Past sessions";
      groups.push({
        title: groupTitle,
        rooms: sortRooms(pastRooms, sortModes[groupTitle] ?? "lastTouched"),
        sortMode: sortModes[groupTitle] ?? "lastTouched",
      });
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: tokens.color.bgPage,
        fontFamily: tokens.font.sans,
      }}
    >
      {/* Fixed error banner */}
      <ErrorBanner />

      {/* Header bar */}
      <div
        style={{
          background: tokens.color.bgOverlay,
          borderBottom: `1px solid ${tokens.color.border}`,
          padding: "0 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          height: 56,
          position: "sticky",
          top: 0,
          zIndex: tokens.z.overlay,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <span
            style={{
              fontFamily: tokens.font.mono,
              fontSize: tokens.font.base,
              fontWeight: 700,
              color: tokens.color.text,
            }}
          >
            shemma
          </span>
          {(spaceRecord?.path ?? workspaceDir) && (
            <SpacePathButton
              space={space}
              path={spaceRecord?.path ?? workspaceDir}
              home={home}
            />
          )}
          <button
            type="button"
            onClick={() => setOpenSwitcher(true)}
            style={{
              fontFamily: tokens.font.sans,
              fontSize: tokens.font.sm,
              color: tokens.color.text,
              background: tokens.color.bgOverlay,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.sm,
              padding: "4px 10px",
              cursor: "pointer",
            }}
          >
            Open Space
          </button>
        </div>
        <NewRoomForm space={space} />
      </div>

      {/* Main content */}
      <div
        style={{
          maxWidth: 960,
          margin: "0 auto",
          padding: "24px 24px",
        }}
      >
        <h1
          style={{
            fontFamily: tokens.font.sans,
            fontSize: 22,
            fontWeight: 700,
            color: tokens.color.text,
            marginBottom: 20,
            marginTop: 0,
          }}
        >
          Rooms
        </h1>

        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <FilterTabs active={filterTab} onChange={setFilterTab} />
          <div style={{ paddingBottom: 8 }}>
            <ViewModeToggle mode={viewMode} onChange={setViewMode} />
          </div>
        </div>

        {/* Active tag filters (AND) */}
        {activeTags.length > 0 && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 6,
              marginBottom: 16,
            }}
          >
            <span
              style={{
                fontFamily: tokens.font.sans,
                fontSize: tokens.font.sm,
                color: tokens.color.textMuted,
              }}
            >
              Filtering by:
            </span>
            {activeTags.map((t) => (
              <TagChip
                key={t.name}
                tag={t}
                onRemove={() => removeActiveTag(t.name)}
              />
            ))}
            <button
              type="button"
              onClick={() => setActiveTags([])}
              style={{
                fontFamily: tokens.font.sans,
                fontSize: tokens.font.sm,
                color: tokens.color.textMuted,
                background: "transparent",
                border: "none",
                cursor: "pointer",
                textDecoration: "underline",
                padding: "0 4px",
              }}
            >
              × clear
            </button>
          </div>
        )}

        {/* Archived tab: "Empty archive" button */}
        {filterTab === "archived" && rooms.length > 0 && (
          <div style={{ marginBottom: 16, display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={handlePurgeArchive}
              style={{
                fontFamily: tokens.font.sans,
                fontSize: tokens.font.sm,
                color: tokens.color.errorBg,
                background: "transparent",
                border: `1px solid ${tokens.color.errorBg}`,
                borderRadius: tokens.radius.sm,
                padding: "4px 12px",
                cursor: "pointer",
              }}
            >
              Empty archive
            </button>
          </div>
        )}

        {loading ? (
          <div
            style={{
              color: tokens.color.textMuted,
              fontFamily: tokens.font.sans,
              fontSize: tokens.font.base,
              padding: "40px 0",
              textAlign: "center",
            }}
          >
            Loading rooms…
          </div>
        ) : groups.length === 0 || groups.every((g) => g.rooms.length === 0) ? (
          <div
            style={{
              color: tokens.color.textMuted,
              fontFamily: tokens.font.sans,
              fontSize: tokens.font.base,
              padding: "40px 0",
              textAlign: "center",
            }}
          >
            {filterTab === "archived"
              ? "No archived rooms."
              : "No rooms yet — create one above."}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
            {groups.map((group) =>
              group.rooms.length === 0 ? null : (
                <section key={group.title}>
                  <GroupHeader
                    title={group.title}
                    count={group.rooms.length}
                    sortMode={group.sortMode}
                    onToggleSort={() => toggleSort(group.title)}
                  />
                  {viewMode === "grid" ? (
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns:
                          "repeat(auto-fill, minmax(280px, 1fr))",
                        gap: 16,
                      }}
                    >
                      {group.rooms.map((r) => (
                        <RoomCard
                          key={r.id}
                          space={space}
                          room={r}
                          sessionId={sessionId}
                          onArchived={handleArchived}
                          onRestored={handleRestored}
                          onDeleted={handleDeleted}
                          onRefresh={handleRefresh}
                          onTagClick={handleTagClick}
                          onTagsChanged={handleTagsChanged}
                        />
                      ))}
                    </div>
                  ) : (
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        borderTop: `1px solid ${tokens.color.border}`,
                      }}
                    >
                      {group.rooms.map((r) => (
                        <RoomListRow
                          key={r.id}
                          space={space}
                          room={r}
                          sessionId={sessionId}
                          onArchived={handleArchived}
                          onRestored={handleRestored}
                          onDeleted={handleDeleted}
                          onRefresh={handleRefresh}
                          onTagClick={handleTagClick}
                          onTagsChanged={handleTagsChanged}
                        />
                      ))}
                    </div>
                  )}
                </section>
              ),
            )}
          </div>
        )}
      </div>

      {openSwitcher && (
        <OpenSpaceDialog
          currentSpaceId={space}
          onClose={() => setOpenSwitcher(false)}
        />
      )}
    </div>
  );
}
