#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { login } from "./login.ts";
import { agyTokenPath, harnessBinary, storePath, t3AcpRoot, tildify } from "./paths.ts";
import { matchGroup, probeQuota, type QuotaGroup } from "./quota.ts";
import {
  REQUIRED_SCOPES,
  canRunAgents,
  markUsed,
  missingScopes,
  readAccounts,
  removeAccount,
  saveQuota,
  scopeLabel,
  upsertAccount,
  type Account,
  type QuotaBucket,
} from "./store.ts";
import { activeAccounts, findAcpTokenPaths, openInBrowser, writeAcp, writeAgy } from "./write.ts";

const HELP = `agy-switch switches the Google Antigravity account that T3 Code uses,
and the agy CLI if you want.

Commands
  current                   Which account T3 Code and the agy CLI use now
  list                      Saved accounts, quota left, and which can run agents
  pick [--for <model>]      Rank accounts by live quota left. Doesn't switch
  quota [<account>]         Live quota for one account, or all of them
  switch <account> [--target t3|agy|both]
                            Use this account. Default target: t3 (T3 Code)
  add [--browser]           Sign in with Google and save the account
  remove <account>          Delete a saved account
  doctor                    Check your setup
  agent                     Manual for AI agents

<account> is an email, the start of one, a name, or a number from list.
Add --json for JSON output. It works with every command except help and agent.

For AI agents
  Switch on your own, without asking, when the account in use doesn't have the
  quota for the work ahead. To move to the account with the most quota:
    agy-switch pick --json        (add --for claude or --for gemini for one model)
    agy-switch switch <email> --json
  More: agy-switch agent

Exit codes: 0 done, 1 something failed (network, sign-in, setup),
2 the command needs fixing (unknown account or flag, an account that can't run agents).
`;

type Flags = Record<string, string | true>;
type Parsed = { command: string; args: string[]; flags: Flags };

/** A failure the person can act on. `code` stays stable for --json callers. */
class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 2 = 1,
    readonly code = "failed",
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const usage = (message: string) => new CliError(message, 2, "usage");

const COMMANDS: Record<string, { flags: Record<string, "bool" | "value">; maxArgs: number }> = {
  current: { flags: { json: "bool" }, maxArgs: 0 },
  list: { flags: { json: "bool" }, maxArgs: 0 },
  pick: { flags: { json: "bool", for: "value", all: "bool" }, maxArgs: 0 },
  quota: { flags: { json: "bool" }, maxArgs: 1 },
  switch: { flags: { json: "bool", target: "value" }, maxArgs: 1 },
  add: { flags: { json: "bool", browser: "bool", "no-browser": "bool", timeout: "value" }, maxArgs: 0 },
  remove: { flags: { json: "bool" }, maxArgs: 1 },
  doctor: { flags: { json: "bool" }, maxArgs: 0 },
  agent: { flags: {}, maxArgs: 0 },
  help: { flags: {}, maxArgs: 0 },
};

const ALIASES: Record<string, string> = {
  ls: "list",
  status: "current",
  use: "switch",
  best: "pick",
  quotas: "quota",
  rm: "remove",
  agents: "agent",
  manual: "agent",
};

