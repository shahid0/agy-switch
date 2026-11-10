import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { storeDir, storePath } from "./paths.ts";

/** Scopes an Antigravity agent needs. `aicode` is the entitlement; without it
 *  the ACP harness refuses the credential with `invalid_scope`. */
export const REQUIRED_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/aicode",
] as const;

export type Account = {
  id: string;
  email: string;
  name: string;
  /** Credential handed to the ACP harness, verbatim. */
  acpToken: {
    client_id: string;
    client_secret: string;
    refresh_token: string;
    token_uri: string;
    scopes: string[];
    project_id?: string;
  };
  /** Fresh access token + identity, for `agy` CLI writes and labelling. */
  accessToken?: string;
  idToken?: string;
  expiresAt?: number;
  /** Scopes Google actually granted. Authoritative; the token file's list is not. */
  grantedScopes: string[];
  subscription?: { id: string; name: string } | null;
  quota?: {
    models?: Array<{ name: string; percentage: number; reset_time: string }>;
    subscription_tier?: string;
    is_forbidden?: boolean;
  } | null;
  quotaCheckedAt?: string | null;
  disabled?: boolean;
  addedAt: string;
  lastUsedAt: string | null;
};

type StoreFile = {
  version: 1;
  accounts: Account[];
};

const EMPTY: StoreFile = { version: 1, accounts: [] };

export function readStore(): StoreFile {
  const path = storePath();
  if (!existsSync(path)) return { ...EMPTY, accounts: [] };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<StoreFile>;
    if (!Array.isArray(raw.accounts)) return { ...EMPTY, accounts: [] };
    return { version: 1, accounts: raw.accounts.filter((a) => a?.email && a?.acpToken) };
  } catch {
    return { ...EMPTY, accounts: [] };
  }
}

/** Atomic write: a crash mid-write must not leave a half-read store. */
export function writeStore(store: StoreFile): void {
  const dir = storeDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = storePath();
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function readAccounts(): Account[] {
  return readStore().accounts;
}

/** Insert or refresh an account, matched case-insensitively by email. */
export function upsertAccount(account: Account): { account: Account; replaced: boolean } {
  const store = readStore();
  const key = account.email.toLowerCase();
  const index = store.accounts.findIndex((a) => a.email.toLowerCase() === key);
  if (index >= 0) {
    const existing = store.accounts[index];
    const merged: Account = {
      ...existing,
      ...account,
      id: existing.id,
      addedAt: existing.addedAt,
      lastUsedAt: existing.lastUsedAt ?? account.lastUsedAt,
    };
    store.accounts[index] = merged;
    writeStore(store);
    return { account: merged, replaced: true };
  }
  store.accounts.push(account);
  writeStore(store);
  return { account, replaced: false };
}

export function markUsed(id: string): void {
  const store = readStore();
  const account = store.accounts.find((a) => a.id === id);
  if (!account) return;
  account.lastUsedAt = new Date().toISOString();
  writeStore(store);
}

export function removeAccount(ref: string): Account | null {
  const store = readStore();
  const index = store.accounts.findIndex(
    (a) =>
      a.id === ref ||
      a.email.toLowerCase() === ref.toLowerCase() ||
      (a.name ?? "").toLowerCase() === ref.toLowerCase(),
  );
  if (index < 0) return null;
  const [removed] = store.accounts.splice(index, 1);
  writeStore(store);
  return removed;
}

/** Missing scopes for this account. Empty array means ACP-eligible. */
export function missingScopes(account: Account): string[] {
  const granted = new Set(account.grantedScopes ?? []);
  return REQUIRED_SCOPES.filter((s) => !granted.has(s));
}

export function isAcpEligible(account: Account): boolean {
  return missingScopes(account).length === 0;
}

/** Short scope label for display, e.g. "aicode". */
export function scopeLabel(scope: string): string {
  return scope.split("/").pop() ?? scope;
}
