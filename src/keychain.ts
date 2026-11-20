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

/**
 * Add an item, or replace its secret. Like go-keyring, this sends the command
 * on stdin, so the secret never shows in the process list. Every value must be
 * one word, as go-keyring's base64 form always is.
 */
export function writeKeychain(service: string, account: string, secret: string): void {
  const command = `add-generic-password -U -s ${service} -a ${account} -w ${secret}\n`;
  // security cuts a longer line at 4096 bytes and runs each piece as its own command.
  if (command.length > 4096) throw new Error("The sign-in is too long for the keychain.");
  security(["-i"], command);
}