export function parseArgs(argv: string[]): Parsed {
  const [first = "help", ...rest] = argv;
  const command = first === "--help" || first === "-h" ? "help" : (ALIASES[first] ?? first);
  const spec = COMMANDS[command];
  if (!spec) throw usage(`Unknown command "${first}". See the commands with: agy-switch help`);

  const parsed: Parsed = { command, args: [], flags: {} };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--help" || arg === "-h") return { command: "help", args: [], flags: {} };
    if (!arg.startsWith("-")) {
      parsed.args.push(arg);
      continue;
    }

    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    const kind = arg.startsWith("--") ? spec.flags[name] : undefined;
    if (!kind) {
      const known = Object.keys(spec.flags).map((f) => `--${f}`);
      const takes = known.length ? ` It takes ${known.join(", ")}.` : "";
      throw usage(`${command} doesn't take ${eq < 0 ? arg : arg.slice(0, eq)}.${takes}`);
    }
    if (kind === "bool") {
      if (eq >= 0) throw usage(`--${name} doesn't take a value.`);
      parsed.flags[name] = true;
      continue;
    }
    const value = eq >= 0 ? arg.slice(eq + 1) : rest[++i];
    if (!value || value.startsWith("--")) throw usage(`--${name} needs a value.`);
    parsed.flags[name] = value;
  }

  if (parsed.args.length > spec.maxArgs) {
    throw usage(`Didn't expect "${parsed.args[spec.maxArgs]}" after ${command}. See: agy-switch help`);
  }
  return parsed;
}

export function resolveAccount(ref: string, accounts: Account[]): Account {
  const needle = ref.trim().toLowerCase();
  if (!needle) throw usage("Give an account: an email, the start of one, a name, or a number from list.");

  const exact = accounts.find((a) => a.id.toLowerCase() === needle || a.email.toLowerCase() === needle);
  if (exact) return exact;

  const n = Number(needle);
  if (Number.isInteger(n) && n >= 1 && n <= accounts.length) return accounts[n - 1];

  const byName = accounts.filter((a) => a.name.toLowerCase() === needle);
  const hits =
    byName.length > 0
      ? byName
      : accounts.filter((a) => a.email.toLowerCase().startsWith(needle) || a.name.toLowerCase().startsWith(needle));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    const emails = hits.map((a) => a.email);
    throw new CliError(`"${ref}" matches ${emails.length} accounts: ${emails.join(", ")}. Use the full email.`, 2, "ambiguous", {
      candidates: emails,
    });
  }
  throw new CliError(`No saved account matches "${ref}". See your accounts with: agy-switch list`, 2, "not_found");
}

const printJson = (data: unknown) => console.log(JSON.stringify(data, null, process.stdout.isTTY ? 2 : undefined));
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

const noAccounts = () => new CliError("No saved accounts yet. Add one with: agy-switch add", 2, "no_accounts");

const permissionText = (labels: string[]) =>
  labels.length === 1 ? `the ${labels[0]} permission` : `the ${labels.join(" and ")} permissions`;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "1h 36m", "5d", "12m": time between now and an ISO date, either way. */
function span(iso: string): string {
  const minutes = Math.round(Math.abs(Date.parse(iso) - Date.now()) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours >= 48) return `${Math.round(hours / 24)}d`;
  return hours < 10 && minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

const appNames = (targets: string[]) =>
  targets.map((t) => (t === "t3" ? "T3 Code" : "the agy CLI")).join(" and ");

function table(rows: string[][]) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  for (const r of rows) console.log(r.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd());
}

/** The limit that runs out first: what an account's headroom really is. */
function tightest(buckets: QuotaBucket[]) {
  if (buckets.length === 0) return null;
  const b = buckets.reduce((low, next) => (next.percentage < low.percentage ? next : low));
  return {
    left: b.percentage,
    limitedBy: [b.group, b.window].filter(Boolean).join(", ") || b.name,
    window: b.window ?? b.name,
    resetsAt: b.reset_time || null,
  };
}

type Live = { groups: QuotaGroup[] } | { error: string };

/** Read quota from Google for every account at once and save the results. */
async function readLiveQuota(accounts: Account[]): Promise<Map<string, Live>> {
  const results = await Promise.all(
    accounts.map(async (a): Promise<[string, Live]> => {
      try {
        return [a.id, { groups: await probeQuota(a) }];
      } catch (err) {
        return [a.id, { error: errorText(err) }];
      }
    }),
  );
  const fresh = new Map<string, QuotaBucket[]>();
  for (const [id, r] of results) if ("groups" in r) fresh.set(id, r.groups.flatMap((g) => g.buckets));
  if (fresh.size > 0) saveQuota(fresh, new Date().toISOString());
  return new Map(results);
}

