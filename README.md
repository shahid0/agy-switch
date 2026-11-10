<img src="assets/icon.svg" width="64" height="64" alt="">

# agy-switch

Switch the Google Antigravity account that T3 Code uses, and the `agy` CLI if
you want, with one command. You can run it yourself or let an AI agent drive it.

Switching by hand means signing in again in a browser and copying token files
between folders. agy-switch keeps your accounts, reads their quota from Google,
and switches when you tell it to. It never switches on its own.

agy-switch isn't affiliated with Google or T3 Code.

## Install

You need [Bun](https://bun.sh), and T3 Code with its Antigravity provider signed
in once.

```sh
git clone https://github.com/shahid0/agy-switch.git
cd agy-switch
ln -s "$PWD/bin/agy-switch.js" ~/.local/bin/agy-switch   # or any folder on your PATH
agy-switch doctor
```

## Quick start

```sh
agy-switch add                       # sign in with Google and save the account
agy-switch list                      # saved accounts and their quota
agy-switch pick                      # rank accounts by live quota
agy-switch switch ben@example.com    # make T3 Code use this account
```

## Commands

| Command | What it does |
| :-- | :-- |
| `current` | Shows which account T3 Code and the agy CLI use now |
| `list` | Lists saved accounts, their live quota left, and which can run agents |
| `pick [--for <model>] [--all]` | Ranks accounts by live quota left. Doesn't switch |
| `quota [<account>]` | Reads live quota for one account, or all of them |
| `switch <account> [--target t3\|agy\|both]` | Makes T3 Code use the account, or the agy CLI, or both |
| `add [--browser] [--timeout <seconds>]` | Signs in with Google and saves the account |
| `remove <account>` | Deletes a saved account |
| `doctor` | Checks your setup |
| `agent` | Prints the manual for AI agents |

`<account>` is an email, the start of one, a name, or a number from `list`. Add
`--json` to any command except `help` and `agent` for JSON output.

## Using it from an AI agent

`agy-switch agent` prints a manual written for agents, the same text as
[AGENTS.md](AGENTS.md). It covers the JSON each command returns, what each error
code means, and what to tell the user. The short version:

```sh
agy-switch pick --json               # live ranking, best first
agy-switch switch <email> --json     # only when the user asks
```

## Signing in

`add` prints a Google sign-in link. Open it in the browser profile of the
account you want to add, and approve every permission. `--browser` opens the
link in your default browser instead.

Sign-in runs through the Antigravity server that ships with T3 Code
(`agy_acp_server.par`), so agy-switch never sees your password and doesn't run
the sign-in exchange itself. If that file lives somewhere else, set
`AGY_SWITCH_HARNESS` to its path.

### Why some accounts can't run agents

Google grants the `aicode` permission only when you approve it at sign-in, and
Antigravity needs it to run agents. Accounts signed in through other tools often
lack it: they show quota and models, then fail in T3 Code. `list` shows which
accounts can run agents, and `switch` refuses the ones that can't before it
changes anything. To fix one, add it again with `agy-switch add`.

## Where things live

| What | Where |
| :-- | :-- |
| Saved accounts and their sign-in tokens | `~/.agy-switch/accounts.json`, readable only by you (mode 0600) |
| T3 Code sign-in | `~/.t3/userdata/providers/antigravity/*/antigravity-acp/acp_token.json` |
| agy CLI sign-in | `~/.gemini/antigravity-cli/antigravity-oauth-token` |

The first time agy-switch writes over a sign-in file, it keeps the old one beside
it with a `.bak` ending.

agy-switch connects only to Google, for sign-in, account details and quota.
Quota comes from Google's internal Antigravity endpoints, which can change
without notice.

## Exit codes

| Code | Meaning |
| :-: | :-- |
| 0 | Done |
| 1 | Something failed: network, sign-in or setup |
| 2 | The command needs fixing: an unknown account or flag, or an account that can't run agents |

## Development

```sh
bun install          # dev tools only; agy-switch has no runtime dependencies
bun test
bun run typecheck
```

Tests set `HOME` to a temporary folder, so they don't touch your real accounts.

## License

MIT
