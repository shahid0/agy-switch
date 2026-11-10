import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate HOME before importing anything that reads paths.
process.env.HOME = mkdtempSync(join(tmpdir(), "agy-switch-store-"));
const HOME = process.env.HOME;

const store = await import(`../src/store.ts?t=${Date.now()}`);

const base = (over: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(),
  email: "a@example.com",
  name: "A",
  acpToken: {
    client_id: "cid",
    client_secret: "secret",
    refresh_token: "rt",
    token_uri: "https://oauth2.googleapis.com/token",
    scopes: [],
  },
  grantedScopes: [
    "https://www.googleapis.com/auth/aicode",
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
  ],
  subscription: null,
  quota: null,
  quotaCheckedAt: null,
  addedAt: new Date().toISOString(),
  lastUsedAt: null,
  ...over,
});

beforeEach(() => {
  process.env.HOME = HOME;
  const p = join(HOME, ".agy-switch", "accounts.json");
  if (existsSync(p)) writeFileSync(p, JSON.stringify({ version: 1, accounts: [] }));
});

describe("store", () => {
  test("returns an empty store when nothing exists", () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "agy-empty-"));
    expect(store.readAccounts()).toEqual([]);
  });

  test("survives a corrupt store file instead of throwing", () => {
    mkdirSync(join(HOME, ".agy-switch"), { recursive: true });
    writeFileSync(join(HOME, ".agy-switch", "accounts.json"), "{not json");
    expect(store.readAccounts()).toEqual([]);
  });

  test("upsert adds, then replaces by email without duplicating", () => {
    store.upsertAccount(base({ email: "dup@example.com" }) as any);
    const { replaced } = store.upsertAccount(
      base({ email: "DUP@example.com", name: "Renamed" }) as any,
    );
    expect(replaced).toBe(true);
    const all = store.readAccounts();
    expect(all.filter((a: any) => a.email.toLowerCase() === "dup@example.com")).toHaveLength(1);
    expect(all[0].name).toBe("Renamed");
  });

  test("upsert preserves id and addedAt on replace", () => {
    const first = store.upsertAccount(base({ email: "keep@example.com" }) as any).account;
    const second = store.upsertAccount(base({ email: "keep@example.com" }) as any).account;
    expect(second.id).toBe(first.id);
    expect(second.addedAt).toBe(first.addedAt);
  });

  test("writes the store 0600", () => {
    store.upsertAccount(base() as any);
    const { statSync } = require("node:fs");
    const mode = statSync(join(HOME, ".agy-switch", "accounts.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("leaves no temp file behind after a write", () => {
    store.upsertAccount(base() as any);
    const dir = join(HOME, ".agy-switch");
    expect(require("node:fs").readdirSync(dir).filter((f: string) => f.includes(".tmp-"))).toEqual([]);
  });
});

describe("eligibility", () => {
  test("an account with all required scopes is eligible", () => {
    const a = base();
    expect(store.isAcpEligible(a as any)).toBe(true);
    expect(store.missingScopes(a as any)).toEqual([]);
  });

  test("a missing aicode grant makes it ineligible and names the gap", () => {
    const a = base({ grantedScopes: ["https://www.googleapis.com/auth/userinfo.email"] });
    expect(store.isAcpEligible(a as any)).toBe(false);
    const missing = store.missingScopes(a as any).map(store.scopeLabel);
    expect(missing).toContain("aicode");
  });

  test("an account with no grantedScopes is ineligible, not a crash", () => {
    const a = base({ grantedScopes: undefined });
    expect(store.isAcpEligible(a as any)).toBe(false);
    expect(store.missingScopes(a as any)).toHaveLength(3);
  });

  test("scopes are matched exactly, not by substring", () => {
    const a = base({
      grantedScopes: [
        "https://www.googleapis.com/auth/cloud-platform",
        "https://www.googleapis.com/auth/userinfo.email",
        // a lookalike must not satisfy the real requirement
        "https://www.googleapis.com/auth/aicode.evil",
      ],
    });
    expect(store.isAcpEligible(a as any)).toBe(false);
  });
});

describe("remove and markUsed", () => {
  test("removes by email, case-insensitively", () => {
    store.upsertAccount(base({ email: "gone@example.com" }) as any);
    const removed = store.removeAccount("GONE@example.com");
    expect(removed?.email).toBe("gone@example.com");
    expect(store.readAccounts()).toHaveLength(0);
  });

  test("returns null for an unknown account", () => {
    expect(store.removeAccount("nobody@example.com")).toBeNull();
  });

  test("markUsed stamps lastUsedAt only for a known id", () => {
    const { account } = store.upsertAccount(base({ email: "used@example.com" }) as any);
    store.markUsed(account.id);
    const after = store.readAccounts()[0];
    expect(after.lastUsedAt).toBeTruthy();

    const before = store.readAccounts()[0].lastUsedAt;
    store.markUsed("no-such-id");
    expect(store.readAccounts()[0].lastUsedAt).toBe(before);
  });
});

describe("write targets", () => {
  test("does not invent T3 or agy files that are not there", async () => {
    const empty = mkdtempSync(join(tmpdir(), "agy-targets-"));
    process.env.HOME = empty;
    const w = await import(`../src/write.ts?t=${Date.now()}`);
    expect(w.findAcpTokenPaths()).toEqual([]);
  });

  test("matchByRefreshToken returns null rather than guessing", async () => {
    const w = await import(`../src/write.ts?t=${Date.now()}`);
    const acct = base({ email: "m@example.com" }) as any;
    expect(w.matchByRefreshToken([acct], "different")).toBeNull();
    expect(w.matchByRefreshToken([acct], undefined)).toBeNull();
    expect(w.matchByRefreshToken([acct], "rt")?.email).toBe("m@example.com");
  });
});