function cmdCurrent({ flags }: Parsed) {
  const active = activeAccounts(readAccounts());
  if (flags.json) return printJson(active);
  table([
    ["T3 Code", active.t3 ?? "none of your saved accounts"],
    ["agy CLI", active.agy ?? "none of your saved accounts"],
  ]);
}

async function cmdList({ flags }: Parsed) {
  const accounts = readAccounts();
  if (accounts.length === 0) {
    return flags.json ? printJson([]) : console.log("No saved accounts yet. Add one with: agy-switch add");
  }

  // Live, like pick: a snapshot hours old reads as fact and gets repeated.
  const live = await readLiveQuota(accounts);
  const active = activeAccounts(accounts);
  const rows = accounts.map((a, i) => {
    const r = live.get(a.id)!;
    const headroom = tightest("groups" in r ? r.groups.flatMap((g) => g.buckets) : (a.quota?.models ?? []));
    return {
      index: i + 1,
      email: a.email,
      name: a.name,
      canRunAgents: canRunAgents(a),
      missingScopes: missingScopes(a).map(scopeLabel),
      active: { t3: active.t3 === a.email, agy: active.agy === a.email },
      quota: headroom ? { left: headroom.left, limitedBy: headroom.limitedBy, resetsAt: headroom.resetsAt } : null,
      // When Google can't be read, quota is the last snapshot and says how old it is.
      ...("error" in r ? { quotaError: r.error, quotaCheckedAt: a.quotaCheckedAt ?? null } : {}),
      lastUsedAt: a.lastUsedAt,
    };
  });
  if (flags.json) return printJson(rows);

  table([
    ["#", "EMAIL", "NAME", "QUOTA LEFT", "CAN RUN AGENTS", "IN USE BY"],
    ...rows.map((r) => [
      String(r.index),
      r.email,
      r.name,
      !r.quota
        ? "unknown"
        : "quotaError" in r
          ? `${r.quota.left}%, ${r.quotaCheckedAt ? `${span(r.quotaCheckedAt)} old` : "old"}`
          : `${r.quota.left}%`,
      r.canRunAgents ? "yes" : `no, missing ${r.missingScopes.join(", ")}`,
      [r.active.t3 && "T3 Code", r.active.agy && "agy CLI"].filter(Boolean).join(", "),
    ]),
  ]);
  const failed = rows.filter((r) => "quotaError" in r);
  console.log("\nQuota left is each account's tightest limit, read live from Google.");
  if (failed.length > 0) {
    console.log(`Couldn't read live quota for ${plural(failed.length, "account")}: ${failed[0].quotaError}`);
  }
}

