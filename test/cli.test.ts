import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, parseArgs, resolveAccount } from "../src/cli.ts";
import type { Account } from "../src/store.ts";

const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/aicode",
];

const account = (key: string, over: Partial<Account> = {}): Account => ({
  id: `id-${key}`,
  email: `${key}@example.com`,
  name: key,
  acpToken: {
    client_id: "cid",
    client_secret: "secret",
    refresh_token: `rt-${key}`,
    token_uri: "https://oauth2.googleapis.com/token",
    scopes: [],
  },
  grantedScopes: SCOPES,
  quota: null,
  quotaCheckedAt: null,
  addedAt: "2026-01-01T00:00:00.000Z",
  lastUsedAt: null,
  ...over,
});

describe("parseArgs", () => {
  test("a flag before the account doesn't swallow it", () => {
    expect(parseArgs(["switch", "--json", "ben"])).toEqual({ command: "switch", args: ["ben"], flags: { json: true } });
  });

  test("accepts --flag=value", () => {
    expect(parseArgs(["switch", "ben", "--target=both"]).flags.target).toBe("both");
  });

  test("rejects a flag the command doesn't take, and names the ones it does", () => {
    expect(() => parseArgs(["pick", "--target", "t3"])).toThrow("pick doesn't take --target. It takes --json, --for, --all.");
  });

  test("rejects a value flag with no value", () => {
    expect(() => parseArgs(["pick", "--for"])).toThrow("--for needs a value.");
    expect(() => parseArgs(["pick", "--for", "--json"])).toThrow("--for needs a value.");
  });

  test("rejects extra arguments", () => {
    expect(() => parseArgs(["switch", "a", "b"])).toThrow('Didn\'t expect "b" after switch.');
  });

  test("maps aliases, --help and no arguments", () => {
    expect(parseArgs(["use", "ben"]).command).toBe("switch");
    expect(parseArgs(["switch", "--help"]).command).toBe("help");
    expect(parseArgs([]).command).toBe("help");
  });

  test("rejects an unknown command", () => {
    expect(() => parseArgs(["swich"])).toThrow('Unknown command "swich".');
  });
});

describe("resolveAccount", () => {
  const accounts = [
    account("ana", { name: "Ana Work" }),
    account("ana.personal", { name: "Ana Personal" }),
    account("ben", { name: "Ben" }),
  ];

  test("matches an email exactly, ignoring case", () => {
    expect(resolveAccount("ANA@example.com", accounts).email).toBe("ana@example.com");
  });

  test("matches a name, a unique prefix, or a number from list", () => {
    expect(resolveAccount("ana personal", accounts).email).toBe("ana.personal@example.com");
    expect(resolveAccount("be", accounts).email).toBe("ben@example.com");
    expect(resolveAccount("3", accounts).email).toBe("ben@example.com");
  });

  test("an ambiguous prefix lists the candidates instead of guessing", () => {
    expect(() => resolveAccount("ana", accounts)).toThrow(
      '"ana" matches 2 accounts: ana@example.com, ana.personal@example.com. Use the full email.',
    );
  });

  test("an unknown account says how to see the saved ones", () => {
    expect(() => resolveAccount("zed", accounts)).toThrow('No saved account matches "zed". See your accounts with: agy-switch list');
  });
});

