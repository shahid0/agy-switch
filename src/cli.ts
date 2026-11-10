#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  REQUIRED_SCOPES,
  isAcpEligible,
  markUsed,
  missingScopes,
  readAccounts,
  readStore,
  removeAccount,
  scopeLabel,
  upsertAccount,
  type Account,
} from "./store.ts";
import { login, type LoginResult } from "./login.ts";
import { probeQuota } from "./quota.ts";
import {
  findAcpTokenPaths,
  matchByRefreshToken,
  openInBrowser,
  readAcpTokenFile,
  writeAcp,
  writeAgy,
} from "./write.ts";
import { agyTokenPath, storePath } from "./paths.ts";

const HELP = `agy-switch — Antigravity account manager for the agy CLI and T3 ACP

WHAT THIS IS
  Its own account store, its own sign-in, its own quota reads. It does not
  depend on any other Antigravity app.

  Accounts live in:   ~/.agy-switch/accounts.json
  It can write to:    ~/.t3/userdata/providers/antigravity/*/antigravity-acp/acp_token.json
                      ~/.gemini/antigravity-cli/antigravity-oauth-token   (opt-in)

WHY IT EXISTS FOR AGENTS
  Switching accounts by hand means re-authorising in a browser and copying
  tokens between paths. This does it in one call and reports what changed.
  It never switches on its own: it reports state and executes an explicit
  \`switch\`. The decision belongs to the caller.

AUTHORISATION — READ THIS
  Google only grants \`auth/aicode\` at consent time. That scope is what lets an
  account drive Antigravity at all; without it the harness fails with
  \`invalid_scope\` and falls back to a browser login. So every account must be
  added through \`agy-switch add\`, which runs a real Google sign-in.
  No command can mint that grant without a human approving it in a browser.
  \`list\` shows which accounts are ACP-eligible and which are missing a scope.

COMMANDS
  agy-switch add [--browser|--no-browser] [--open <url>]
      Start a Google sign-in and add the account to the store. Prints the
      authorize URL, then waits for the local callback.
        --browser      open the URL in the default browser
        --no-browser   print the URL only (default; copy it into the browser
                       profile that should own the account)
        --open <url>   instead of waiting, complete a previously printed URL
        --timeout <s>  give up after this long (default 300)
        --json         machine-readable result

  agy-switch list [--json]
      Every stored account with quota, subscription, and ACP eligibility.

  agy-switch current [--json]
      Which stored account each surface currently points at.

  agy-switch switch <who> [options]
        --target <acp|agy|both>   surfaces to write (default: acp)
        --json                    machine-readable result
      Refuses accounts that are not ACP-eligible rather than breaking a
      working session.

  agy-switch pick [--for <model>] [--include-ineligible] [--json]
      Ranked candidates, best first. A query, not a decision: it never switches.

  agy-switch quota [<who>] [--json]
      Read quota from Google for one account, or all of them.

  agy-switch remove <who>
      Delete an account from the store. Does not touch Google's consent.

  agy-switch doctor [--json]
      Check the store, the sign-in harness, and each writable surface.

  agy-switch agent
      The full agent-facing manual: use cases, JSON shapes, decision rules,
      exit-code handling, and the traps. Read this instead of guessing.
      Same text as AGENTS.md in the repo.

  agy-switch help

<who> accepts: email, email prefix, display name, account id, or 1-based position.

START HERE (agents)
  Run \`agy-switch agent\` for the long-form manual: what this is for, how to
  choose an account, what to report back, and what not to assume.

EXIT CODES
  0  success
  1  runtime error (sign-in failed, quota unreachable, missing harness)
  2  usage error (bad flag, unknown/ambiguous account, not ACP-eligible)
`;

type Args = { _: string[]; flags: Record<string, string | boolean> };

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out.flags[name] = next;
      i++;
    } else {
      out.flags[name] = true;
    }
  }
  return out;
}

function fail(message: string, code = 1): never {
  console.error(`agy-switch: ${message}`);
  process.exit(code);
}

