import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";

/**
 * Paths resolve on access, never at import time, so an overridden HOME
 * (sandbox, test, other machine) is always honoured.
 */
export function home(): string {
  return process.env.HOME?.trim() || homedir();
}

/** This tool's own account store. Independent of any other Antigravity app. */
export const storeDir = () => join(home(), ".agy-switch");
export const storePath = () => join(storeDir(), "accounts.json");

/** Where the `agy` CLI keeps its credentials. */
export const agyTokenPath = () =>
  join(home(), ".gemini", "antigravity-cli", "antigravity-oauth-token");

/** Where T3 Code keeps antigravity ACP provider state (one dir per instance). */
export const t3AcpRoot = () => join(home(), ".t3", "userdata", "providers", "antigravity");

/**
 * The bundled ACP harness T3 installs. It drives the Google PKCE flow and
 * writes the token itself, so login reuses it rather than reimplementing OAuth.
 */
export function harnessBinary(): string | null {
  const override = process.env.AGY_SWITCH_HARNESS?.trim();
  if (override && existsSync(override)) return override;

  const root = join(home(), ".t3", "tools", "antigravity-acp");
  if (!existsSync(root)) return null;

  for (const platform of readdirSync(root)) {
    const platformDir = join(root, platform);
    if (!platformDir.startsWith(root)) continue;
    const activePath = join(platformDir, "active.json");
    if (!existsSync(activePath)) continue;
    try {
      const { releaseId } = JSON.parse(readFileSync(activePath, "utf8")) as { releaseId?: string };
      if (!releaseId) continue;
      const bin = join(platformDir, "versions", releaseId, "agy_acp_server.par");
      if (existsSync(bin)) return bin;
    } catch {
      /* try the next platform */
    }
  }
  return null;
}
