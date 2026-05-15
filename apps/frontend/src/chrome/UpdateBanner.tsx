import { useEffect, useState } from "react";
import { tokens } from "../design-tokens";
import { type VersionInfo, fetchVersion } from "../transport/version";

export function UpdateBanner() {
  const [v, setV] = useState<VersionInfo | null>(null);
  useEffect(() => {
    fetchVersion().then(setV);
  }, []);
  if (!v?.updateAvailable) return null;
  return (
    <div
      style={{
        background: tokens.color.warnBg,
        borderBottom: `1px solid ${tokens.color.warnBorder}`,
        padding: "6px 12px",
        fontSize: tokens.font.base,
        fontFamily: tokens.font.sans,
        color: tokens.color.warnText,
        textAlign: "center",
      }}
    >
      <strong>v{v.latest}</strong> available — run{" "}
      <code
        style={{
          background: tokens.color.warnBorder,
          color: "#fff",
          padding: "1px 6px",
          borderRadius: tokens.radius.sm,
        }}
      >
        didraw update
      </code>{" "}
      to upgrade
    </div>
  );
}
