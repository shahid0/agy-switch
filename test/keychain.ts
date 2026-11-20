import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { readKeychain } from "../src/keychain.ts";

/**
 * Give a test HOME a keychain of its own, then stop unless agy-switch reads
 * from it. security finds the keychain through HOME, so a test that missed it
 * would write to yours. Call it after pointing process.env.HOME at `home`.
 */
export function ownKeychain(home: string): void {
  const keychain = join(home, "Library/Keychains/login.keychain-db");
  mkdirSync(join(keychain, ".."), { recursive: true });
  const env = { ...process.env, HOME: home };
  execFileSync("/usr/bin/security", ["create-keychain", "-p", "", keychain], { env });
  execFileSync("/usr/bin/security", ["add-generic-password", "-s", "agy-switch-test", "-a", "probe", "-w", home, keychain], { env });
  if (readKeychain("agy-switch-test", "probe") !== home) {
    throw new Error(`agy-switch doesn't read ${keychain}. Stopping before a test writes to your keychain.`);
  }
}
