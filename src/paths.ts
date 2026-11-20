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

/** A path with the home directory shown as ~, for messages. */
export const tildify = (path: string) => (path.startsWith(home()) ? `~${path.slice(home().length)}` : path);

/** This tool's own account store. Independent of any other Antigravity app. */
export const storeDir = () => join(home(), ".agy-switch");
export const storePath = () => join(storeDir(), "accounts.json");

/** The name of the agy CLI's token file, in whichever folder it keeps its data. */
const AGY_TOKEN_FILE = "antigravity-oauth-token";

/** The `agy` CLI's token file. It reads this when its keychain item holds no sign-in. */
export const agyTokenPath = () => join(home(), ".gemini", "antigravity-cli", AGY_TOKEN_FILE);

/** The `agy` CLI's sign-in in the macOS keychain, which it reads before its token file. */
export const AGY_KEYCHAIN = { service: "gemini", account: "antigravity" } as const;

/** The first keychain sign-in agy-switch wrote over that isn't a saved account, such as the agy CLI's own login. */
export const agyKeychainBackupPath = () => join(storeDir(), "agy-cli-keychain.bak");

/** Where T3 Code keeps a profile for each Antigravity provider it has set up. */
export const t3AcpRoot = () => join(home(), ".t3", "userdata", "providers", "antigravity");

/**
 * T3 Code runs `agy acp --gemini-dir <profile> --app-data-dir antigravity-acp`
 * and sets SSH_CONNECTION, so agy skips the keychain and keeps the sign-in in
 * this folder's token file. Seen in T3 Code 0.1.12-nightly, 2026-11-20.
 */
export const t3AgyDir = (profile: string) => join(profile, "antigravity-acp");
export const t3AgyTokenPath = (agyDir: string) => join(agyDir, AGY_TOKEN_FILE);

/**
 * T3 Code's old Antigravity server kept its sign-in here. T3 Code still reads
 * it, before the token file, for the limits it shows.
 */
export const t3LegacyTokenPath = (agyDir: string) => join(agyDir, "acp_token.json");

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
