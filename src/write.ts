import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readKeychain, writeKeychain } from "./keychain.ts";
import { AGY_KEYCHAIN, agyKeychainBackupPath, agyTokenPath, t3AcpRoot } from "./paths.ts";
import type { Account } from "./store.ts";

/** go-keyring, which the agy CLI keeps its keychain sign-in with, stores a secret as base64 behind this. */
const GO_KEYRING = "go-keyring-base64:";

/** The agy CLI's sign-in, the same JSON in its keychain item and its token file. */
type AgySignIn = { token?: { refresh_token?: string } };

/** Every T3 ACP provider token file on this machine. */
export function findAcpTokenPaths(): string[] {
  const root = t3AcpRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((instance) => join(root, instance, "antigravity-acp", "acp_token.json"))
    .filter((path) => existsSync(path));
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** The agy CLI's keychain sign-in, or null when there's none or the keychain can't be read. */
function readAgyKeychain(): AgySignIn | null {
  if (process.platform !== "darwin") return null;
  try {
    const value = readKeychain(AGY_KEYCHAIN.service, AGY_KEYCHAIN.account);
    if (value === null) return null;
    const json = value.startsWith(GO_KEYRING) ? Buffer.from(value.slice(GO_KEYRING.length), "base64").toString("utf8") : value;
    return JSON.parse(json) as AgySignIn;
  } catch {
    // The agy CLI falls back to its file when it can't read the keychain, and so does this.
    return null;
  }
}

/**
 * Which saved account T3 Code and the agy CLI use now, matched by refresh
 * token. null means no sign-in, or one that isn't a saved account.
 */
export function activeAccounts(accounts: Account[]): { t3: string | null; agy: string | null } {
  const owner = (token: string | undefined) =>
    (token && accounts.find((a) => a.acpToken.refresh_token === token)?.email) || null;
  const t3 =
    findAcpTokenPaths()
      .map((path) => owner(readJson<{ refresh_token?: string }>(path)?.refresh_token))
      .find(Boolean) ?? null;
  // The order the agy CLI reads them in: its keychain item, then its file.
  const agy = owner(readAgyKeychain()?.token?.refresh_token ?? readJson<AgySignIn>(agyTokenPath())?.token?.refresh_token);
  return { t3, agy };
}

function backupOnce(path: string) {
  if (!existsSync(path)) return;
  const bak = `${path}.bak`;
  if (!existsSync(bak)) writeFileSync(bak, readFileSync(path), { mode: 0o600 });
}

/** Write the account's credential to T3's ACP provider token files. */
export function writeAcp(account: Account, paths: string[]): void {
  for (const path of paths) {
    backupOnce(path);
    writeFileSync(path, JSON.stringify(account.acpToken, null, 2), { mode: 0o600 });
    chmodSync(path, 0o600);
  }
}

/**
 * Write the account's sign-in where the `agy` CLI reads it, in the CLI's own
 * format: its keychain item on macOS, then its token file. The keychain goes
 * first because it's the write that can fail, and then nothing was changed.
 */
export function writeAgy(account: Account): void {
  const signIn = JSON.stringify({
    token: {
      access_token: account.accessToken ?? "",
      token_type: "Bearer",
      refresh_token: account.acpToken.refresh_token,
      expiry: new Date(account.expiresAt ?? Date.now()).toISOString(),
    },
    auth_method: "consumer",
    id_token_email: account.email,
  });

  if (process.platform === "darwin") {
    const { service, account: user } = AGY_KEYCHAIN;
    try {
      // Keep the first sign-in this replaces, like backupOnce does for files.
      const replaced = readKeychain(service, user);
      const bak = agyKeychainBackupPath();
      if (replaced !== null && !existsSync(bak)) writeFileSync(bak, replaced, { mode: 0o600 });
      writeKeychain(service, user, GO_KEYRING + Buffer.from(signIn).toString("base64"));
    } catch (err) {
      throw new Error(
        `Couldn't write the agy CLI's sign-in to your keychain. Nothing was changed. Details: ${(err as Error).message}`,
      );
    }
  }

  const path = agyTokenPath();
  backupOnce(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, signIn, { mode: 0o600 });
  chmodSync(path, 0o600);
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
