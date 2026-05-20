
import {
  readMiroToken,
  unsetMiroToken,
  writeMiroToken,
} from "@shemma/backend/src/config";
import { error as uiError, getOutput, info as uiInfo, success as uiSuccess, warn as uiWarn } from "./ui";

const SUPPORTED_KEYS = new Set(["miro.token"]);

function dieUsage(msg: string): never {
  uiError(msg, { code: "usage" });
  process.exit(1);
}

async function validateMiroToken(token: string): Promise<"ok" | "invalid" | "offline"> {
  const base = process.env.SHEMMA_MIRO_BASE_URL ?? "https://api.miro.com";
  try {
    const res = await fetch(`${base}/v2/boards?limit=1`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 401) return "invalid";
    if (res.ok || res.status === 429 || res.status === 400) return "ok";
    return "invalid";
  } catch {
    return "offline";
  }
}

export async function cmdConfigSet(key: string, value: string): Promise<void> {
  if (!SUPPORTED_KEYS.has(key)) {
    dieUsage(`unknown config key: ${key} (supported: ${[...SUPPORTED_KEYS].join(", ")})`);
  }
  if (key === "miro.token") {
    const status = await validateMiroToken(value);
    if (status === "invalid") {
      uiError("miro.token validation failed (401 Unauthorized)", {
        code: "miro-token-invalid",
        hint: "Re-copy the full token from https://miro.com/app/settings/user-profile/apps",
      });
      process.exit(1);
    }
    writeMiroToken(value);
    if (status === "offline") {
      uiWarn("miro.token saved (network check skipped — Miro API unreachable)");
    } else {
      uiSuccess("miro.token saved to ~/.config/shemma/config.json");
    }
    return;
  }
}

export async function cmdConfigGet(key: string): Promise<void> {
  if (!SUPPORTED_KEYS.has(key)) {
    dieUsage(`unknown config key: ${key} (supported: ${[...SUPPORTED_KEYS].join(", ")})`);
  }
  if (key === "miro.token") {
    const t = readMiroToken();
    const ui = getOutput();
    if (ui.mode === "json") {
      process.stdout.write(
        JSON.stringify({ ok: true, key, set: t !== null, length: t?.length ?? 0 }) + "\n",
      );
      return;
    }
    if (t === null) {
      console.log(`miro.token = [unset]`);
    } else {
      console.log(`miro.token = [set] (${t.length} chars)`);
    }
    return;
  }
}

export async function cmdConfigUnset(key: string): Promise<void> {
  if (!SUPPORTED_KEYS.has(key)) {
    dieUsage(`unknown config key: ${key} (supported: ${[...SUPPORTED_KEYS].join(", ")})`);
  }
  if (key === "miro.token") {
    unsetMiroToken();
    uiInfo("miro.token removed");
    return;
  }
}
