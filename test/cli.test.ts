import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, parseArgs, parseWait, resolveAccount } from "../src/cli.ts";
import { readKeychain, writeKeychain } from "../src/keychain.ts";
import type { Account } from "../src/store.ts";
import { ownKeychain } from "./keychain.ts";

const macOS = process.platform === "darwin";

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

/**
 * Google, faked: each account's Gemini Models 5h limit is `gemini5h[key]`, its
 * other limits 100%. The model list fails for the accounts in `noModels`.
 */
function fakeGoogle(gemini5h: Record<string, number>, noModels: string[] = []) {
  const full = { remainingFraction: 1, resetTime: "2026-11-13T13:00:00Z" };
  spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/token")) {
      const key = new URLSearchParams(String(init?.body)).get("refresh_token")!.slice("rt-".length);
      return Response.json({ access_token: `at-${key}`, expires_in: 3600 });
    }
    const key = new Headers(init?.headers).get("Authorization")!.slice("Bearer at-".length);
    const gemini = { remainingFraction: gemini5h[key], resetTime: "2026-11-13T12:30:00Z" };
    if (url.endsWith(":retrieveUserQuotaSummary")) {
      return Response.json({
        groups: [
          {
            displayName: "Gemini Models",
            description: "Models within this group: Gemini Flash, Gemini Pro",
            buckets: [{ bucketId: "gemini-5h", window: "5h", ...gemini }],
          },
          {
            displayName: "Claude and GPT models",
            description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
            buckets: [{ bucketId: "3p-5h", window: "5h", ...full }],
          },
        ],
      });
    }
    if (url.endsWith(":fetchAvailableModels")) {
      if (noModels.includes(key)) return new Response("", { status: 503 });
      return Response.json({
        models: {
          "gemini-4-hydrogen-high": { displayName: "Gemini 4 Hydrogen (High)", quotaInfo: gemini },
          "gemini-3.1-flash-image": { displayName: "Gemini 3.1 Flash Image", quotaInfo: gemini },
          "claude-opus-5-5-high": { displayName: "Claude Opus 5.5 (High)", quotaInfo: full },
        },
        imageGenerationModelIds: ["gemini-3.1-flash-image"],
      });
    }
    throw new Error(`unexpected request to ${url}`);
  }) as typeof fetch);
}

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