describe("commands", () => {
  let home: string;
  let printed: string[];
  const t3File = () => join(home, ".t3/userdata/providers/antigravity/i1/antigravity-acp/acp_token.json");
  const agyFile = () => join(home, ".gemini/antigravity-cli/antigravity-oauth-token");
  const holder = (path: string) => {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return raw.refresh_token ?? raw.token?.refresh_token;
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agy-switch-cli-"));
    process.env.HOME = home;
    const accounts = [account("ana"), account("ben"), account("cleo", { grantedScopes: SCOPES.slice(0, 2) })];
    mkdirSync(join(home, ".agy-switch"), { recursive: true });
    writeFileSync(join(home, ".agy-switch/accounts.json"), JSON.stringify({ version: 1, accounts }));
    mkdirSync(join(t3File(), ".."), { recursive: true });
    writeFileSync(t3File(), JSON.stringify(accounts[0].acpToken));
    printed = [];
    spyOn(console, "log").mockImplementation((line) => void printed.push(String(line)));
    spyOn(console, "error").mockImplementation((line) => void printed.push(String(line)));
  });

  afterEach(() => {
    mock.restore();
    process.exitCode = 0;
  });

  test("refuses an account that can't run agents, with exit code 2, and writes nothing", async () => {
    await main(["switch", "cleo", "--json"]);
    expect(process.exitCode).toBe(2);
    expect(JSON.parse(printed[0]).error).toMatchObject({ code: "cannot_run_agents", missingScopes: ["aicode"] });
    expect(holder(t3File())).toBe("rt-ana");
  });

  test("--target both writes T3 Code and the agy CLI, and reports what each used before", async () => {
    await main(["switch", "ben", "--target", "both", "--json"]);
    expect(JSON.parse(printed[0])).toMatchObject({
      switchedTo: "ben@example.com",
      target: "both",
      previous: { t3: "ana@example.com", agy: null },
    });
    expect(holder(t3File())).toBe("rt-ben");
    expect(holder(agyFile())).toBe("rt-ben");
  });

  test("an ambiguous account in --json mode returns the candidates as data", async () => {
    writeFileSync(
      join(home, ".agy-switch/accounts.json"),
      JSON.stringify({
        version: 1,
        accounts: [account("ana", { name: "Ana Work" }), account("ana.personal", { name: "Ana Personal" })],
      }),
    );
    await main(["switch", "ana", "--json"]);
    expect(process.exitCode).toBe(2);
    expect(JSON.parse(printed[0]).error).toMatchObject({
      code: "ambiguous",
      candidates: ["ana@example.com", "ana.personal@example.com"],
    });
  });

  test("quota reads Google's model groups live and saves them", async () => {
    spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/token")) return Response.json({ access_token: "at", expires_in: 3600 });
      if (url.endsWith(":retrieveUserQuotaSummary")) {
        return Response.json({
          groups: [
            {
              displayName: "Claude and GPT models",
              description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
              buckets: [
                { bucketId: "3p-weekly", window: "weekly", remainingFraction: 0.95, resetTime: "2026-11-16T09:00:00Z" },
                { bucketId: "3p-5h", window: "5h", remainingFraction: 0.9, resetTime: "2026-11-10T11:00:00Z" },
              ],
            },
          ],
        });
      }
      throw new Error(`unexpected request to ${url}`);
    }) as typeof fetch);

    await main(["quota", "ana", "--json"]);
    expect(JSON.parse(printed[0])).toEqual([
      {
        email: "ana@example.com",
        ok: true,
        groups: [
          {
            name: "Claude and GPT models",
            models: "Claude Opus, Claude Sonnet, GPT-OSS",
            left: 90,
            windows: [
              { window: "weekly", left: 95, resetsAt: "2026-11-16T09:00:00Z" },
              { window: "5h", left: 90, resetsAt: "2026-11-10T11:00:00Z" },
            ],
          },
        ],
      },
    ]);
    const saved = JSON.parse(readFileSync(join(home, ".agy-switch/accounts.json"), "utf8")).accounts[0];
    expect(saved.quota.models.map((b: { name: string }) => b.name)).toEqual(["3p-weekly", "3p-5h"]);
    expect(saved.quotaCheckedAt).toBeTruthy();
  });

  test("list falls back to the last snapshot, and says how old it is, when Google can't be reached", async () => {
    const snapshot = { name: "3p-5h", percentage: 40, reset_time: "", group: "Claude and GPT models", window: "5h" };
    writeFileSync(
      join(home, ".agy-switch/accounts.json"),
      JSON.stringify({
        version: 1,
        accounts: [account("ana", { quota: { models: [snapshot] }, quotaCheckedAt: "2026-11-10T00:00:00.000Z" })],
      }),
    );
    spyOn(globalThis, "fetch").mockImplementation((async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch);

    await main(["list", "--json"]);
    expect(JSON.parse(printed[0])[0]).toMatchObject({
      email: "ana@example.com",
      quota: { left: 40, limitedBy: "Claude and GPT models, 5h" },
      quotaError: "Couldn't reach Google. Check your internet connection.",
      quotaCheckedAt: "2026-11-10T00:00:00.000Z",
    });
  });
});