async function cmdPick({ flags }: Parsed) {
  const accounts = readAccounts();
  if (accounts.length === 0) throw noAccounts();
  const pool = flags.all ? accounts : accounts.filter(canRunAgents);
  if (pool.length === 0) {
    throw new CliError(
      "None of your saved accounts can run agents: each is missing the aicode permission. Add one with: agy-switch add",
      2,
      "none_can_run_agents",
    );
  }

  const live = await readLiveQuota(pool);
  const query = typeof flags.for === "string" ? flags.for : undefined;
  let group: string | undefined;
  if (query) {
    const sample = [...live.values()].find((r): r is { groups: QuotaGroup[] } => "groups" in r);
    if (sample) {
      const hits = matchGroup(sample.groups, query);
      const names = sample.groups.map((g) => g.name);
      if (hits.length === 0) {
        throw new CliError(`No model group matches "${query}". Groups: ${names.join(", ")}.`, 2, "no_match", { groups: names });
      }
      if (hits.length > 1) {
        const options = hits.map((g) => g.name);
        throw new CliError(`"${query}" matches more than one model group: ${options.join(", ")}. Be more specific.`, 2, "ambiguous", {
          candidates: options,
        });
      }
      group = hits[0].name;
    }
  }

  const active = activeAccounts(accounts);
  const candidates = pool
    .map((a) => {
      const r = live.get(a.id)!;
      const buckets = "groups" in r ? r.groups.filter((g) => !group || g.name === group).flatMap((g) => g.buckets) : [];
      const headroom = tightest(buckets);
      return {
        email: a.email,
        name: a.name,
        quotaLeft: headroom?.left ?? null,
        limitedBy: headroom?.limitedBy ?? null,
        window: headroom?.window ?? null,
        resetsAt: headroom?.resetsAt ?? null,
        active: { t3: active.t3 === a.email, agy: active.agy === a.email },
        lastUsedAt: a.lastUsedAt,
        ...(flags.all ? { canRunAgents: canRunAgents(a), missingScopes: missingScopes(a).map(scopeLabel) } : {}),
        ...("error" in r ? { quotaError: r.error } : {}),
      };
    })
    .sort((x, y) => (y.quotaLeft ?? -1) - (x.quotaLeft ?? -1));

  const rankedBy = group ?? "tightest limit across all model groups";
  if (flags.json) {
    return printJson({
      rankedBy,
      candidates: candidates.map(({ window, ...c }) => c),
      next: "agy-switch switch <email> --json",
    });
  }

  console.log(
    group
      ? `Ranked by quota left on ${group}, read live from Google:\n`
      : "Ranked by quota left on each account's tightest limit, read live from Google:\n",
  );
  table(
    candidates.map((c, i) => [
      `${i + 1}`,
      c.email,
      c.quotaLeft === null ? "unknown" : `${c.quotaLeft}%`,
      c.quotaLeft === null
        ? `couldn't read quota: ${c.quotaError}`
        : `${group ? c.window : c.limitedBy}${c.resetsAt && c.quotaLeft < 100 ? `, resets in ${span(c.resetsAt)}` : ""}`,
      [c.active.t3 && "in use by T3 Code", "canRunAgents" in c && !c.canRunAgents && "can't run agents"]
        .filter(Boolean)
        .join(", "),
    ]),
  );
  console.log("\nSwitch with: agy-switch switch <email>");
}

async function cmdQuota({ args, flags }: Parsed) {
  const accounts = readAccounts();
  if (accounts.length === 0) throw noAccounts();
  const subset = args[0] ? [resolveAccount(args[0], accounts)] : accounts;
  const live = await readLiveQuota(subset);

  const results = subset.map((a) => {
    const r = live.get(a.id)!;
    if ("error" in r) return { email: a.email, ok: false as const, error: r.error };
    return {
      email: a.email,
      ok: true as const,
      ...(canRunAgents(a) ? {} : { canRunAgents: false }),
      groups: r.groups.map((g) => ({
        name: g.name,
        ...(g.models ? { models: g.models } : {}),
        left: Math.min(...g.buckets.map((b) => b.percentage)),
        windows: g.buckets.map((b) => ({ window: b.window ?? b.name, left: b.percentage, resetsAt: b.reset_time || null })),
      })),
    };
  });
  if (results.every((r) => !r.ok)) process.exitCode = 1;
  if (flags.json) return printJson(results);

  for (const r of results) {
    console.log(`${r.email}${"canRunAgents" in r ? "  (can't run agents: missing aicode)" : ""}`);
    if (!r.ok) {
      console.log(`  Couldn't read quota: ${r.error}\n`);
      continue;
    }
    table(
      r.groups.map((g) => [
        `  ${g.name}`,
        g.windows
          .map((w) => `${w.window} ${w.left}%${w.left < 100 && w.resetsAt ? ` (resets in ${span(w.resetsAt)})` : ""}`)
          .join("   "),
      ]),
    );
    console.log("");
  }
}