describe("parseWait", () => {
  test("reads a wait the way Google's quotaResetDelay writes it", () => {
    expect(parseWait("4h57m19s")).toBe(17_839_000);
    expect(parseWait("4h57m19.813291527s")).toBeCloseTo(17_839_813.29, 1);
    expect(parseWait("5h")).toBe(18_000_000);
    expect(parseWait("90m")).toBe(5_400_000);
  });

  test("rejects anything else, a wait of nothing, and one longer than a week", () => {
    for (const text of ["", "soon", "4 hours", "500ms", "0s", "-1h", "169h", "999999999999999h"]) expect(parseWait(text)).toBeNull();
    expect(parseWait("168h")).toBe(604_800_000);
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
  /** The agy folder in T3 Code's profile, where its Gemini runs read their sign-in. */
  const t3Dir = () => join(home, ".t3/userdata/providers/antigravity/i1/antigravity-acp");
  const t3File = () => join(t3Dir(), "antigravity-oauth-token");
  /** What T3 Code's old Antigravity server signed in with. */
  const t3Legacy = () => join(t3Dir(), "acp_token.json");
  const agyFile = () => join(home, ".gemini/antigravity-cli/antigravity-oauth-token");
  const holder = (path: string) => {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return raw.refresh_token ?? raw.token?.refresh_token;
  };
  /** Sign the agy CLI in through its file, as the account `key`, or as no saved account. */
  const agyUses = (key: string) => {
    mkdirSync(join(agyFile(), ".."), { recursive: true });
    writeFileSync(agyFile(), JSON.stringify({ token: { refresh_token: `rt-${key}` } }));
  };
  const goKeyring = (json: unknown) => `go-keyring-base64:${Buffer.from(JSON.stringify(json)).toString("base64")}`;
  /** The agy CLI's keychain sign-in, decoded the way go-keyring stores it. */
  const agyKeychain = () => {
    const value = readKeychain("gemini", "antigravity");
    expect(value).toStartWith("go-keyring-base64:");
    return JSON.parse(Buffer.from(value!.slice("go-keyring-base64:".length), "base64").toString("utf8"));
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agy-switch-cli-"));
    process.env.HOME = home;
    if (macOS) ownKeychain(home);
    const accounts = [account("ana"), account("ben"), account("cleo", { grantedScopes: SCOPES.slice(0, 2) })];
    mkdirSync(join(home, ".agy-switch"), { recursive: true });
    writeFileSync(join(home, ".agy-switch/accounts.json"), JSON.stringify({ version: 1, accounts }));
    mkdirSync(t3Dir(), { recursive: true });
    writeFileSync(t3File(), JSON.stringify({ token: { refresh_token: "rt-ana" } }));
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

  test("switch writes T3 Code and the agy CLI unless --target names one", async () => {
    await main(["switch", "ben", "--json"]);
    expect(JSON.parse(printed[0])).toMatchObject({ switchedTo: "ben@example.com", target: "both" });
    expect(holder(t3File())).toBe("rt-ben");
    expect(holder(agyFile())).toBe("rt-ben");

    await main(["switch", "ana", "--target", "t3", "--json"]);
    expect(holder(t3File())).toBe("rt-ana");
    expect(holder(agyFile())).toBe("rt-ben");
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

  test("switch signs T3 Code's Gemini runs in through the token file agy reads in its profile, even when there's none yet", async () => {
    rmSync(t3File());
    await main(["switch", "ben", "--target", "t3", "--json"]);
    expect(JSON.parse(printed[0]).previous).toEqual({ t3: null });
    expect(JSON.parse(readFileSync(t3File(), "utf8"))).toEqual({
      token: { access_token: "", token_type: "Bearer", refresh_token: "rt-ben", expiry: expect.any(String) },
      auth_method: "consumer",
      id_token_email: "ben@example.com",
    });
    expect(statSync(t3File()).mode & 0o777).toBe(0o600);
    // No acp_token.json made up, and no temporary file left behind.
    expect(readdirSync(t3Dir())).toEqual(["antigravity-oauth-token"]);
  });

  test("switch keeps acp_token.json in step where T3 Code's old Antigravity server left one, and keeps the first sign-ins it replaces", async () => {
    writeFileSync(t3Legacy(), JSON.stringify(account("ana").acpToken));
    await main(["switch", "ben", "--target", "t3", "--json"]);
    expect(holder(t3File())).toBe("rt-ben");
    expect(JSON.parse(readFileSync(t3Legacy(), "utf8"))).toEqual(account("ben").acpToken);
    expect(holder(`${t3File()}.bak`)).toBe("rt-ana");
    expect(holder(`${t3Legacy()}.bak`)).toBe("rt-ana");
  });

  test("current reads T3 Code's account from the token file its Gemini runs read, not acp_token.json", async () => {
    writeFileSync(t3Legacy(), JSON.stringify(account("ben").acpToken));
    await main(["current", "--json"]);
    expect(JSON.parse(printed[0]).t3).toBe("ana@example.com");
  });

  test("doctor fails while T3 Code's Gemini runs have no sign-in, and passes once switch writes one", async () => {
    // What T3 Code 0.1.12 found: only the old server's acp_token.json, which agy doesn't read.
    rmSync(t3File());
    writeFileSync(t3Legacy(), JSON.stringify(account("ana").acpToken));
    const t3Check = () => JSON.parse(printed.at(-1)!).checks.find((c: { name: string }) => c.name === "t3");

    await main(["doctor", "--json"]);
    expect(process.exitCode).toBe(1);
    expect(t3Check()).toEqual({
      name: "t3",
      ok: false,
      detail:
        "Gemini runs can't sign in: ~/.t3/userdata/providers/antigravity/i1/antigravity-acp/antigravity-oauth-token holds no sign-in. " +
        "Fix it with: agy-switch switch <account>",
    });

    await main(["switch", "ana", "--json"]);
    await main(["doctor", "--json"]);
    expect(t3Check()).toEqual({
      name: "t3",
      ok: true,
      detail: "Uses ana@example.com (1 sign-in file under ~/.t3/userdata/providers/antigravity)",
    });
  });

  test("switch without a T3 Code profile changes nothing and says how to make one", async () => {
    rmSync(join(home, ".t3"), { recursive: true });
    await main(["switch", "ben", "--json"]);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(printed[0]).error).toMatchObject({
      code: "no_t3_signin",
      message:
        "Couldn't find T3 Code's Antigravity profile under ~/.t3/userdata/providers/antigravity. " +
        "Use Antigravity in T3 Code once, then try again. Nothing was changed.",
    });
    expect(existsSync(agyFile())).toBe(false);
  });

  test.skipIf(!macOS)("switch --target agy writes the agy CLI's keychain item and its file, in the CLI's format", async () => {
    await main(["switch", "ben", "--target", "agy", "--json"]);
    const signIn = {
      token: { access_token: "", token_type: "Bearer", refresh_token: "rt-ben", expiry: expect.any(String) },
      auth_method: "consumer",
      id_token_email: "ben@example.com",
    };
    expect(agyKeychain()).toEqual(signIn);
    expect(JSON.parse(readFileSync(agyFile(), "utf8"))).toEqual(signIn);
    expect(holder(t3File())).toBe("rt-ana");
  });

  test.skipIf(!macOS)("current reads the agy CLI's keychain before its file, and switch keeps the first unsaved sign-in it replaces", async () => {
    agyUses("ana");
    await main(["current", "--json"]);
    expect(JSON.parse(printed[0]).agy).toBe("ana@example.com");

    // The CLI's own login, to an account that isn't saved here.
    const ownLogin = goKeyring({ token: { refresh_token: "rt-own-login" }, auth_method: "consumer", writer_id: "w" });
    writeKeychain("gemini", "antigravity", ownLogin);
    await main(["current", "--json"]);
    expect(JSON.parse(printed[1]).agy).toBeNull();

    await main(["switch", "ben", "--target", "agy", "--json"]);
    expect(JSON.parse(printed[2]).previous).toEqual({ agy: null });
    await main(["switch", "ana", "--target", "agy", "--json"]);
    expect(JSON.parse(printed[3]).previous).toEqual({ agy: "ben@example.com" });
    await main(["current", "--json"]);
    expect(JSON.parse(printed[4]).agy).toBe("ana@example.com");

    const bak = join(home, ".agy-switch/agy-cli-keychain.bak");
    expect(readFileSync(bak, "utf8")).toBe(ownLogin);
    expect(statSync(bak).mode & 0o777).toBe(0o600);
  });

  test.skipIf(!macOS)("switch keeps no copy of a saved account's keychain sign-in", async () => {
    await main(["switch", "ben", "--target", "agy", "--json"]);
    await main(["switch", "ana", "--target", "agy", "--json"]);
    expect(JSON.parse(printed[1]).previous).toEqual({ agy: "ben@example.com" });
    expect(existsSync(join(home, ".agy-switch/agy-cli-keychain.bak"))).toBe(false);
  });

  test.skipIf(!macOS)("a switch the keychain refuses changes nothing", async () => {
    writeFileSync(
      join(home, ".agy-switch/accounts.json"),
      JSON.stringify({ version: 1, accounts: [account("ana"), account("ben", { accessToken: "a".repeat(4000) })] }),
    );
    await main(["switch", "ben", "--target", "both", "--json"]);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(printed[0]).error.message).toBe(
      "Couldn't write the agy CLI's sign-in to your keychain. Nothing was changed. Details: The sign-in is too long for the keychain.",
    );
    expect(readKeychain("gemini", "antigravity")).toBeNull();
    expect(existsSync(agyFile())).toBe(false);
    expect(holder(t3File())).toBe("rt-ana");
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

  test("quota names each group's models and lists image generation, whose own limit Google doesn't report", async () => {
    fakeGoogle({ ana: 0.36 });
    await main(["quota", "ana", "--json"]);
    expect(JSON.parse(printed[0])[0].groups).toEqual([
      {
        name: "Gemini Models",
        models: "Gemini 4 Hydrogen",
        left: 36,
        windows: [{ window: "5h", left: 36, resetsAt: "2026-11-13T12:30:00Z" }],
      },
      {
        name: "Claude and GPT models",
        models: "Claude Opus 5.5",
        left: 100,
        windows: [{ window: "5h", left: 100, resetsAt: "2026-11-13T13:00:00Z" }],
      },
      {
        name: "Image generation",
        models: "Gemini 3.1 Flash Image",
        sharesLimitsWith: "Gemini Models",
        left: null,
        windows: [],
        note: expect.stringContaining("Google doesn't report image generation's own limit"),
      },
    ]);
  });

  test("ran-out image records the limit for the account in use, and pick --for image ranks it last", async () => {
    agyUses("ana");
    await main(["ran-out", "image", "--resets-in", "4h57m19.81s", "--json"]);
    const recorded = JSON.parse(printed[0]);
    expect(recorded).toMatchObject({ ranOut: "Image generation", account: "ana@example.com" });
    expect(Date.parse(recorded.resetsAt) - Date.now()).toBeWithin(17_830_000, 17_840_000);

    printed = [];
    fakeGoogle({ ana: 0.6, ben: 0.2 });
    await main(["pick", "--for", "image", "--json"]);
    expect(JSON.parse(printed[0]).candidates.map((c: { email: string; quotaLeft: number; limitedBy: string; resetsAt: string }) => [c.email, c.quotaLeft, c.limitedBy, c.resetsAt])).toEqual([
      ["ben@example.com", 20, "Gemini Models, 5h", "2026-11-13T12:30:00Z"],
      ["ana@example.com", 0, "Image generation", recorded.resetsAt],
    ]);

    printed = [];
    await main(["quota", "ana", "--json"]);
    expect(JSON.parse(printed[0])[0].groups.at(-1)).toMatchObject({
      name: "Image generation",
      left: 0,
      windows: [{ window: "own limit", left: 0, resetsAt: recorded.resetsAt }],
    });
  });

  test("a recorded image limit stops counting once it resets", async () => {
    const past = { resetsAt: "2026-01-01T00:00:00.000Z", recordedAt: "2025-12-31T19:00:00.000Z" };
    writeFileSync(
      join(home, ".agy-switch/accounts.json"),
      JSON.stringify({ version: 1, accounts: [account("ana", { imageLimit: past }), account("ben")] }),
    );
    fakeGoogle({ ana: 0.6, ben: 0.2 });
    await main(["pick", "--for", "image", "--json"]);
    expect(JSON.parse(printed[0]).candidates.map((c: { email: string; quotaLeft: number }) => [c.email, c.quotaLeft])).toEqual([
      ["ana@example.com", 60],
      ["ben@example.com", 20],
    ]);
  });

  test("pick --for image still ranks accounts whose model list didn't come back, recorded limits included", async () => {
    const soon = { resetsAt: new Date(Date.now() + 3_600_000).toISOString(), recordedAt: new Date().toISOString() };
    writeFileSync(
      join(home, ".agy-switch/accounts.json"),
      JSON.stringify({ version: 1, accounts: [account("ana"), account("ben"), account("dan", { imageLimit: soon })] }),
    );
    fakeGoogle({ ana: 0.5, ben: 0.6, dan: 0.9 }, ["ben", "dan"]);
    await main(["pick", "--for", "image", "--json"]);
    expect(JSON.parse(printed[0]).candidates.map((c: { email: string; quotaLeft: number; limitedBy: string }) => [c.email, c.quotaLeft, c.limitedBy])).toEqual([
      ["ben@example.com", 60, "Gemini Models, 5h"],
      ["ana@example.com", 50, "Gemini Models, 5h"],
      ["dan@example.com", 0, "Image generation"],
    ]);
  });

  test("a recorded image limit stays out of list and the saved snapshot", async () => {
    agyUses("ana");
    await main(["ran-out", "image", "--resets-in", "2h", "--json"]);
    printed = [];
    fakeGoogle({ ana: 0.5, ben: 0.6 });
    await main(["list", "--json"]);
    expect(JSON.parse(printed[0])[0]).toMatchObject({ email: "ana@example.com", quota: { left: 50, limitedBy: "Gemini Models, 5h" } });
    const saved = JSON.parse(readFileSync(join(home, ".agy-switch/accounts.json"), "utf8")).accounts[0];
    expect(saved.quota.models.map((b: { name: string }) => b.name)).toEqual(["gemini-5h", "3p-5h"]);
  });

  test("ran-out records the account it's given, and asks for one when T3 Code and the agy CLI use different accounts", async () => {
    await main(["ran-out", "image", "ben", "--resets-in", "1h", "--json"]);
    expect(JSON.parse(printed[0]).account).toBe("ben@example.com");
    const accounts = JSON.parse(readFileSync(join(home, ".agy-switch/accounts.json"), "utf8")).accounts;
    expect(accounts.map((a: Account) => [a.email, Boolean(a.imageLimit)])).toEqual([
      ["ana@example.com", false],
      ["ben@example.com", true],
      ["cleo@example.com", false],
    ]);

    agyUses("unsaved");
    await main(["ran-out", "image", "--resets-in", "1h", "--json"]);
    expect(process.exitCode).toBe(2);
    expect(JSON.parse(printed[1]).error.message).toBe(
      "T3 Code uses ana@example.com and the agy CLI uses an account that isn't saved here. " +
        "Name the account whose image call failed, such as: agy-switch ran-out image ana@example.com --resets-in 4h57m19s",
    );
  });

  test("ran-out records only image generation, and needs the wait", async () => {
    await main(["ran-out", "claude", "--resets-in", "1h", "--json"]);
    expect(process.exitCode).toBe(2);
    expect(JSON.parse(printed[0]).error.code).toBe("usage");
    await main(["ran-out", "image", "--resets-in", "soon", "--json"]);
    expect(JSON.parse(printed[1]).error.message).toBe("--resets-in takes the wait from the failed call, such as --resets-in 4h57m19s.");
  });

  test("pick --for image ranks by the Gemini Models limits that image generation shares", async () => {
    fakeGoogle({ ana: 0.2, ben: 0.6 });
    await main(["pick", "--for", "image", "--json"]);
    const out = JSON.parse(printed[0]);
    expect(out.rankedBy).toBe("Image generation");
    expect(out.candidates.map((c: { email: string; quotaLeft: number; limitedBy: string }) => [c.email, c.quotaLeft, c.limitedBy])).toEqual([
      ["ben@example.com", 60, "Gemini Models, 5h"],
      ["ana@example.com", 20, "Gemini Models, 5h"],
    ]);
    expect(out.note).toStartWith("Google doesn't report image generation's own limit");
  });

  test("pick --for hydrogen ranks by Gemini Models, the group Hydrogen is in", async () => {
    fakeGoogle({ ana: 0.2, ben: 0.6 });
    await main(["pick", "--for", "hydrogen", "--json"]);
    const out = JSON.parse(printed[0]);
    expect(out.rankedBy).toBe("Gemini Models");
    expect(out.candidates.map((c: { email: string }) => c.email)).toEqual(["ben@example.com", "ana@example.com"]);
    expect(out.note).toBeUndefined();
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
