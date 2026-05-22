import { tokens } from "../design-tokens";
import { SpacePickerPanel } from "./SpacePickerPanel";

/**
 * Landing page (bare `/`): centered card in the same visual language as the
 * `OpenSpaceDialog` modal. List of registered spaces with `Forget`
 * affordance, plus path-input to add / initialize a new one.
 */
export function SpacesPage() {
  return (
    <main
      style={{
        minHeight: "100vh",
        background: tokens.color.bgPage,
        fontFamily: tokens.font.sans,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "10vh 16px 40px",
      }}
    >
      <div
        style={{
          background: tokens.color.bgOverlay,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.lg,
          width: 560,
          maxWidth: "100%",
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 24px 64px rgba(0,0,0,0.08)",
        }}
      >
        <header
          style={{
            padding: "20px 24px",
            borderBottom: `1px solid ${tokens.color.border}`,
            display: "flex",
            alignItems: "baseline",
            gap: 10,
          }}
        >
          <strong
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 16,
              color: tokens.color.text,
            }}
          >
            shemma
          </strong>
          <span
            style={{
              fontSize: tokens.font.sm,
              color: tokens.color.textMuted,
            }}
          >
            Spaces
          </span>
        </header>
        <SpacePickerPanel
          emptyMessage="No spaces registered yet. Add one below."
          pathLabel="Add a space by path"
          allowForget
        />
      </div>
    </main>
  );
}
