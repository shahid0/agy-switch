<img src="assets/icon.svg" width="64" height="64" alt="">

# agy-switch

Antigravity account manager for the `agy` CLI and T3 Code's ACP provider.
Its own account store, its own sign-in, its own quota reads — no dependency on
any other Antigravity app.

You or your agent pick the account. Nothing switches on its own.

## Install

Requires [Bun](https://bun.sh).

```sh
git clone <this repo> ~/.t3/projects/agy-switch
cd ~/.t3/projects/agy-switch
ln -sf "$PWD/bin/agy-switch.js" ~/.local/bin/agy-switch
agy-switch doctor
```

`add` needs the Antigravity ACP harness that ships with T3 Code. If it lives
elsewhere, point `AGY_SWITCH_HARNESS` at an `agy_acp_server.par`.

## Adding accounts

```sh
agy-switch add                # print an authorize URL, wait for the callback
agy-switch add --browser      # open it in the default browser instead
```

Then approve in the browser and the account lands in the store.

**Read this before adding 12 accounts.** Google only grants `auth/aicode` at
consent time, and that scope is what allows an account to drive Antigravity at
all. Without it the harness fails with `invalid_scope` and falls back to a
browser login. Accounts authorised by other tools that never request `aicode`
look perfectly healthy — quota reads fine, models list fine — and still cannot
be used. `agy-switch list` shows `ACP: yes/no` per account so this is never
guesswork.

No command can mint that grant without a human approving it. By design.

`--no-browser` (the default) prints the URL without opening it, so you can paste
it into the browser profile that should own the account.

## Commands

```sh
agy-switch add [--browser|--no-browser] [--timeout <s>] [--json]
agy-switch list [--json]                 # accounts, quota, ACP eligibility
agy-switch current [--json]              # which account each surface points at
agy-switch switch <who> [--target acp|agy|both] [--json]
agy-switch pick [--for <model>] [--include-ineligible] [--json]
agy-switch quota [<who>] [--json]        # live reads from Google
agy-switch remove <who>
agy-switch doctor [--json]
agy-switch help
```

`<who>` accepts an email, email prefix, display name, account id, or a 1-based
position from `list`.

### Who decides

The CLI has no timer, no daemon, and no policy. Nothing watches quota and
nothing switches on its own. `pick --json` returns ranked candidates plus a
`hint`; the caller weighs them and calls `switch`.

### switch refuses ineligible accounts

Switching to an account without the `aicode` grant would leave T3 showing
"signed out" with no explanation, so `switch` refuses before writing anything:

```
agy-switch: no-aicode@example.com cannot drive Antigravity: it is missing aicode.
```

Exit code 2, nothing written, your working session untouched.

### Targets

| Target | Path | Default |
| :--- | :--- | :--- |
| T3 ACP | `~/.t3/userdata/providers/antigravity/*/antigravity-acp/acp_token.json` | yes |
| `agy` CLI | `~/.gemini/antigravity-cli/antigravity-oauth-token` | `--target agy\|both` |

The first write to a path leaves a one-time `.bak` beside it.

## Store

`~/.agy-switch/accounts.json`, mode `0600`, written atomically (temp file +
rename). Each account keeps the credential verbatim, the granted scopes Google
reported, quota snapshots, and timestamps.

## Exit codes

| Code | Meaning |
| :--- | :--- |
| 0 | success |
| 1 | runtime error (sign-in failed, quota unreachable, harness missing) |
| 2 | usage error (bad flag, unknown/ambiguous account, not ACP-eligible) |

## How `add` works without reimplementing OAuth

`add` spawns the bundled `agy_acp_server.par` in an isolated `GEMINI_HOME`,
sends `initialize` then `authenticate`, reads the authorize URL off its stderr,
and waits for the harness to run the PKCE exchange on its localhost callback and
write `acp_token.json`. We then read that file and ask Google who the token is
for. The harness owns the OAuth exchange; this tool never handles your password
and never constructs the token itself.

## Development

```sh
bun test     # 15 tests, all sandboxed via a temp HOME
```

Paths resolve on access (`src/paths.ts`), never at import time, so an overridden
`HOME` is always honoured. A frozen module-level home directory previously let a
test write into a real credential file; that is the bug this design prevents.
