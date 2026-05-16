import { useEffect, useState } from "react";
import { tokens } from "../design-tokens";
import { type ErrItem, subscribeErrors } from "../state/error-bus";

export function ErrorBanner() {
  const [errs, setErrs] = useState<ErrItem[]>([]);
  useEffect(() => subscribeErrors(setErrs), []);
  if (errs.length === 0) return null;
  return (
    <div
      style={{
        position: "fixed",
        top: 12,
        right: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        zIndex: tokens.z.toast,
        maxWidth: 320,
        pointerEvents: "none",
        fontFamily: tokens.font.sans,
        fontSize: tokens.font.base,
      }}
    >
      {errs.map((e) => (
        <div
          key={e.id}
          style={{
            background: tokens.color.errorBg,
            color: tokens.color.errorText,
            padding: "8px 12px",
            borderRadius: tokens.radius.md,
            boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
          }}
        >
          {e.text}
        </div>
      ))}
    </div>
  );
}
