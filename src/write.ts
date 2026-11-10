import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { agyTokenPath, t3AcpRoot } from "./paths.ts";
import type { Account } from "./store.ts";
import { existsSync as exists, readdirSync } from "node:fs";
import { join } from "node:path";

/** Every T3 ACP provider token file on this machine. */
export function findAcpTokenPaths(): string[] {
  const root = t3AcpRoot();
  if (!exists(root)) return [];
  const out: string[] = [];
  for (const instance of readdirSync(root)) {
    const path = join(root, instance, "antigravity-acp", "acp_token.json");
    if (exists(path)) out.push(path);
  }
  return out;
}

function backupOnce(path: string) {
  if (!existsSync(path)) return;
  const bak = `${path}.bak`;
  if (!existsSync(bak)) writeFileSync(bak, readFileSync(path), { mode: 0o600 });
}

/** Write the account's credential to T3's ACP provider. */
export function writeAcp(account: Account): string[] {
  const written: string[] = [];
  for (const path of findAcpTokenPaths()) {
    backupOnce(path);
    writeFileSync(path, JSON.stringify(account.acpToken, null, 2), { mode: 0o600 });
    chmodSync(path, 0o600);
    written.push(path);
  }
  return written;
}

/** Write the account's credential to the `agy` CLI token file. */
export function writeAgy(account: Account): string {
  const path = agyTokenPath();
  backupOnce(path);
  mkdirSync(dirname(path), { recursive: true });

  const existing = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)
    : {};

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
  return path;
}

/**
 * Resolve which stored account matches a credential file, by refresh token.
 * Google rotates refresh tokens, so a byte comparison can miss; callers that
 * need certainty should compare emails instead.
 */
export function matchByRefreshToken(
  accounts: Account[],
  refreshToken: string | undefined,
): Account | null {
  if (!refreshToken) return null;
  return accounts.find((a) => a.acpToken.refresh_token === refreshToken) ?? null;
}

export function readAcpTokenFile(path: string): { refresh_token?: string; project_id?: string } | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
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
