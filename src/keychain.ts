import { spawnSync } from "node:child_process";

const SECURITY = "/usr/bin/security";

/** The agy CLI gives the keychain 5 seconds, then gives up. So does agy-switch. */
const TIMEOUT_MS = 5000;

/** security's exit code when there's no such item: the low byte of errSecItemNotFound (-25300). */
const NOT_FOUND = 44;

/**
 * Run /usr/bin/security, the way go-keyring does for the agy CLI. security finds
 * the keychain through HOME, so a test HOME with a keychain of its own never
 * reaches yours. Bun starts a child with the environment Bun started with, so
 * the child is handed process.env, where agy-switch's HOME is.
 */
function security(args: string[], input?: string): string | null {
  const result = spawnSync(SECURITY, args, { input, env: process.env, encoding: "utf8", timeout: TIMEOUT_MS });
  if (result.status === 0) return result.stdout;
  if (result.status === NOT_FOUND) return null;
  throw new Error(
    result.error
      ? `The keychain didn't answer within ${TIMEOUT_MS / 1000} seconds. If it's locked, unlock it and try again.`
      : result.stderr.trim() || `security exited with code ${result.status}.`,
  );
}

/** An item's secret, or null when there's no such item. */
export function readKeychain(service: string, account: string): string | null {
  return security(["find-generic-password", "-s", service, "-a", account, "-w"])?.trim() ?? null;
}

/** Quote one argument for `security -i`, rejecting characters that could split the command. */
function quoteInteractiveArg(value: string, label: string): string {
  if (/[\0\r\n"\\]/.test(value)) throw new Error(`Invalid keychain ${label}.`);
  return /\s/.test(value) ? `"${value}"` : value;
}

/**
 * Add an item, or replace its secret. Like go-keyring, this sends the command
 * on stdin, so the secret never shows in the process list.
 */
export function writeKeychain(service: string, account: string, secret: string): void {
  const s = quoteInteractiveArg(service, "service");
  const a = quoteInteractiveArg(account, "account");
  const w = quoteInteractiveArg(secret, "secret");
  const command = `add-generic-password -U -s ${s} -a ${a} -w ${w}\n`;
  // security cuts a longer line at 4096 bytes and runs each piece as its own command.
  if (command.length > 4096) throw new Error("The sign-in is too long for the keychain.");
  security(["-i"], command);
}

export type KeychainItemMeta = {
  account: string;
  /** Last modified time in epoch ms, or null if not reported. */
  modifiedAt: number | null;
};

/** Decode a keychain attribute value from `security dump-keychain` (`"text"` or `0xHEX  "..."`). */
function decodeDumpBlob(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "<NULL>") return null;
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
  const hex = /^0x([0-9a-fA-F]+)/.exec(trimmed)?.[1];
  if (hex && hex.length % 2 === 0) return Buffer.from(hex, "hex").toString("utf8");
  return null;
}

/** Parse a `security dump-keychain` timedate like `"20261124073601Z\000"` into epoch ms. */
function parseDumpDate(raw: string): number | null {
  const match = /"(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z/.exec(raw);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return Number.isFinite(ms) ? ms : null;
}

/** Parse generic password items for `service` out of `security dump-keychain` output. */
export function parseKeychainDump(dump: string, service: string): KeychainItemMeta[] {
  const items: KeychainItemMeta[] = [];
  const blocks = dump.split(/(?=^keychain: )/m);
  for (const block of blocks) {
    if (!/^class:\s*"genp"/m.test(block)) continue;
    const svceRaw = /^\s*"svce"<blob>=(.+)$/m.exec(block)?.[1];
    if (!svceRaw || decodeDumpBlob(svceRaw) !== service) continue;
    const acctRaw = /^\s*"acct"<blob>=(.+)$/m.exec(block)?.[1];
    const account = acctRaw ? decodeDumpBlob(acctRaw) : null;
    if (!account) continue;
    const mdatRaw = /^\s*"mdat"<timedate>=(.+)$/m.exec(block)?.[1];
    items.push({ account, modifiedAt: mdatRaw ? parseDumpDate(mdatRaw) : null });
  }
  return items;
}

/** List generic password accounts for `service` in the user's default login keychain. */
export function listKeychainItems(service: string): KeychainItemMeta[] {
  const def = security(["default-keychain", "-d", "user"])?.trim();
  const keychainPath = def?.replace(/^"(.*)"$/, "$1");
  if (!keychainPath) return [];
  const dump = security(["dump-keychain", keychainPath]);
  return dump ? parseKeychainDump(dump, service) : [];
}
