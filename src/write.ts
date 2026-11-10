import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agyTokenPath, t3AcpRoot } from "./paths.ts";
import type { Account } from "./store.ts";

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

/**
 * Which saved account T3 Code and the agy CLI use now, matched by refresh
 * token. null means no file, or a credential that isn't a saved account.
 */
export function activeAccounts(accounts: Account[]): { t3: string | null; agy: string | null } {
  const owner = (token: string | undefined) =>
    (token && accounts.find((a) => a.acpToken.refresh_token === token)?.email) || null;
  const t3 =
    findAcpTokenPaths()
      .map((path) => owner(readJson<{ refresh_token?: string }>(path)?.refresh_token))
      .find(Boolean) ?? null;
  const agy = owner(readJson<{ token?: { refresh_token?: string } }>(agyTokenPath())?.token?.refresh_token);
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

/** Write the account's credential to the `agy` CLI token file. */
export function writeAgy(account: Account): void {
  const path = agyTokenPath();
  backupOnce(path);
  mkdirSync(dirname(path), { recursive: true });

  const existing = readJson<Record<string, unknown>>(path) ?? {};

  writeFileSync(
    path,
    JSON.stringify(
      {
        ...existing,
        token: {
          access_token: account.accessToken ?? "",
          token_type: "Bearer",
          refresh_token: account.acpToken.refresh_token,
          expiry: new Date(account.expiresAt ?? Date.now()).toISOString().replace("Z", "000Z"),
        },
        auth_method: (existing.auth_method as string) ?? "consumer",
        id_token: account.idToken ?? existing.id_token,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
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
