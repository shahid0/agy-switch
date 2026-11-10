# What this is

`agy-switch` manages Google Antigravity accounts for **T3 Code's ACP provider**
(and, optionally, the `agy` CLI). It exists because switching accounts by hand
means re-authorising in a browser and copying token files between paths — slow,
error-prone, and impossible to do when you're not at the machine.

It is the plumbing an agent needs to answer three questions and act on them:

1. Which accounts do I have, and which one is active right now?
2. Which account has headroom for the work I'm about to do?
3. Make account X active, and tell me what changed.

It has its own account store, its own sign-in, and reads quota straight from
Google. It does not depend on any other Antigravity app.

---

## The one rule that matters

**This tool never switches on its own.** There is no timer, no daemon, no polling
loop, no automatic failover. It reports state and executes an explicit
`switch <who>` you (or the agent) chooses. The decision belongs to the caller.

If you are an agent reading this: **do not** invent a rotation loop around it.
The expected pattern is *read → decide → switch*, with the decision made
deliberately, not on a schedule.

---

## Critical background: `aicode`

Google grants an OAuth scope called `https://www.googleapis.com/auth/aicode` at
**consent time only**. It is the entitlement that lets an account drive
Antigravity at all.

Without it, the ACP harness fails with `invalid_scope` and falls back to an
interactive browser login. The account still looks fine — quota reads work,
models list works — and it simply cannot be used to run an agent.

The consequences you must respect:

- **The `scopes` array inside a token file is decorative.** Google validates
  against what you actually consented to. Editing that array achieves nothing.
- **Accounts authorised by other tools are often ineligible**, because those
  tools never requested `aicode`.
- **Only `agy-switch add` fixes it**, because it runs a real sign-in requesting
  that scope.
- **An account must be added by a human approving a browser prompt.** No command
  can mint the grant.

`agy-switch list` reports `ACP: yes` or `ACP: no (missing …)` per account. Trust
that column, never your assumption.

---

## Commands

Every command supports `--json` except `remove` and `help`.

| Command | What it gives you |
| :--- | :--- |
| `agy-switch list --json` | every account, quota, eligibility, active flags |
| `agy-switch current --json` | which stored account each surface holds |
| `agy-switch pick --json` | ranked candidates, best first — a query, not a decision |
| `agy-switch quota [<who>] --json` | fresh quota read from Google |
| `agy-switch switch <who> --json` | make an account active, report what changed |
| `agy-switch add [--browser]` | interactive sign-in; needs a human |
| `agy-switch remove <who>` | delete from the store |
| `agy-switch doctor --json` | environment checks |

`<who>` accepts an email, an email prefix, a display name, an account id, or a
1-based position from `list`.

### Exit codes

| Code | Meaning | What an agent should do |
| :--- | :--- | :--- |
| 0 | success | continue |
| 1 | runtime error (sign-in failed, quota unreachable, harness missing) | report it; don't retry blindly |
| 2 | usage error (bad flag, unknown/ambiguous account, **not ACP-eligible**) | fix the input or choose another account |

---

## The three jobs, concretely

### Job 1 — "who am I running as right now?"

```sh
agy-switch current --json
```

```json
{
  "acp": "work@example.com",
  "agy": null
}
```

Use this before attributing work to an account, or when the user asks "which
account is this?".

### Job 2 — "which account should I switch to?"

```sh
agy-switch pick --json
```

```json
{
  "rankedBy": "worst remaining quota",
  "candidates": [
    {
      "index": 1,
      "id": "…",
      "email": "personal@example.com",
      "name": "personal",
      "score": 100,
      "acpEligible": true,
      "missingScopes": [],
      "excluded": null
    }
  ],
  "hint": "call `agy-switch switch <email> --json` to apply your choice"
}
```

`pick` excludes ineligible accounts and sorts best-first. It **returns options
and stops** — it never applies anything. Weigh the candidates yourself (quota,
reset time, `lastUsedAt`, or which account the user named) and then call
`switch`.

Use `--for <model>` to rank by one specific model's headroom instead of the worst
across all models. Use `--include-ineligible` only when you're diagnosing why an
account is missing from the list.

### Job 3 — "switch to it"

```sh
agy-switch switch personal --json
```

```json
{
  "switchedTo": "personal@example.com",
  "id": "…",
  "target": "acp",
  "acpPaths": ["/Users/…/antigravity-acp/acp_token.json"]
}
```

Default target is `acp`. Add `--target agy` or `--target both` to also write the
`agy` CLI credential.

**`switch` refuses an ineligible account** with exit code 2, before writing
anything, so a working session is never broken by a bad choice.

---

## When quota might be stale

`pick` and `list` rank on the **last quota snapshot in the store**, which may be
minutes or hours old. If accuracy matters — you're about to run something long,
or an account may have been used since — refresh first:

```sh
agy-switch quota --json     # live reads from Google, updates the store
agy-switch pick --json      # now ranking on fresh numbers
```

Skipping this is the most likely way an agent picks an account that is actually
exhausted.

---

## What to report back to the user

After a switch, say what changed, not just "done":

- the account now active
- which surface(s) were written (`acp`, `agy`, or both)
- any caveat that applies — e.g. a running `agy` session keeps its old
  credential until restarted

After a failure, quote the exit code and the message. Do not silently retry a
code 1; do not paper over a code 2 by picking a different account without saying
so.

---

## Things an agent must not assume

- **That editing files by hand is equivalent.** Use the commands. The store is
  written atomically and the tool tracks eligibility; a hand-edit corrupts both.
- **That all accounts are equivalent.** Check the `ACP` column.
- **That a switch affects sessions already running.** T3 reads the credential
  when it spawns the provider; an `agy` session keeps the credential it started
  with.
- **That quota numbers are live.** See above.
- **That you should switch when someone mentions a limit.** Unless the user asked
  you to move accounts, don't. Report, recommend, wait.

---

## Environment

| What | Where |
| :--- | :--- |
| account store | `~/.agy-switch/accounts.json` (mode `0600`, atomic writes) |
| T3 ACP target | `~/.t3/userdata/providers/antigravity/*/antigravity-acp/acp_token.json` |
| `agy` CLI target | `~/.gemini/antigravity-cli/antigravity-oauth-token` |
| sign-in harness | bundled with T3 Code; override with `AGY_SWITCH_HARNESS` |

If `agy-switch doctor` reports the harness missing, `add` cannot work — the user
needs T3 Code installed once, or `AGY_SWITCH_HARNESS` pointed at an
`agy_acp_server.par`.
