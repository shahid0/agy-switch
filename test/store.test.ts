import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canRunAgents,
  markUsed,
  missingScopes,
  readAccounts,
  removeAccount,
  saveQuota,
  scopeLabel,
  upsertAccount,
  type Account,
} from "../src/store.ts";
import { activeAccounts, findAcpTokenPaths } from "../src/write.ts";

// Paths resolve on access, so pointing HOME at a temp dir sandboxes every test.
const HOME = mkdtempSync(join(tmpdir(), "agy-switch-store-"));

const SCOPES = [
  "https://www.googleapis.com/auth/aicode",
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
];

const base = (over: Partial<Account> = {}): Account => ({
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
  grantedScopes: SCOPES,
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
    expect(readAccounts()).toEqual([]);
  });

  test("survives a corrupt store file instead of throwing", () => {
    mkdirSync(join(HOME, ".agy-switch"), { recursive: true });
    writeFileSync(join(HOME, ".agy-switch", "accounts.json"), "{not json");
    expect(readAccounts()).toEqual([]);
  });

  test("upsert adds, then replaces by email without duplicating", () => {
    upsertAccount(base({ email: "dup@example.com" }));
    const { replaced } = upsertAccount(base({ email: "DUP@example.com", name: "Renamed" }));
    expect(replaced).toBe(true);
    const all = readAccounts();
    expect(all.filter((a) => a.email.toLowerCase() === "dup@example.com")).toHaveLength(1);
    expect(all[0].name).toBe("Renamed");
  });

  test("upsert preserves id and addedAt on replace", () => {
    const first = upsertAccount(base({ email: "keep@example.com" })).account;
    const second = upsertAccount(base({ email: "keep@example.com" })).account;
    expect(second.id).toBe(first.id);
    expect(second.addedAt).toBe(first.addedAt);
  });

  test("an account saved without a name reads back with its email as the name", () => {
    upsertAccount(base({ email: "noname@example.com", name: "" }));
    expect(readAccounts()[0].name).toBe("noname@example.com");
  });

  test("writes the store 0600", () => {
    upsertAccount(base());
    const mode = statSync(join(HOME, ".agy-switch", "accounts.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("leaves no temp file behind after a write", () => {
    upsertAccount(base());
    expect(readdirSync(join(HOME, ".agy-switch")).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  test("saveQuota records every snapshot in one pass and skips unknown ids", () => {
    const a = upsertAccount(base({ email: "q1@example.com" })).account;
    const b = upsertAccount(base({ email: "q2@example.com" })).account;
    const bucket = { name: "3p-5h", percentage: 40, reset_time: "", group: "Claude and GPT models", window: "5h" };
    saveQuota(new Map([[a.id, [bucket]], ["nobody", [bucket]]]), "2026-01-01T00:00:00.000Z");
    const [savedA, savedB] = readAccounts();
    expect(savedA.quota?.models).toEqual([bucket]);
    expect(savedA.quotaCheckedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(savedB.id).toBe(b.id);
    expect(savedB.quota).toBeNull();
  });
});

describe("can run agents", () => {
  test("an account with all required scopes can run agents", () => {
    expect(canRunAgents(base())).toBe(true);
    expect(missingScopes(base())).toEqual([]);
  });

  test("a missing aicode grant means it can't, and names the gap", () => {
    const a = base({ grantedScopes: ["https://www.googleapis.com/auth/userinfo.email"] });
    expect(canRunAgents(a)).toBe(false);
    expect(missingScopes(a).map(scopeLabel)).toContain("aicode");
  });

  test("an account with no grantedScopes can't, rather than crashing", () => {
    const a = base({ grantedScopes: undefined as unknown as string[] });
    expect(canRunAgents(a)).toBe(false);
    expect(missingScopes(a)).toHaveLength(3);
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
    expect(canRunAgents(a)).toBe(false);
  });
});

describe("remove and markUsed", () => {
  test("removes by id", () => {
    const { account } = upsertAccount(base({ email: "gone@example.com" }));
    expect(removeAccount(account.id)?.email).toBe("gone@example.com");
    expect(readAccounts()).toHaveLength(0);
  });

  test("returns null for an unknown id", () => {
    expect(removeAccount("no-such-id")).toBeNull();
  });

  test("markUsed stamps lastUsedAt only for a known id", () => {
    const { account } = upsertAccount(base({ email: "used@example.com" }));
    markUsed(account.id);
    const before = readAccounts()[0].lastUsedAt;
    expect(before).toBeTruthy();
    markUsed("no-such-id");
    expect(readAccounts()[0].lastUsedAt).toBe(before);
  });
});

describe("write targets", () => {
  test("does not invent T3 or agy files that are not there", () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "agy-targets-"));
    expect(findAcpTokenPaths()).toEqual([]);
    expect(activeAccounts([base()])).toEqual({ t3: null, agy: null });
  });

  test("activeAccounts names the saved account each app holds, and null for one it doesn't know", () => {
    const home = mkdtempSync(join(tmpdir(), "agy-active-"));
    process.env.HOME = home;
    const acp = join(home, ".t3/userdata/providers/antigravity/i1/antigravity-acp");
    mkdirSync(acp, { recursive: true });
    writeFileSync(join(acp, "acp_token.json"), JSON.stringify({ refresh_token: "rt" }));
    const agy = join(home, ".gemini/antigravity-cli");
    mkdirSync(agy, { recursive: true });
    writeFileSync(join(agy, "antigravity-oauth-token"), JSON.stringify({ token: { refresh_token: "someone-else" } }));
    expect(activeAccounts([base({ email: "m@example.com" })])).toEqual({ t3: "m@example.com", agy: null });
  });
});
