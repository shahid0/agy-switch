# agy-switch for AI agents

agy-switch switches the Google Antigravity account that T3 Code uses, and the
`agy` CLI if asked. It's there so you can keep working without the user,
overnight too, when an account runs low on quota.

## When to switch

Switch on your own, without asking, when the account in use doesn't have the
quota for the work ahead.

You can switch in the middle of a batch too. Sessions already running keep the
account they started with. Sessions started after a switch use the new account.

Rank by the quota your runs use: `--for hydrogen` for Hydrogen runs,
`--for argon` for Argon runs, `--for image` for image generation, `--for claude`
for Claude runs.

1. Before a batch of runs, check the quota they use:
   `agy-switch pick --for <model> --json`.
2. If the account in use (`active.t3: true`) can't cover the batch, switch to
   the best candidate before you start (see Switch).
3. If it runs low partway through, switch before you start the next run.
4. If a run still stops on a quota limit, switch and run it again. When an
   image call fails on quota, record it with
   `agy-switch ran-out image --resets-in <wait>`, then switch.
5. In your next message or report, say which account is in use now and what it
   replaced.

## Commands

Add `--json` to any command except `help` and `agent`. When the output isn't a
terminal, the JSON comes on one line.

| To | Run |
| :-- | :-- |
| See which account each app uses | `agy-switch current --json` |
| Find the account with the most quota | `agy-switch pick --json` |
| Find the account with the most quota for one kind of run | `agy-switch pick --for hydrogen --json` |
| See quota on every account | `agy-switch quota --json` |
| Switch T3 Code | `agy-switch switch <email> --json` |
| Switch T3 Code and the agy CLI | `agy-switch switch <email> --target both --json` |
| Record that image generation ran out | `agy-switch ran-out image --resets-in <wait> --json` |
| List saved accounts with live quota | `agy-switch list --json` |

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
- Google limits each model group over a 5-hour window, a weekly one, or both.
  `quotaLeft` is the percent left on the tightest of them, `limitedBy` names
  it, and `resetsAt` says when it refills.
- `--for <model>` ranks by one model group. It understands names like
  `hydrogen`, `argon`, `image`, `claude`, `gpt`, `gemini` and `"Gemini 3 Pro"`,
  and model ids like `gemini-4-hydrogen-high`.
- With `--for image`, `note` says what the ranking can't see.
- `quotaLeft: null` with a `quotaError` means Google couldn't be read for that
  account.

Choose by what the user said first, such as an account or a model they named.
Then quota, then `resetsAt`, then `lastUsedAt`.

## Which `--for` to use

| Work | Run | Ranks by |
| :-- | :-- | :-- |
| Hydrogen runs | `pick --for hydrogen` | Gemini Models, the limits every Gemini Flash and Gemini Pro model shares |
| Argon runs | `pick --for argon` | Gemini 4 Argon, Argon's own weekly limit |
| Image generation | `pick --for image` | The Gemini Models limits, which image generation uses too |
| Claude runs | `pick --for claude` | Claude and GPT models, the limits Claude and GPT-OSS share |

Image generation also has a limit of its own, which Google doesn't report. So
an image call can fail with `429 RESOURCE_EXHAUSTED` even on the account
`--for image` ranks first. In one test, 13 images used up an account's image
limit in about 5 minutes while its Gemini Models group still had 36% left.

When an image call fails on quota, record it with
`agy-switch ran-out image --resets-in <wait>`, then switch. `<wait>` is the
error's `quotaResetDelay`, or the time in "Your quota will reset after
4h57m19s". Run it before you switch: it records the account T3 Code uses, or
the account you name after `image`.

```sh
$ agy-switch ran-out image --resets-in 4h57m19s --json
{
  "ranOut": "Image generation",
  "account": "dev@example.com",
  "resetsAt": "2026-11-13T13:10:35.000Z",
  "next": "agy-switch pick --for image --json"
}
```

Until it resets, `pick --for image` ranks that account last, with
`quotaLeft: 0` and `limitedBy: "Image generation"`. Then run only the missing
images again.

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
        "name": "Gemini Models",
        "models": "Gemini 2.5 Pro, Gemini 3 Flash, Gemini 3.8 Flash, Gemini 4 Hydrogen",
        "left": 36,
        "windows": [
          {"window": "weekly", "left": 77, "resetsAt": "2026-11-17T07:45:00Z"},
          {"window": "5h", "left": 36, "resetsAt": "2026-11-13T12:30:00Z"}
        ]
      },
      {
        "name": "Claude and GPT models",
        "models": "Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B",
        "left": 90,
        "windows": [
          {"window": "weekly", "left": 95, "resetsAt": "2026-11-16T09:00:00Z"},
          {"window": "5h", "left": 90, "resetsAt": "2026-11-13T11:00:00Z"}
        ]
      },
      {
        "name": "Gemini 4 Argon",
        "models": "Gemini 4 Argon",
        "left": 99,
        "windows": [
          {"window": "weekly", "left": 99, "resetsAt": "2026-11-17T06:31:00Z"}
        ]
      },
      {
        "name": "Image generation",
        "models": "Gemini 3.1 Flash Image",
        "sharesLimitsWith": "Gemini Models",
        "left": null,
        "windows": [],
        "note": "Google doesn't report image generation's own limit. When an image call fails on quota, …"
      }
    ]
  }
]
```

- A group's `left` is its tightest window. Use this for questions like "how
  much Claude quota is left?". It changes nothing.
- `models` lists the models in the group, as Google names them.
- `sharesLimitsWith` names a group whose limits apply too. Image generation's
  `left` is `null` because Google doesn't report its own limit. After
  `ran-out image`, it has an `own limit` window at 0% until it resets.

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

- **That a switch reaches sessions already running.** Sessions already running
  keep the account they started with, in T3 Code and in the agy CLI. Sessions
  started after a switch use the new account.
- **That every account can run agents.** Check `canRunAgents`.
- **That Google reports every limit.** It doesn't report image generation's own
  limit. See Which `--for` to use.
- **That editing the files works the same.** Use the commands. The account file
  is written atomically, and a hand edit skips every check.

## Files

| What | Where |
| :-- | :-- |
| Saved accounts | `~/.agy-switch/accounts.json`, mode 0600 |
| T3 Code sign-in | `~/.t3/userdata/providers/antigravity/*/antigravity-acp/acp_token.json` |
| agy CLI sign-in | `~/.gemini/antigravity-cli/antigravity-oauth-token` |
| What `add` signs in with | The Antigravity server bundled with T3 Code, or the file in `AGY_SWITCH_HARNESS` |
