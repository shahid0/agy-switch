import { describe, expect, test } from "bun:test";
import { parseKeychainDump } from "../src/keychain.ts";
import {
  accountUserScope,
  parsePluginOAuthToken,
  parseScopedMcpOAuthKey,
  selectPluginOAuthCarryOver,
  userScopeForId,
  type ScopedPluginEntry,
} from "../src/plugin-auth.ts";

const NOW = Date.parse("2026-11-24T12:00:00Z");

const fakeJwt = (payload: Record<string, unknown>) =>
  `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;

const goKeyring = (json: unknown) => `go-keyring-base64:${Buffer.from(JSON.stringify(json)).toString("base64")}`;

const oauthPayload = (tag: string, expiry?: string | null) => ({
  client_id: "client-1",
  client_secret: "secret-1",
  token: {
    access_token: `at-${tag}`,
    token_type: "Bearer",
    refresh_token: `rt-${tag}`,
    ...(expiry !== undefined ? { expiry } : {}),
  },
  token_url: "https://api.example.com/oauth/token",
});

const SCOPE_A = userScopeForId("100000000000000000001");
const SCOPE_B = userScopeForId("100000000000000000002");
const SCOPE_C = userScopeForId("100000000000000000003");
const FIGMA_KEY = "mcp-oauth:figma:https://mcp.figma.com/mcp";
const LINEAR_KEY = "mcp-oauth:linear:https://mcp.linear.app/mcp";

describe("accountUserScope", () => {
  test("computes u + 16 hex chars of sha256(sub) from googleUserId or idToken", () => {
    const scope = userScopeForId("1234567890");
    expect(scope).toMatch(/^u[0-9a-f]{16}$/);
    expect(accountUserScope({ googleUserId: "1234567890" })).toBe(scope);
    expect(accountUserScope({ idToken: fakeJwt({ sub: "1234567890", email: "ana@example.com" }) })).toBe(scope);
  });

  test("prefers googleUserId when both are present, and returns null when neither gives a sub", () => {
    expect(accountUserScope({ googleUserId: "sub-1", idToken: fakeJwt({ sub: "sub-2" }) })).toBe(userScopeForId("sub-1"));
    expect(accountUserScope({})).toBeNull();
    expect(accountUserScope({ idToken: "not-a-jwt" })).toBeNull();
    expect(accountUserScope({ idToken: fakeJwt({ email: "ana@example.com" }) })).toBeNull();
  });
});

describe("parseScopedMcpOAuthKey", () => {
  test("parses scoped mcp-oauth keys and ignores other keys", () => {
    expect(parseScopedMcpOAuthKey(`${SCOPE_A}/${FIGMA_KEY}`)).toEqual({
      scope: SCOPE_A,
      mcpKey: FIGMA_KEY,
      pluginName: "figma",
    });
    expect(parseScopedMcpOAuthKey(`${SCOPE_A}/mcp-oauth:figma`)).toEqual({
      scope: SCOPE_A,
      mcpKey: "mcp-oauth:figma",
      pluginName: "figma",
    });
    expect(parseScopedMcpOAuthKey(`${SCOPE_A}/api-key:figma`)).toBeNull();
    expect(parseScopedMcpOAuthKey(FIGMA_KEY)).toBeNull();
    expect(parseScopedMcpOAuthKey(`badscope/${FIGMA_KEY}`)).toBeNull();
  });
});

describe("parsePluginOAuthToken", () => {
  test("decodes go-keyring base64, raw JSON, hex-encoded JSON, and objects", () => {
    const payload = oauthPayload("ok", "2027-02-22T12:00:00Z");
    const expectedMs = Date.parse("2027-02-22T12:00:00Z");

    expect(parsePluginOAuthToken(goKeyring(payload))).toMatchObject({ hasExpiry: true, expiryMs: expectedMs });
    expect(parsePluginOAuthToken(JSON.stringify(payload))).toMatchObject({ hasExpiry: true, expiryMs: expectedMs });
    expect(parsePluginOAuthToken(Buffer.from(JSON.stringify(payload)).toString("hex"))).toMatchObject({
      hasExpiry: true,
      expiryMs: expectedMs,
    });
    expect(parsePluginOAuthToken(payload)).toMatchObject({ hasExpiry: true, expiryMs: expectedMs });
  });

  test("treats omitted or Go zero-time expiry as valid non-expiring, and rejects broken payloads", () => {
    expect(parsePluginOAuthToken(oauthPayload("no-exp"))).toMatchObject({ hasExpiry: false, expiryMs: null });
    expect(parsePluginOAuthToken(oauthPayload("go-zero", "0001-01-01T00:00:00Z"))).toMatchObject({
      hasExpiry: false,
      expiryMs: null,
    });

    expect(parsePluginOAuthToken("")).toBeNull();
    expect(parsePluginOAuthToken("{bad json")).toBeNull();
    expect(parsePluginOAuthToken({ token: { access_token: "" } })).toBeNull();
    expect(parsePluginOAuthToken({ token: { refresh_token: "rt-only" } })).toBeNull();
    expect(parsePluginOAuthToken(oauthPayload("bad-date", "not-a-date"))).toBeNull();
  });
});

describe("selectPluginOAuthCarryOver", () => {
  const entry = (scope: string, mcpKey: string, payload: unknown, modifiedAt: number | null = null): ScopedPluginEntry => ({
    fullKey: `${scope}/${mcpKey}`,
    rawValue: typeof payload === "string" ? payload : goKeyring(payload),
    modifiedAt,
  });

  test("picks the strictly newest unexpired token and ignores expired or older ones", () => {
    const entries = [
      entry(SCOPE_A, FIGMA_KEY, oauthPayload("expired", "2026-11-24T11:59:59Z")),
      entry(SCOPE_B, FIGMA_KEY, oauthPayload("older-valid", "2027-02-21T12:00:00Z")),
      entry(SCOPE_C, FIGMA_KEY, oauthPayload("newest-valid", "2027-02-22T12:00:00Z")),
    ];
    const target = userScopeForId("target-user");
    const picked = selectPluginOAuthCarryOver(entries, target, NOW);

    expect(picked).toHaveLength(1);
    expect(picked[0]).toMatchObject({
      mcpKey: FIGMA_KEY,
      pluginName: "figma",
      targetFullKey: `${target}/${FIGMA_KEY}`,
      sourceFullKey: `${SCOPE_C}/${FIGMA_KEY}`,
    });
  });

  test("never copies an expired token, even when it expires at the exact current millisecond", () => {
    const entries = [
      entry(SCOPE_A, FIGMA_KEY, oauthPayload("past", "2026-11-01T00:00:00Z")),
      entry(SCOPE_B, FIGMA_KEY, oauthPayload("exact-now", "2026-11-24T12:00:00Z")),
    ];
    expect(selectPluginOAuthCarryOver(entries, SCOPE_C, NOW)).toEqual([]);
  });

  test("never overwrites a newer or equal valid token already on the target", () => {
    const same = oauthPayload("same", "2027-02-22T12:00:00Z");
    const older = oauthPayload("older", "2027-02-21T12:00:00Z");

    expect(selectPluginOAuthCarryOver([entry(SCOPE_A, FIGMA_KEY, older), entry(SCOPE_B, FIGMA_KEY, same)], SCOPE_B, NOW)).toEqual([]);
    expect(selectPluginOAuthCarryOver([entry(SCOPE_A, FIGMA_KEY, same), entry(SCOPE_B, FIGMA_KEY, same)], SCOPE_B, NOW)).toEqual([]);
  });

  test("replaces an older, expired, or corrupt token on the target with a newer valid one", () => {
    const newer = oauthPayload("newer", "2027-02-25T12:00:00Z");
    const older = oauthPayload("older", "2027-02-22T12:00:00Z");
    const expired = oauthPayload("expired", "2026-10-01T00:00:00Z");

    expect(selectPluginOAuthCarryOver([entry(SCOPE_A, FIGMA_KEY, newer), entry(SCOPE_B, FIGMA_KEY, older)], SCOPE_B, NOW)).toHaveLength(1);
    expect(selectPluginOAuthCarryOver([entry(SCOPE_A, FIGMA_KEY, newer), entry(SCOPE_B, FIGMA_KEY, expired)], SCOPE_B, NOW)).toHaveLength(1);
    expect(selectPluginOAuthCarryOver([entry(SCOPE_A, FIGMA_KEY, newer), entry(SCOPE_B, FIGMA_KEY, "{corrupt")], SCOPE_B, NOW)).toHaveLength(1);
  });

  test("breaks equal-expiry ties with modification time when payload differs", () => {
    const exp = "2027-02-22T12:00:00Z";
    const entries = [
      entry(SCOPE_A, FIGMA_KEY, oauthPayload("old-write", exp), 1000),
      entry(SCOPE_B, FIGMA_KEY, oauthPayload("new-write", exp), 2000),
    ];
    const picked = selectPluginOAuthCarryOver(entries, SCOPE_A, NOW);
    expect(picked).toHaveLength(1);
    expect(picked[0].sourceFullKey).toBe(`${SCOPE_B}/${FIGMA_KEY}`);
  });

  test("prefers a valid expiring token over a non-expiring stub, and carries non-expiring tokens when target has none", () => {
    const expiring = oauthPayload("exp", "2027-02-22T12:00:00Z");
    const noExp = oauthPayload("no-exp");

    // Non-expiring never overwrites a valid expiring target.
    expect(selectPluginOAuthCarryOver([entry(SCOPE_A, FIGMA_KEY, noExp), entry(SCOPE_B, FIGMA_KEY, expiring)], SCOPE_B, NOW)).toEqual([]);
    // Valid expiring replaces a non-expiring target.
    expect(selectPluginOAuthCarryOver([entry(SCOPE_A, FIGMA_KEY, expiring), entry(SCOPE_B, FIGMA_KEY, noExp)], SCOPE_B, NOW)).toHaveLength(1);
    // Non-expiring is carried when target has nothing.
    expect(selectPluginOAuthCarryOver([entry(SCOPE_A, FIGMA_KEY, noExp)], SCOPE_B, NOW)).toHaveLength(1);
  });

  test("handles multiple MCP servers independently and skips non-mcp-oauth entries", () => {
    const entries = [
      entry(SCOPE_A, FIGMA_KEY, oauthPayload("figma-new", "2027-02-22T12:00:00Z")),
      entry(SCOPE_B, LINEAR_KEY, oauthPayload("linear-new", "2027-01-15T12:00:00Z")),
      entry(SCOPE_C, LINEAR_KEY, oauthPayload("linear-newer", "2027-03-01T12:00:00Z")),
      { fullKey: `${SCOPE_A}/other-secret`, rawValue: goKeyring(oauthPayload("ignored", "2028-01-01T00:00:00Z")), modifiedAt: null },
    ];
    const picked = selectPluginOAuthCarryOver(entries, SCOPE_C, NOW);
    // Target SCOPE_C already has the newest linear token, so only figma is carried.
    expect(picked.map((p) => [p.pluginName, p.sourceFullKey])).toEqual([["figma", `${SCOPE_A}/${FIGMA_KEY}`]]);
  });
});

describe("parseKeychainDump", () => {
  test("extracts matching service genp items with plain or hex accounts and modification dates", () => {
    const hexAcct = Buffer.from(`${SCOPE_B}/mcp-oauth:figma:https://mcp.figma.com/mcp`).toString("hex").toUpperCase();
    const dump = `keychain: "/tmp/login.keychain-db"
version: 512
class: "genp"
attributes:
    "acct"<blob>="${SCOPE_A}/${FIGMA_KEY}"
    "mdat"<timedate>=0x32303236313132343037333630315A00  "20261124073601Z\\000"
    "svce"<blob>="antigravity.plugins"
keychain: "/tmp/login.keychain-db"
version: 512
class: "genp"
attributes:
    "acct"<blob>=0x${hexAcct}  "ignored"
    "mdat"<timedate>=0x32303236313132333131353631395A00  "20261123115619Z\\000"
    "svce"<blob>="antigravity.plugins"
keychain: "/tmp/login.keychain-db"
version: 512
class: "genp"
attributes:
    "acct"<blob>="antigravity"
    "svce"<blob>="gemini"
keychain: "/tmp/login.keychain-db"
version: 512
class: "inet"
attributes:
    "acct"<blob>="${SCOPE_C}/${FIGMA_KEY}"
    "svce"<blob>="antigravity.plugins"
`;
    expect(parseKeychainDump(dump, "antigravity.plugins")).toEqual([
      { account: `${SCOPE_A}/${FIGMA_KEY}`, modifiedAt: Date.UTC(2026, 10, 24, 7, 36, 1) },
      { account: `${SCOPE_B}/${FIGMA_KEY}`, modifiedAt: Date.UTC(2026, 10, 23, 11, 56, 19) },
    ]);
  });
});
