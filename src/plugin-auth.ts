import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { listKeychainItems, readKeychain, writeKeychain } from "./keychain.ts";
import { antigravityConfigDir, credentialUserScopePath, PLUGIN_KEYCHAIN_SERVICE, pluginSecretsPath } from "./paths.ts";
import type { Account } from "./store.ts";

/** go-keyring prefix used by `agy` for macOS keychain secrets. */
const GO_KEYRING = "go-keyring-base64:";

/** Matches `<userScope>/mcp-oauth:<plugin>[:<url>]` in `antigravity.plugins`. */
const SCOPED_MCP_OAUTH = /^(u[0-9a-f]{16})\/(mcp-oauth:([^:/]+)(?::.+)?)$/;

/** Go's zero `time.Time` serializes as year 1; treat it as no expiry. */
const GO_ZERO_TIME = /^0001-01-01T00:00:00(?:\.0+)?(?:Z|[+-]00:00)$/;

export type ScopedMcpOAuthKey = {
  scope: string;
  mcpKey: string;
  pluginName: string;
};

export type ParsedOAuthToken = {
  hasExpiry: boolean;
  expiryMs: number | null;
  canonicalJson: string;
};

export type ScopedPluginEntry = {
  fullKey: string;
  rawValue: unknown;
  modifiedAt: number | null;
};

export type CarryOverSelection = {
  mcpKey: string;
  pluginName: string;
  targetFullKey: string;
  sourceFullKey: string;
  rawValue: unknown;
  canonicalJson: string;
};

export type CarryPluginOAuthResult = {
  carried: string[];
  warning?: string;
};

/** Antigravity's credential scope for a Google subject ID: `u` + first 16 hex chars of SHA-256(sub). */
export function userScopeForId(userId: string): string {
  return `u${createHash("sha256").update(userId).digest("hex").slice(0, 16)}`;
}

/** Extract the Google subject ID (`sub`) from a JWT without verifying signature. */
function subFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  const parts = idToken.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { sub?: unknown };
    return typeof payload.sub === "string" && payload.sub.length > 0 ? payload.sub : null;
  } catch {
    return null;
  }
}

/** The `u<16-hex>` credential scope Antigravity uses for this saved account, or null when unknown. */
export function accountUserScope(account: Pick<Account, "googleUserId" | "idToken">): string | null {
  const userId = account.googleUserId?.trim() || subFromIdToken(account.idToken);
  return userId ? userScopeForId(userId) : null;
}

/** Parse `<scope>/mcp-oauth:<plugin>:<serverUrl>`, returning null for non-MCP-OAuth or unscoped keys. */
export function parseScopedMcpOAuthKey(fullKey: string): ScopedMcpOAuthKey | null {
  const match = SCOPED_MCP_OAUTH.exec(fullKey);
  if (!match) return null;
  return { scope: match[1], mcpKey: match[2], pluginName: match[3] };
}

/** Decode a keychain secret string (go-keyring base64, plain JSON, or security hex dump) into a JSON string. */
function decodeRawJsonText(raw: unknown): string | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return JSON.stringify(raw);
  }
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith(GO_KEYRING)) {
    try {
      return Buffer.from(trimmed.slice(GO_KEYRING.length), "base64").toString("utf8");
    } catch {
      return null;
    }
  }
  if (trimmed.startsWith("{")) return trimmed;
  // `security find-generic-password -w` prints hex when a secret has newlines or non-ASCII bytes.
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
    const decoded = Buffer.from(trimmed, "hex").toString("utf8").trim();
    if (decoded.startsWith("{")) return decoded;
  }
  return null;
}

/**
 * Parse and validate an Antigravity plugin MCP OAuth payload.
 * Returns null if malformed, missing an access_token, or carrying an unparseable expiry.
 */
