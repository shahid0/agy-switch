# agy-switch for AI agents

agy-switch switches the Google Antigravity account that T3 Code uses, and the
`agy` CLI if asked. You read the state, the user decides, and you switch only
when they ask.

## The one rule

**Never switch on your own.** Switch only when the user asks you to. If they
only mention a limit, report the quota and recommend an account. Don't build a
loop, a timer or automatic failover around this tool.

## Commands

Add `--json` to any command except `help` and `agent`. When the output isn't a
terminal, the JSON comes on one line.

| To | Run |
| :-- | :-- |
| See which account each app uses | `agy-switch current --json` |
| Find the account with the most quota | `agy-switch pick --json` |
| Find the account with the most quota on one model | `agy-switch pick --for claude --json` |
| See quota on every account | `agy-switch quota --json` |
| Switch T3 Code | `agy-switch switch <email> --json` |
| Switch T3 Code and the agy CLI | `agy-switch switch <email> --target both --json` |
| List saved accounts, as of the last quota read | `agy-switch list --json` |

An account can also be given as the start of its email, its name, or its number
in `list`. Prefer the full email: it can't match two accounts.

## Which account is in use?

```sh
$ agy-switch current --json
{"t3": "dev@example.com", "agy": null}
```

`null` means that app isn't using any saved account.

## Which account has the most quota?

```sh
$ agy-switch pick --json
{
  "rankedBy": "tightest limit across all model groups",
  "candidates": [
    {
      "email": "ben@example.com",
      "name": "Ben",
      "quotaLeft": 75,
      "limitedBy": "Claude and GPT models, 5h",
      "resetsAt": "2026-11-10T14:12:00Z",
      "active": {"t3": false, "agy": false},
      "lastUsedAt": "2026-11-07T09:00:00.000Z"
    }
  ],
  "next": "agy-switch switch <email> --json"
}
```

- `pick` reads quota live from Google and ranks best first. It never switches.
- It leaves out accounts that can't run agents. `--all` includes them.
- Google limits each model group over a 5-hour window and a weekly one.
  `quotaLeft` is the percent left on the tightest of them, `limitedBy` names
  it, and `resetsAt` says when it refills.
- `--for <model>` ranks by one model group. It understands names like `claude`,
  `gpt`, `gemini`, `"Gemini 3 Pro"` and `argon`. Claude and GPT models share one
  group.
- `quotaLeft: null` with a `quotaError` means Google couldn't be read for that
  account.

Choose by what the user said first, such as an account or a model they named.
Then quota, then `resetsAt`, then `lastUsedAt`.

## Switch

```sh
$ agy-switch switch ben@example.com --json
{
  "switchedTo": "ben@example.com",
  "target": "t3",
  "previous": {"t3": "dev@example.com"},
  "note": "Sessions already running keep the account they started with."
}
```

- The default target is `t3`, which is T3 Code. `--target agy` switches the agy
  CLI, and `--target both` switches both.
- `switch` refuses an account that can't run agents in T3 Code before it writes
  anything.

Then tell the user which account is now in use, which app changed and what it
used before (`previous`), and the note.

## How much quota does each account have?

```sh
$ agy-switch quota --json
[
  {
    "email": "ana@example.com",
    "ok": true,
    "groups": [
      {
        "name": "Claude and GPT models",
        "models": "Claude Opus, Claude Sonnet, GPT-OSS",
        "left": 90,
        "windows": [
          {"window": "weekly", "left": 95, "resetsAt": "2026-11-16T09:00:00Z"},
          {"window": "5h", "left": 90, "resetsAt": "2026-11-10T11:00:00Z"}
        ]
      }
    ]
  }
]
```

A group's `left` is its tightest window. Use this for questions like "how much
Claude quota is left?". It changes nothing.

## Accounts that can't run agents

Google grants the `aicode` permission only at sign-in, and Antigravity needs it
to run agents. An account signed in without it still shows quota and models,
but T3 Code can't use it. `list` and `pick --all` show `canRunAgents: false` and
`missingScopes: ["aicode"]`.

Only `agy-switch add` fixes this: the user signs in again in a browser and
approves every permission. No command can do that for them, so tell the user
instead of retrying.

## Errors

With `--json`, a failure prints `{"error": {"code": "…", "message": "…"}}` on
stdout. Without it, the message goes to stderr.

| Exit | `code` | What to do |
| :-: | :-- | :-- |
| 2 | `ambiguous` | `candidates` lists the matches. Ask the user which one they mean |
| 2 | `not_found` | Run `list` and check the account |
| 2 | `cannot_run_agents` | Tell the user the account needs `agy-switch add`. Don't quietly pick another one |
| 2 | `no_match` | `--for` matched no model group. `groups` lists them |
| 2 | `usage`, `no_accounts`, `none_can_run_agents` | Fix the command, or tell the user to add an account |
| 1 | `failed`, `no_t3_signin`, `missing_permission` | Report the message. Don't retry blindly |

Quote the message to the user. Never get around an error by switching to a
different account without saying so.

## Don't assume

- **That a switch reaches running sessions.** T3 Code reads the credential when
  it starts the Antigravity provider, and an `agy` session keeps the one it
  started with.
- **That `list` is live.** It shows the last quota read. `pick` and `quota` read
  live.
- **That every account can run agents.** Check `canRunAgents`.
- **That editing the files works the same.** Use the commands. The account file
  is written atomically, and a hand edit skips every check.

## Files

| What | Where |
| :-- | :-- |
| Saved accounts | `~/.agy-switch/accounts.json`, mode 0600 |
| T3 Code sign-in | `~/.t3/userdata/providers/antigravity/*/antigravity-acp/acp_token.json` |
| agy CLI sign-in | `~/.gemini/antigravity-cli/antigravity-oauth-token` |
| What `add` signs in with | The Antigravity server bundled with T3 Code, or the file in `AGY_SWITCH_HARNESS` |
