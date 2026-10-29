# tranche-flow

A Claude Code plugin for sessions that orchestrate work through subagents in git worktrees. It makes the loop that an orchestrating session otherwise repeats by hand, and gets wrong under pressure, mechanical and safe.

## Why I built it

Running a multi-agent engineering programme, the same four things kept costing time or causing risk:

1. **Six agents used `git stash` in their own worktrees.** The stash stack is one per repository, shared by every worktree and every session, so a pop can take another agent's changes. Nothing was lost that day, but only an hour of forensic work proved it.
2. **Every tranche merge was the same manual loop**: cherry-pick the agent's commits, run the gate test files one at a time (the full suite hung), then work out by hand which failures were new and which were already red.
3. **Agent worktrees were sometimes cut from a stale checkout** instead of the branch head.
4. **Agents cannot see their own token usage.** The figure arrives only in the completion notification, so heavy agents went unnoticed until the bill.

## What it does

- **Stash guard.** `git stash` and `git stash pop` in any Bash call are refused with a message that names the alternative (a temporary WIP commit, or `git diff <sha>`); `git stash list` and `show` stay allowed. Applies to the session and every subagent. Set `allowStash: true` in the plugin's config to lift it.
- **`/worktree-new <name> [base]`** creates `<worktreeRoot>/<name>` on a new branch cut from the base branch's current head.
- **`/merge-tranche <branch> [extra test files...]`** refuses to run on a dirty checkout, cherry-picks the branch's commits (aborting cleanly on conflict), runs each gate test file with a timeout, and classifies every file as NEW, PRE-EXISTING, FIXED or GREEN against a stored baseline. Results are written to `.claude/tranche-flow-results-<stamp>.json`.
- **Agent ledger.** Every `Agent` launch and every task notification is recorded (description, tokens, tool uses, duration). An agent over the token flag is notified at once. `/agent-ledger` prints the table; the ledger is also appended to `.claude/agent-ledger.jsonl`.

## Setup

Per project, `.claude/tranche-flow.json` (every key optional):

```json
{
  "baseBranch": "dev",
  "worktreeRoot": ".claude/worktrees",
  "testCommand": "python -m pytest {file} -q -p no:cacheprovider",
  "testTimeoutSeconds": 300,
  "gateTests": ["tests/unit/test_binding.py", "tests/unit/test_composition.py"],
  "baselineFile": ".claude/tranche-flow-baseline.json"
}
```

The baseline file maps test file → `{ "failed": n, "errors": n }` for a known-good run; without it every red file reads as NEW. `tokenFlag` (default 300000) and `allowStash` (default false) are set in the plugin's config menu.

## Why I'm sharing it

Every team that lets Claude Code delegate to subagents in worktrees will hit the same three failures I did: a shared stash stack, red tests nobody classifies, and agent cost that is only visible after the fact. None of them is specific to my codebase. The plugin carries no project knowledge; the project supplies a six-line config. If it saves one team the hour of git forensics I spent proving nothing was lost, it has paid for itself.

## How to load it into a project

1. Install once, at the user scope, from a terminal session: `/plugin install tranche-flow --marketplace William-Harvey/tranche-flow` (answer `y` to add the marketplace, then pick the scope). From a shell: `claude plugin install tranche-flow --marketplace William-Harvey/tranche-flow`. In the desktop app: click + next to the prompt box, Plugins, Add marketplace `William-Harvey/tranche-flow`, then Add plugin.
2. Add the project's config file described under Setup (`.claude/tranche-flow.json`), committed with the project so every session and subagent sees the same values.
3. Start a session in the project; the plugin's commands appear in `/` and its hooks are active for the session and every subagent it launches.
4. To try it without installing: `claude --plugin-dir <path to this folder>`.

## Install

At the prompt of a terminal session:

```
/plugin install tranche-flow --marketplace William-Harvey/tranche-flow
```

From a shell: `claude plugin install tranche-flow --marketplace William-Harvey/tranche-flow`. In the desktop app: click + next to the prompt box, Plugins, Add marketplace with `William-Harvey/tranche-flow`, then Add plugin. For development: `claude --plugin-dir <this folder>`.

## Notes

- The guard is a `tool.call` hook on Bash; it fails closed if its own code errors.
- `/merge-tranche` never deletes anything and never force-pushes; a conflict aborts the cherry-pick and leaves the checkout as it was.
- Requires `git`, `sh` and a `timeout` binary on PATH.