function cmdSwitch({ args, flags }: Parsed) {
  if (!args[0]) throw usage("switch needs an account, such as: agy-switch switch you@example.com");
  const target = flags.target ?? "t3";
  if (target !== "t3" && target !== "agy" && target !== "both") throw usage("--target must be t3, agy or both.");

  const accounts = readAccounts();
  const account = resolveAccount(args[0], accounts);
  const targets = target === "both" ? ["t3", "agy"] : [target];

  const missing = missingScopes(account).map(scopeLabel);
  if (targets.includes("t3") && missing.length > 0) {
    throw new CliError(
      `${account.email} can't run agents in T3 Code: its sign-in is missing ${permissionText(missing)}. ` +
        "Nothing was changed. To fix it, run agy-switch add and approve every permission for this account. " +
        "To see the accounts that can, run: agy-switch pick",
      2,
      "cannot_run_agents",
      { missingScopes: missing },
    );
  }
  const t3Paths = targets.includes("t3") ? findAcpTokenPaths() : [];
  if (targets.includes("t3") && t3Paths.length === 0) {
    throw new CliError(
      `Couldn't find T3 Code's Antigravity sign-in under ${tildify(t3AcpRoot())}. ` +
        "Sign in to Antigravity in T3 Code once, then try again. Nothing was changed.",
      1,
      "no_t3_signin",
    );
  }

  const before = activeAccounts(accounts);
  if (targets.includes("t3")) writeAcp(account, t3Paths);
  if (targets.includes("agy")) writeAgy(account);
  markUsed(account.id);

  const previous = Object.fromEntries(targets.map((t) => [t, before[t as "t3" | "agy"]]));
  const note = "Sessions already running keep the account they started with.";
  if (flags.json) return printJson({ switchedTo: account.email, target, previous, note });

  for (const t of targets) {
    const app = appNames([t]);
    const was = previous[t];
    if (was === account.email) console.log(`${app} already uses ${account.email}.`);
    else if (was) console.log(`Switched ${app} from ${was} to ${account.email}.`);
    else console.log(`Switched ${app} to ${account.email}. It wasn't using a saved account before.`);
  }
  console.log(note);
}

async function cmdAdd({ flags }: Parsed) {
  const seconds = flags.timeout === undefined ? 300 : Number(flags.timeout);
  if (!Number.isFinite(seconds) || seconds <= 0) throw usage("--timeout takes a number of seconds, such as --timeout 300.");
  const openBrowser = flags.browser === true && flags["no-browser"] !== true;
  // With --json, stdout carries only the result; the prompts go to stderr.
  const say = (text: string) => (flags.json ? console.error(text) : console.log(text));

  say("Starting Google sign-in…");
  const result = await login({
    timeoutMs: seconds * 1000,
    onUrl: (url) => {
      if (openBrowser) openInBrowser(url);
      say(
        openBrowser
          ? "\nOpened the sign-in page in your default browser. To add the account from another browser profile, open this link there:\n"
          : "\nOpen this link in the browser profile of the account you want to add:\n",
      );
      say(url);
      say(`\nWaiting for you to approve. This stops after ${seconds} seconds.`);
    },
  });

  const missing = REQUIRED_SCOPES.filter((s) => !result.grantedScopes.includes(s)).map(scopeLabel);
  if (missing.length > 0) {
    throw new CliError(
      `${result.email} signed in without ${permissionText(missing)}, so it can't run agents. It wasn't saved. ` +
        "Run agy-switch add again and approve every permission.",
      1,
      "missing_permission",
      { missingScopes: missing },
    );
  }

  const { account, replaced } = upsertAccount({
    id: randomUUID(),
    email: result.email,
    name: result.name || result.email,
    acpToken: result.acpToken,
    accessToken: result.accessToken,
    idToken: result.idToken,
    expiresAt: result.expiresAt,
    grantedScopes: result.grantedScopes,
    quota: null,
    quotaCheckedAt: null,
    addedAt: new Date().toISOString(),
    lastUsedAt: null,
  });

  if (flags.json) return printJson({ added: account.email, replaced, canRunAgents: true });
  console.log(`\n${replaced ? "Updated" : "Added"} ${account.email}. It can run agents.`);
  console.log(`Switch to it with: agy-switch switch ${account.email}`);
}

