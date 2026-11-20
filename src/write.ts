import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readKeychain, writeKeychain } from "./keychain.ts";
import {
  AGY_KEYCHAIN,
  agyKeychainBackupPath,
  agyTokenPath,
  t3AcpRoot,
  t3AgyDir,
  t3AgyTokenPath,
  t3LegacyTokenPath,
} from "./paths.ts";
import type { Account } from "./store.ts";

/** go-keyring, which the agy CLI keeps its keychain sign-in with, stores a secret as base64 behind this. */
const GO_KEYRING = "go-keyring-base64:";

/** The agy CLI's sign-in, the same JSON in its keychain item and its token files. */
type AgySignIn = { token?: { refresh_token?: string } };

/** The agy folder in each Antigravity profile T3 Code has set up. */
export function findT3AgyDirs(): string[] {
  const root = t3AcpRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((profile) => t3AgyDir(join(root, profile)))
    .filter((dir) => existsSync(dir));
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** The sign-in T3 Code's Gemini runs read in each profile, with its refresh token, or null when there's none. */
export function t3SignIns(): { path: string; refreshToken: string | null }[] {
  return findT3AgyDirs().map((dir) => {
    const path = t3AgyTokenPath(dir);
    return { path, refreshToken: readJson<AgySignIn>(path)?.token?.refresh_token || null };
  });
}

/** The agy CLI's sign-in in a keychain value, or null when the value isn't one. */
function decodeAgySignIn(value: string): AgySignIn | null {
  try {
    const json = value.startsWith(GO_KEYRING) ? Buffer.from(value.slice(GO_KEYRING.length), "base64").toString("utf8") : value;
    return JSON.parse(json) as AgySignIn;
  } catch {
    return null;
  }
}

/** The agy CLI's keychain sign-in, or null when there's none or the keychain can't be read. */
function readAgyKeychain(): AgySignIn | null {
  if (process.platform !== "darwin") return null;
  try {
    const value = readKeychain(AGY_KEYCHAIN.service, AGY_KEYCHAIN.account);
    return value === null ? null : decodeAgySignIn(value);
  } catch {
    // The agy CLI falls back to its file when it can't read the keychain, and so does this.
    return null;
  }
}

/**
 * Which saved account T3 Code's Gemini runs and the agy CLI use now, matched by
 * refresh token. null means no sign-in, or one that isn't a saved account.
 */
export function activeAccounts(accounts: Account[]): { t3: string | null; agy: string | null } {
  const owner = (token: string | null | undefined) =>
    (token && accounts.find((a) => a.acpToken.refresh_token === token)?.email) || null;
  const t3 = t3SignIns().map((s) => owner(s.refreshToken)).find(Boolean) ?? null;
  // The order the agy CLI reads them in: its keychain item, then its file.
  const agy = owner(readAgyKeychain()?.token?.refresh_token ?? readJson<AgySignIn>(agyTokenPath())?.token?.refresh_token);
  return { t3, agy };
}

/** The account's sign-in in the agy CLI's own format. agy renews the access token when it has expired. */
function agySignIn(account: Account): string {
  return JSON.stringify({
    token: {
      access_token: account.accessToken ?? "",
      token_type: "Bearer",
      refresh_token: account.acpToken.refresh_token,
      expiry: new Date(account.expiresAt ?? Date.now()).toISOString(),
    },
    auth_method: "consumer",
    id_token_email: account.email,
  });
}

/**
 * Write a sign-in file through a temporary file renamed over it, so an agy run
 * that starts meanwhile reads the old sign-in or the new one, never half of
 * one. The first time, keep the old file beside it with a .bak ending.
 */
function writeSignInFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const bak = `${path}.bak`;
  if (existsSync(path) && !existsSync(bak)) writeFileSync(bak, readFileSync(path), { mode: 0o600 });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/**
 * Sign T3 Code's Gemini runs in as the account in each agy folder of its
 * profiles: the token file agy reads there, and acp_token.json where there's
 * one, which T3 Code reads first for the limits it shows.
 */
export function writeT3(account: Account, agyDirs: string[]): void {
  const signIn = agySignIn(account);
  for (const dir of agyDirs) {
    writeSignInFile(t3AgyTokenPath(dir), signIn);
    const legacy = t3LegacyTokenPath(dir);
    if (existsSync(legacy)) writeSignInFile(legacy, JSON.stringify(account.acpToken, null, 2));
  }
}

/**
 * Write the account's sign-in where the `agy` CLI reads it: its keychain item
 * on macOS, then its token file. The keychain goes first because it's the
 * write that can fail, and then nothing was changed.
 */
export function writeAgy(account: Account, saved: Account[]): void {
  const signIn = agySignIn(account);
  if (process.platform === "darwin") {
    const { service, account: user } = AGY_KEYCHAIN;
    try {
      // Keep the first sign-in this replaces that isn't a saved account, such as
      // the CLI's own login, like writeSignInFile does for files. A saved one can
      // be switched back to.
      const replaced = readKeychain(service, user);
      const holder = replaced === null ? undefined : decodeAgySignIn(replaced)?.token?.refresh_token;
      const bak = agyKeychainBackupPath();
      if (replaced !== null && !saved.some((a) => a.acpToken.refresh_token === holder) && !existsSync(bak)) {
        writeFileSync(bak, replaced, { mode: 0o600 });
      }
      writeKeychain(service, user, GO_KEYRING + Buffer.from(signIn).toString("base64"));
    } catch (err) {
      throw new Error(
        `Couldn't write the agy CLI's sign-in to your keychain. Nothing was changed. Details: ${(err as Error).message}`,
      );
    }
  }
  writeSignInFile(agyTokenPath(), signIn);
}

/** Open a URL in the user's default browser. */
export function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  execFile(cmd as string, args as string[], () => {});
}