function resolveAccount(ref: string, accounts = readAccounts()): Account {
  const needle = ref.trim().toLowerCase();
  if (!needle) fail("Empty account reference.", 2);

  const byId = accounts.find((a) => a.id.toLowerCase() === needle);
  if (byId) return byId;
  const byEmail = accounts.find((a) => a.email.toLowerCase() === needle);
  if (byEmail) return byEmail;

  const n = Number(needle);
  if (Number.isInteger(n) && n >= 1 && n <= accounts.length) return accounts[n - 1];

  const byName = accounts.find((a) => (a.name ?? "").toLowerCase() === needle);
  if (byName) return byName;

  const prefix = accounts.filter(
    (a) => a.email.toLowerCase().startsWith(needle) || (a.name ?? "").toLowerCase().startsWith(needle),
  );
  if (prefix.length === 1) return prefix[0];
  if (prefix.length > 1) {
    fail(`Ambiguous "${ref}": ${prefix.map((a) => a.email).join(", ")}`, 2);
  }
  fail(`No account matches "${ref}". Run: agy-switch list`, 2);
}

function quotaCell(a: Account): string {
  const models = a.quota?.models ?? [];
  if (models.length === 0) return "—";
  const worst = Math.min(...models.map((m) => m.percentage));
  const resets = models.map((m) => m.reset_time).filter(Boolean).sort()[0];
  const reset = resets ? resets.slice(5, 16).replace("T", " ") : "—";
  return `${String(worst).padStart(3)}%  ${reset}`;
}

function eligibilityCell(a: Account): string {
  const missing = missingScopes(a);
  if (missing.length === 0) return "yes";
  return `no (missing ${missing.map(scopeLabel).join(",")})`;
}

function activeSurfaces(accounts: Account[]): { agy?: string; acp?: string } {
  const out: { agy?: string; acp?: string } = {};
  const agyPath = agyTokenPath();
  try {
    const raw = JSON.parse(require("node:fs").readFileSync(agyPath, "utf8")) as {
      token?: { refresh_token?: string };
    };
    out.agy = matchByRefreshToken(accounts, raw.token?.refresh_token)?.email;
  } catch {
    /* no agy token */
  }
  for (const path of findAcpTokenPaths()) {
    const token = readAcpTokenFile(path);
    const hit = matchByRefreshToken(accounts, token?.refresh_token);
    if (hit) {
      out.acp = hit.email;
      break;
    }
  }
  return out;
}

function cmdAdd(args: Args) {
  const id = randomUUID();
  const openBrowser = Boolean(args.flags.browser) && !args.flags["no-browser"];
  const timeoutMs = Number(args.flags.timeout ?? 300) * 1000;

  console.log("Starting Google sign-in…\n");

  return login({
    timeoutMs,
    openUrl: openBrowser ? openInBrowser : undefined,
    onUrl: (url) => {
      console.log("Authorize URL:\n");
      console.log(url);
      console.log(
        openBrowser
          ? "\n(opened in your default browser)\n"
          : "\n(not opened — paste this into the browser profile that should own the account)\n",
      );
    },
    log: () => {},
  })
    .then((result) => {
      const missing = REQUIRED_SCOPES.filter((s) => !result.grantedScopes.includes(s));
      if (missing.length > 0) {
        fail(
          `This account did not grant ${missing.map(scopeLabel).join(", ")}.\n` +
            `It cannot drive Antigravity. Re-run \`agy-switch add\` and approve every permission.`,
          1,
        );
      }

      const now = new Date().toISOString();
      const account: Account = {
        id,
        email: result.email,
        name: result.name || result.email,
        acpToken: result.acpToken,
        accessToken: result.accessToken,
        idToken: result.idToken,
        expiresAt: result.expiresAt,
        grantedScopes: result.grantedScopes,
        subscription: result.subscription ?? null,
        quota: null,
        quotaCheckedAt: null,
        disabled: false,
        addedAt: now,
        lastUsedAt: null,
      };

      const { account: saved, replaced } = upsertAccount(account);

      if (args.flags.json) {
        console.log(
          JSON.stringify(
            { added: saved.email, replaced, acpEligible: true, grantedScopes: saved.grantedScopes },
            null,
            2,
          ),
        );
        return;
      }
      console.log(`${replaced ? "updated" : "added"} ${saved.email}`);
      console.log(`  ACP-eligible  yes (aicode granted)`);
      console.log(`  store         ${storePath()}`);
      console.log(`\nNext: agy-switch switch ${saved.email}`);
    })
    .catch((err) => fail(err instanceof Error ? err.message : String(err)));
}