function cmdRemove({ args, flags }: Parsed) {
  if (!args[0]) throw usage("remove needs an account, such as: agy-switch remove you@example.com");
  const accounts = readAccounts();
  const account = resolveAccount(args[0], accounts);
  const active = activeAccounts(accounts);
  removeAccount(account.id);

  const stillActive = (["t3", "agy"] as const).filter((t) => active[t] === account.email);
  if (flags.json) return printJson({ removed: account.email, stillActive });
  console.log(`Removed ${account.email} from your saved accounts.`);
  if (stillActive.length > 0) {
    console.log(`${appNames([...stillActive])} still use it until you switch to another account.`);
  }
  console.log("To revoke the access you approved at sign-in, go to https://myaccount.google.com/permissions");
}

function cmdAgent() {
  try {
    console.log(readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8"));
  } catch {
    throw new CliError("The agent manual, AGENTS.md, is missing from this install. Reinstall agy-switch.");
  }
}

function cmdDoctor({ flags }: Parsed) {
  const accounts = readAccounts();
  const harness = harnessBinary();
  const t3 = findAcpTokenPaths();
  const active = activeAccounts(accounts);
  const checks = [
    {
      name: "accounts",
      ok: true,
      detail: `${plural(accounts.length, "saved account")} in ${tildify(storePath())}`,
    },
    {
      name: "sign-in",
      ok: Boolean(harness),
      detail: harness
        ? "Antigravity server found, so add can sign in"
        : "Antigravity server not found, so add can't sign in. Install T3 Code and use Antigravity in it once, or set AGY_SWITCH_HARNESS to an agy_acp_server.par file.",
    },
    {
      name: "t3",
      ok: t3.length > 0,
      detail:
        t3.length > 0
          ? `Uses ${active.t3 ?? "an account that isn't saved here"} (${plural(t3.length, "sign-in file")} under ${tildify(t3AcpRoot())})`
          : `No Antigravity sign-in under ${tildify(t3AcpRoot())}. Sign in to Antigravity in T3 Code once.`,
    },
    {
      name: "agy",
      ok: true,
      detail: active.agy
        ? `Uses ${active.agy} (${tildify(agyTokenPath())})`
        : "Not using a saved account. Optional: switch --target agy sets it",
    },
  ];
  const ok = checks.every((c) => c.ok);
  if (!ok) process.exitCode = 1;
  if (flags.json) return printJson({ ok, checks });

  const labels: Record<string, string> = { accounts: "Accounts", "sign-in": "Sign-in", t3: "T3 Code", agy: "agy CLI" };
  table(checks.map((c) => [c.ok ? "ok" : "FAIL", labels[c.name], c.detail]));
}

const RUN: Record<string, (p: Parsed) => void | Promise<void>> = {
  current: cmdCurrent,
  list: cmdList,
  pick: cmdPick,
  quota: cmdQuota,
  switch: cmdSwitch,
  add: cmdAdd,
  remove: cmdRemove,
  doctor: cmdDoctor,
  agent: cmdAgent,
  help: () => console.log(HELP),
};

export async function main(argv: string[]) {
  try {
    const parsed = parseArgs(argv);
    await RUN[parsed.command](parsed);
  } catch (err) {
    const e = err instanceof CliError ? err : new CliError(errorText(err));
    if (argv.includes("--json")) printJson({ error: { code: e.code, message: e.message, ...e.extra } });
    else console.error(`agy-switch: ${e.message}`);
    process.exitCode = e.exitCode;
  }
}
