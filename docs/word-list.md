# Word list

The words agy-switch uses in its help, messages, JSON and docs. Check new text
against this page, and add a name here before you use it.

## Who is speaking

The tool talks to "you". It doesn't say "we" or "I". Errors start with
`agy-switch:` and say what happened, what to do next, and what's safe.

## Voice

Plain, exact, calm. Never cute, never alarmed, never salesy.

## Tone

| Moment | Tone | Example |
| :-- | :-- | :-- |
| Everyday | Plain and brief | Switched T3 Code from dev@example.com to ben@example.com. |
| Failure | Calm, with the next step and what's safe | Couldn't find T3 Code's Antigravity sign-in. Sign in to Antigravity in T3 Code once, then try again. Nothing was changed. |
| Credentials | Exact about what's stored and where | Saved accounts and their sign-in tokens live in ~/.agy-switch/accounts.json |

## Terms

| Use | Avoid | Means |
| :-- | :-- | :-- |
| saved accounts | account store | The accounts in ~/.agy-switch/accounts.json |
| can run agents | ACP-eligible | The account's sign-in granted the aicode permission. JSON: `canRunAgents` |
| permission | grant | What a person approves at Google sign-in. Developer docs and JSON may say scope |
| T3 Code | T3 ACP, ACP provider, surface | The app. Its target name is `t3` |
| the agy CLI | surface | The other app. Its target name is `agy` |
| quota left | score, headroom | Percent left on a limit |
| tightest limit | worst bucket | The limit that runs out first |
| model group | bucket | Models that share limits, named by Google, such as Claude and GPT models |
| sign in, sign-in | log in, authenticate, authorise | Approving an account in the browser |
| Antigravity server | harness | The agy_acp_server.par bundled with T3 Code. The env var keeps its name, AGY_SWITCH_HARNESS |
| in use | | The account an app uses now. JSON calls it `active` |

## Actions

| Label | Means | Not |
| :-- | :-- | :-- |
| switch | Make an app use an account | activate, use (an alias only) |
| add | Sign in and save an account | login |
| remove | Delete a saved account | delete, rm (an alias only) |
| pick | Rank accounts. Never switches | choose, best (an alias only) |

## Never name

| Use | Avoid |
| :-- | :-- |
| example.com addresses in docs, tests and examples | real people's accounts |

## Rules that must read the same everywhere

| Rule | The line |
| :-- | :-- |
| When to switch | Switch only when the user asks you to. |
| Running sessions | Sessions already running keep the account they started with. |
| Fixing an account | Run agy-switch add and approve every permission. |
| Exit codes | 0 done, 1 something failed, 2 the command needs fixing. |

## Style

- English, US spelling.
- Sentence case. CLI table headers are uppercase, like other CLIs.
- No period on table cells and labels. Periods on full sentences.
- Digits for numbers. Contractions: yes. Exclamation marks: no.
- Commands in messages are written out in full, such as agy-switch add.