function cmdList(args: Args) {
  const accounts = readAccounts();
  if (accounts.length === 0) {
    console.log("No accounts yet. Add one with: agy-switch add");
    return;
  }
  const active = activeSurfaces(accounts);

  if (args.flags.json) {
    console.log(
      JSON.stringify(
        accounts.map((a, i) => ({
          index: i + 1,
          id: a.id,
          email: a.email,
          name: a.name,
          quota: a.quota?.models?.length
            ? { worstPercentage: Math.min(...a.quota.models.map((m) => m.percentage)) }
            : null,
          acpEligible: isAcpEligible(a),
          missingScopes: missingScopes(a),
          active: { acp: active.acp === a.email, agy: active.agy === a.email },
        })),
        null,
        2,
      ),
    );
    return;
  }

  const rows = accounts.map((a, i) => [
    String(i + 1),
    a.email,
    (a.name ?? "").slice(0, 18),
    quotaCell(a),
    eligibilityCell(a),
    [active.acp === a.email ? "acp" : "", active.agy === a.email ? "agy" : ""]
      .filter(Boolean)
      .join(","),
  ]);
  const header = ["#", "EMAIL", "NAME", "WORST / RESET", "ACP", "ACTIVE"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (c: string[]) => c.map((v, i) => v.padEnd(widths[i])).join("  ").trimEnd();

  console.log(line(header));
  console.log(widths.map((w) => "─".repeat(w)).join("  "));
  for (const r of rows) console.log(line(r));
  console.log(`\nacp: ${active.acp ?? "not set"}   agy: ${active.agy ?? "not set"}`);
}

function cmdCurrent(args: Args) {
  const accounts = readAccounts();
  const active = activeSurfaces(accounts);
  if (args.flags.json) {
    console.log(JSON.stringify(active, null, 2));
    return;
  }
  console.log(`T3 ACP    ${active.acp ?? "(not matched to a stored account)"}`);
  console.log(`agy CLI   ${active.agy ?? "(not matched to a stored account)"}`);
}

function cmdSwitch(args: Args) {
  const who = args._[1];
  if (!who) fail("switch needs an account. Try: agy-switch list", 2);

  const target = String(args.flags.target ?? "acp");
  if (!["acp", "agy", "both"].includes(target)) fail(`--target must be acp, agy, or both`, 2);

  const account = resolveAccount(who);

  const missing = missingScopes(account);
  if (target !== "agy" && missing.length > 0) {
    fail(
      `${account.email} cannot drive Antigravity: it is missing ${missing.map(scopeLabel).join(", ")}.\n` +
        `Re-add it with \`agy-switch add\` so the grant is issued, or pick another account:\n` +
        `  agy-switch pick`,
      2,
    );
  }

  const scope = { acp: target !== "agy", agy: target !== "acp" };
  const result: Record<string, unknown> = { switchedTo: account.email, id: account.id, target };

  try {
    if (scope.acp) result.acpPaths = writeAcp(account);
    if (scope.agy) result.agyPath = writeAgy(account);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  markUsed(account.id);

  if (args.flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`switched to ${account.email}`);
  for (const p of (result.acpPaths as string[] | undefined) ?? []) console.log(`  T3 ACP   ${p}`);
  if (result.agyPath) console.log(`  agy CLI  ${result.agyPath}`);
  if (scope.agy) console.log(`\nStart a new \`agy\` session to pick up the credentials.`);
}

function cmdPick(args: Args) {
  const accounts = readAccounts();
  const includeIneligible = Boolean(args.flags["include-ineligible"]);
  const forModel = args.flags.for ? String(args.flags.for) : undefined;

  const score = (a: Account) => {
    const models = a.quota?.models ?? [];
    if (models.length === 0) return -1;
    if (forModel) {
      const hit = models.find((m) => m.name === forModel || m.name.includes(forModel));
      return hit ? hit.percentage : -1;
    }
    return Math.min(...models.map((m) => m.percentage));
  };

  const candidates = accounts
    .map((a, i) => ({
      index: i + 1,
      id: a.id,
      email: a.email,
      name: a.name,
      score: score(a),
      acpEligible: isAcpEligible(a),
      missingScopes: missingScopes(a),
      excluded: !includeIneligible && !isAcpEligible(a) ? "not ACP-eligible" : null,
    }))
    .filter((c) => c.excluded === null)
    .sort((x, y) => y.score - x.score);

  if (candidates.length === 0) {
    fail(
      "No ACP-eligible account. Add one with: agy-switch add\n" +
        "(use --include-ineligible to list the others)",
      2,
    );
  }

  if (args.flags.json) {
    console.log(
      JSON.stringify(
        {
          rankedBy: forModel ? `model:${forModel}` : "worst remaining quota",
          candidates,
          hint: "call `agy-switch switch <email> --json` to apply your choice",
        },
        null,
        2,
      ),
    );
    return;
  }

  const rows = candidates.map((c, i) => [
    String(i + 1),
    c.email,
    `${String(c.score).padStart(3)}%`,
    c.acpEligible ? "yes" : "no",
  ]);
  const header = ["RANK", "EMAIL", "SCORE", "ACP"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (c: string[]) => c.map((v, i) => v.padEnd(widths[i])).join("  ").trimEnd();
  console.log(line(header));
  console.log(widths.map((w) => "─".repeat(w)).join("  "));
  for (const r of rows) console.log(line(r));
  console.log(`\nranked by ${forModel ? `model ${forModel}` : "worst remaining quota"}`);
  console.log("apply with: agy-switch switch <email>");
}

async function cmdQuota(args: Args) {
  const accounts = readAccounts();
  if (accounts.length === 0) fail("No accounts. Add one with: agy-switch add", 2);

  const who = args._[1];
  const subset = who ? [resolveAccount(who, accounts)] : accounts;

  const results: Array<Record<string, unknown>> = [];
  for (const account of subset) {
    try {
      const q = await probeQuota(account);
      account.quota = { ...q, subscription_tier: account.quota?.subscription_tier };
      account.quotaCheckedAt = new Date().toISOString();
      upsertAccount(account);
      results.push({ email: account.email, ok: true, ...q });
    } catch (err) {
      results.push({
        email: account.email,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (args.flags.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  for (const r of results as Array<{ email: string; ok: boolean; models?: any[]; error?: string }>) {
    console.log(r.email);
    if (!r.ok) {
      console.log(`   ! ${r.error}`);
    } else {
      for (const m of r.models ?? []) {
        const reset = m.reset_time ? m.reset_time.slice(5, 16).replace("T", " ") : "";
        console.log(`   ${String(m.percentage).padStart(4)}%  ${String(m.name).padEnd(24)} ${reset}`);
      }
    }
    console.log("");
  }
}

function cmdRemove(args: Args) {
  const who = args._[1];
  if (!who) fail("remove needs an account. Try: agy-switch list", 2);
  const removed = removeAccount(who);
  if (!removed) fail(`No account matches "${who}"`, 2);
  console.log(`removed ${removed.email} from the store`);
  console.log(`(Google still remembers the consent; revoke it at myaccount.google.com if you want)`);
}

function cmdAgent() {
  // Resolve relative to this file so the manual travels with the tool.
  const candidates = [
    new URL("../AGENTS.md", import.meta.url).pathname,
    new URL("AGENTS.md", import.meta.url).pathname,
  ];
  for (const path of candidates) {
    try {
      console.log(readFileSync(path, "utf8"));
      return;
    } catch {
      /* try next */
    }
  }
  fail(
    "AGENTS.md not found next to the tool. Re-clone the repo, or see README.md.",
    1,
  );
}

async function cmdDoctor(args: Args) {
  const { harnessBinary } = await import("./paths.ts");
  const accounts = readAccounts();
  const checks = [
    { name: "store", ok: true, detail: `${accounts.length} accounts at ${storePath()}` },
    {
      name: "sign-in harness",
      ok: Boolean(harnessBinary()),
      detail: harnessBinary() ?? "not found — install T3 Code, or set AGY_SWITCH_HARNESS",
    },
    { name: "T3 ACP target", ok: findAcpTokenPaths().length > 0, detail: `${findAcpTokenPaths().length} file(s)` },
    { name: "agy CLI target", ok: true, detail: agyTokenPath() },
  ];

  if (args.flags.json) {
    console.log(JSON.stringify(checks, null, 2));
    return;
  }
  for (const c of checks) console.log(`${c.ok ? "ok  " : "FAIL"}  ${c.name.padEnd(16)} ${c.detail}`);
}

export async function main(argv: string[]) {
  const command = argv[0];
  const args = parseArgs(argv);

  if (!command || command === "help" || args.flags.help) {
    console.log(HELP);
    return;
  }

  switch (command) {
    case "add":
      return cmdAdd(args);
    case "list":
    case "ls":
      return cmdList(args);
    case "current":
    case "status":
      return cmdCurrent(args);
    case "switch":
    case "use":
      return cmdSwitch(args);
    case "pick":
    case "best":
      return cmdPick(args);
    case "quota":
    case "quotas":
      return cmdQuota(args);
    case "remove":
    case "rm":
      return cmdRemove(args);
    case "agent":
    case "agents":
    case "manual":
      return cmdAgent();
    case "doctor":
      return cmdDoctor(args);
    default:
      fail(`unknown command "${command}". Run: agy-switch help`, 2);
  }
}
