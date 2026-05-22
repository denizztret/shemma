import { tokens } from "../design-tokens";
import { SpacePickerPanel } from "./SpacePickerPanel";

/**
 * Modal switcher invoked from the Gallery header. Wraps `SpacePickerPanel`
 * with a backdrop and close button. The picker handles registered-space
 * list + path-input flows; the dialog just owns its own chrome.
 */
export function OpenSpaceDialog({
  currentSpaceId,
  onClose,
}: {
  currentSpaceId: string;
  onClose: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Open Space"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: tokens.color.backdrop,
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
        <SpacePickerPanel
          currentSpaceId={currentSpaceId}
          emptyMessage="No other registered spaces."
          pathLabel="Open by path"
        />
      </div>
    </div>
  );
}
