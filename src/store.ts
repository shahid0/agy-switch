import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { storeDir, storePath } from "./paths.ts";

/** Scopes an Antigravity agent needs. `aicode` is the entitlement; without it
 *  the ACP harness refuses the credential with `invalid_scope`. */
export const REQUIRED_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/aicode",
] as const;

/** One quota limit, e.g. the 5-hour window on Claude and GPT models. */
export type QuotaBucket = {
  name: string;
  percentage: number;
  reset_time: string;
  /** Google's name for the models sharing this limit. */
  group?: string;
  /** "5h" or "weekly". */
  window?: string;
};

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
  quota?: { models: QuotaBucket[] } | null;
  quotaCheckedAt?: string | null;
  /** When image generation ran out, from `ran-out`: Google doesn't report it. */
  imageLimit?: { resetsAt: string; recordedAt: string } | null;
  addedAt: string;
  lastUsedAt: string | null;
};

type StoreFile = {
  version: 1;
  accounts: Account[];
};

export function readStore(): StoreFile {
  const path = storePath();
  if (!existsSync(path)) return { version: 1, accounts: [] };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<StoreFile>;
    if (!Array.isArray(raw.accounts)) return { version: 1, accounts: [] };
    return {
      version: 1,
      accounts: raw.accounts
        .filter((a) => a?.email && a?.acpToken)
        .map((a) => ({ ...a, name: a.name || a.email })),
    };
  } catch {
    return { version: 1, accounts: [] };
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

/** Record fresh quota for several accounts in one write, keyed by account id. */
export function saveQuota(snapshots: Map<string, QuotaBucket[]>, checkedAt: string): void {
  const store = readStore();
  for (const account of store.accounts) {
    const buckets = snapshots.get(account.id);
    if (!buckets) continue;
    account.quota = { models: buckets };
    account.quotaCheckedAt = checkedAt;
  }
  writeStore(store);
}

export function markUsed(id: string): void {
  const store = readStore();
  const account = store.accounts.find((a) => a.id === id);
  if (!account) return;
  account.lastUsedAt = new Date().toISOString();
  writeStore(store);
}

export function recordImageLimit(id: string, resetsAt: string): void {
  const store = readStore();
  const account = store.accounts.find((a) => a.id === id);
  if (!account) return;
  account.imageLimit = { resetsAt, recordedAt: new Date().toISOString() };
  writeStore(store);
}

export function removeAccount(id: string): Account | null {
  const store = readStore();
  const index = store.accounts.findIndex((a) => a.id === id);
  if (index < 0) return null;
  const [removed] = store.accounts.splice(index, 1);
  writeStore(store);
  return removed;
}

/** Missing scopes for this account. Empty array means it can run agents. */
export function missingScopes(account: Account): string[] {
  const granted = new Set(account.grantedScopes ?? []);
  return REQUIRED_SCOPES.filter((s) => !granted.has(s));
}

export function canRunAgents(account: Account): boolean {
  return missingScopes(account).length === 0;
}

/** Short scope label for display, e.g. "aicode". */
export function scopeLabel(scope: string): string {
  return scope.split("/").pop() ?? scope;
}