export function parsePluginOAuthToken(raw: unknown): ParsedOAuthToken | null {
  const text = decodeRawJsonText(raw);
  if (!text) return null;
  let obj: { token?: { access_token?: unknown; expiry?: unknown } };
  try {
    obj = JSON.parse(text) as typeof obj;
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const token = obj.token;
  if (!token || typeof token !== "object" || typeof token.access_token !== "string" || token.access_token.trim() === "") {
    return null;
  }

  const expiry = token.expiry;
  if (expiry === undefined || expiry === null || expiry === "" || (typeof expiry === "string" && GO_ZERO_TIME.test(expiry))) {
    return { hasExpiry: false, expiryMs: null, canonicalJson: JSON.stringify(obj) };
  }
  if (typeof expiry !== "string") return null;
  const expiryMs = Date.parse(expiry);
  if (!Number.isFinite(expiryMs)) return null;
  return { hasExpiry: true, expiryMs, canonicalJson: JSON.stringify(obj) };
}

type RankedCandidate = {
  entry: ScopedPluginEntry;
  parsed: ParsedOAuthToken;
  key: ScopedMcpOAuthKey;
};

function isExpired(parsed: ParsedOAuthToken, now: number): boolean {
  return parsed.hasExpiry && (parsed.expiryMs as number) <= now;
}

/**
 * Compare two valid, unexpired candidates. Positive means `a` is strictly newer than `b`.
 * Real future expiries beat non-expiring stubs; among expiring tokens, a later expiry wins,
 * with keychain modification time as tiebreaker.
 */
function compareFreshness(a: RankedCandidate, b: RankedCandidate): number {
  if (a.parsed.hasExpiry !== b.parsed.hasExpiry) return a.parsed.hasExpiry ? 1 : -1;
  if (a.parsed.hasExpiry && b.parsed.hasExpiry) {
    const diff = (a.parsed.expiryMs as number) - (b.parsed.expiryMs as number);
    if (diff !== 0) return diff;
  }
  if (a.parsed.canonicalJson === b.parsed.canonicalJson) return 0;
  return (a.entry.modifiedAt ?? 0) - (b.entry.modifiedAt ?? 0);
}

/**
 * For each remote MCP plugin present across any scope, decide whether a fresher,
 * unexpired token should be carried over to `targetScope`.
 *
 * Guarantees:
 * - Expired or malformed tokens are never copied.
 * - A newer valid token already on `targetScope` is never overwritten by an older one.
 * - When another scope has a strictly newer valid token (e.g. after refresh-token rotation),
 *   it replaces an older or missing token on `targetScope`.
 */
export function selectPluginOAuthCarryOver(
  entries: ScopedPluginEntry[],
  targetScope: string,
  now = Date.now(),
): CarryOverSelection[] {
  const byMcpKey = new Map<string, { target: ScopedPluginEntry | null; others: RankedCandidate[] }>();

  for (const entry of entries) {
    const key = parseScopedMcpOAuthKey(entry.fullKey);
    if (!key) continue;
    let group = byMcpKey.get(key.mcpKey);
    if (!group) {
      group = { target: null, others: [] };
      byMcpKey.set(key.mcpKey, group);
    }
    if (key.scope === targetScope) {
      group.target = entry;
      continue;
    }
    const parsed = parsePluginOAuthToken(entry.rawValue);
    if (!parsed || isExpired(parsed, now)) continue;
    group.others.push({ entry, parsed, key });
  }

  const selections: CarryOverSelection[] = [];
  for (const [mcpKey, { target, others }] of byMcpKey) {
    if (others.length === 0) continue;
    others.sort((a, b) => compareFreshness(b, a));
    const best = others[0];

    if (target) {
      const targetParsed = parsePluginOAuthToken(target.rawValue);
      if (targetParsed && !isExpired(targetParsed, now)) {
        const targetCandidate: RankedCandidate = {
          entry: target,
          parsed: targetParsed,
          key: { scope: targetScope, mcpKey, pluginName: best.key.pluginName },
        };
        if (compareFreshness(best, targetCandidate) <= 0) continue;
      }
    }

    selections.push({
      mcpKey,
      pluginName: best.key.pluginName,
      targetFullKey: `${targetScope}/${mcpKey}`,
      sourceFullKey: best.entry.fullKey,
      rawValue: best.entry.rawValue,
      canonicalJson: best.parsed.canonicalJson,
    });
  }
  return selections;
}

function writeAtomicPrivateFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

function encodeKeychainSecret(selection: CarryOverSelection): string {
  if (typeof selection.rawValue === "string") {
    const trimmed = selection.rawValue.trim();
    if (trimmed.startsWith(GO_KEYRING) && !/[\0\s"\\]/.test(trimmed)) return trimmed;
  }
  return GO_KEYRING + Buffer.from(selection.canonicalJson).toString("base64");
}

function carryInKeychain(targetScope: string, now: number): { carried: string[]; warnings: string[] } {
  const carried: string[] = [];
  const warnings: string[] = [];

  let items;
  try {
    items = listKeychainItems(PLUGIN_KEYCHAIN_SERVICE);
  } catch (err) {
    return { carried, warnings: [`Couldn't read plugin sign-ins from the keychain: ${(err as Error).message}`] };
  }

  const entries: ScopedPluginEntry[] = [];
  for (const item of items) {
    if (!parseScopedMcpOAuthKey(item.account)) continue;
    try {
      const secret = readKeychain(PLUGIN_KEYCHAIN_SERVICE, item.account);
      if (secret !== null) entries.push({ fullKey: item.account, rawValue: secret, modifiedAt: item.modifiedAt });
    } catch {
      /* skip an unreadable item rather than blocking other plugins */
    }
  }

  const selections = selectPluginOAuthCarryOver(entries, targetScope, now);
  for (const selection of selections) {
    try {
      writeKeychain(PLUGIN_KEYCHAIN_SERVICE, selection.targetFullKey, encodeKeychainSecret(selection));
      carried.push(selection.pluginName);
    } catch (err) {
      warnings.push(`Couldn't carry over ${selection.pluginName} plugin sign-in: ${(err as Error).message}`);
    }
  }
  return { carried, warnings };
}

function carryInSecretsFile(targetScope: string, now: number): { carried: string[]; warnings: string[] } {
  const path = pluginSecretsPath();
  if (!existsSync(path)) return { carried: [], warnings: [] };

  let data: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { carried: [], warnings: [] };
    data = parsed as Record<string, unknown>;
  } catch (err) {
    return { carried: [], warnings: [`Couldn't read plugin-secrets.json: ${(err as Error).message}`] };
  }

  const entries: ScopedPluginEntry[] = Object.entries(data)
    .filter(([k]) => parseScopedMcpOAuthKey(k) !== null)
    .map(([fullKey, rawValue]) => ({ fullKey, rawValue, modifiedAt: null }));

  const selections = selectPluginOAuthCarryOver(entries, targetScope, now);
  if (selections.length === 0) return { carried: [], warnings: [] };

  for (const selection of selections) {
    data[selection.targetFullKey] = selection.rawValue;
  }

  try {
    writeAtomicPrivateFile(path, `${JSON.stringify(data, null, 2)}\n`);
    return { carried: selections.map((s) => s.pluginName), warnings: [] };
  } catch (err) {
    return { carried: [], warnings: [`Couldn't update plugin-secrets.json: ${(err as Error).message}`] };
  }
}

/**
 * Carry over the newest valid remote MCP plugin OAuth tokens (such as Figma)
 * to `account`'s Antigravity user scope across macOS Keychain and plugin-secrets.json.
 * Best-effort: never throws so a Google account switch isn't blocked by plugin auth.
 */
export function carryPluginOAuth(account: Account, now = Date.now()): CarryPluginOAuthResult {
  const targetScope = accountUserScope(account);
  if (!targetScope) return { carried: [] };

  const carried = new Set<string>();
  const warnings: string[] = [];

  if (process.platform === "darwin") {
    const kc = carryInKeychain(targetScope, now);
    for (const name of kc.carried) carried.add(name);
    warnings.push(...kc.warnings);
  }

  const file = carryInSecretsFile(targetScope, now);
  for (const name of file.carried) carried.add(name);
  warnings.push(...file.warnings);

  // Keep Antigravity's saved scope in step so startup reads the new scope before CachedUserID resolves.
  if (existsSync(antigravityConfigDir())) {
    try {
      writeAtomicPrivateFile(credentialUserScopePath(), targetScope);
    } catch {
      /* non-fatal; agy overwrites this file once authenticated */
    }
  }

  return {
    carried: [...carried].sort(),
    ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
  };
}
