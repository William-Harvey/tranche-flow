import type { Register } from 'claude-code'

// tranche-flow: the workflow an orchestrating session repeats for every delegated tranche, made safe and mechanical.
//   1. a Bash guard: `git stash` / `git stash pop` are refused (the stash stack is ONE per repository, shared by every worktree and
//      session, so a pop can take another agent's changes); `git stash list` / `show` stay allowed; `allowStash: true` lifts it.
//   2. /worktree-new <name> [base]: a worktree + branch cut from the BASE BRANCH HEAD (never from a stale checkout).
//   3. /merge-tranche <branch> [extra test files...]: `git cherry` the branch's commits onto the current checkout, then run the gate
//      test files one at a time with a timeout and classify every failure against the stored baseline: NEW / PRE-EXISTING / FIXED.
//   4. /agent-ledger: every Agent tool launch and every task-notification is recorded (description, tokens, duration, tool uses);
//      a subagent over `tokenFlag` tokens is flagged; the ledger is printed as a table and appended to <cwd>/.claude/agent-ledger.jsonl.
// Project-specific values live in <cwd>/.claude/tranche-flow.json:
//   { "baseBranch": "dev", "worktreeRoot": ".claude/worktrees", "testCommand": "python -m pytest {file} -q -p no:cacheprovider",
//     "testTimeoutSeconds": 300, "gateTests": ["tests/unit/test_a.py", ...], "baselineFile": ".claude/tranche-flow-baseline.json" }

type Config = {
  baseBranch: string
  worktreeRoot: string
  testCommand: string
  testTimeoutSeconds: number
  gateTests: string[]
  baselineFile: string
}

type LedgerRow = {
  id: string
  description: string
  startedAt: number
  finishedAt?: number
  tokens?: number
  toolUses?: number
  durationMs?: number
  flagged?: boolean
}

const DEFAULTS: Config = {
  baseBranch: 'main',
  worktreeRoot: '.claude/worktrees',
  testCommand: 'python -m pytest {file} -q -p no:cacheprovider',
  testTimeoutSeconds: 300,
  gateTests: [],
  baselineFile: '.claude/tranche-flow-baseline.json',
}

const STASH = /\bgit\s+(-C\s+\S+\s+)?stash\b(?!\s+(list|show)\b)/
const ledger: LedgerRow[] = []
let cwd = ''

async function loadConfig($: any): Promise<Config> {
  const path = `${cwd}/.claude/tranche-flow.json`
  try {
    if (await $.fs.exists(path)) return { ...DEFAULTS, ...JSON.parse(await $.fs.read(path)) }
  } catch (err) {
    $.ui.log(`tranche-flow: config unreadable (${String(err)}); defaults used`)
  }
  return DEFAULTS
}

async function sh($: any, cmd: string, timeoutSeconds?: number) {
  const argv = timeoutSeconds ? ['timeout', String(timeoutSeconds), 'sh', '-c', cmd] : ['sh', '-c', cmd]
  return $.process.run(argv, { cwd })
}

function tally(stdout: string, stderr: string): { passed: number; failed: number; errors: number; summary: string } {
  const text = `${stdout}\n${stderr}`
  const last = text.trim().split('\n').pop() ?? ''
  const num = (re: RegExp) => Number((text.match(re) ?? [, '0'])[1])
  return { passed: num(/(\d+) passed/), failed: num(/(\d+) failed/), errors: num(/(\d+) errors?/), summary: last.replace(/=+/g, '').trim() }
}

export const register: Register = (on, options) => {
  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    if (!(options as any)?.allowStash && STASH.test(e.command)) {
      return { deny: `${$.plugin.name}: git stash is refused here. The stash stack is shared by every worktree and session of this repository, so a pop can take another agent's changes. Set work aside with a temporary WIP commit on your branch, or compare against a commit with \`git diff <sha>\`.` }
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${$.plugin.name}: the stash guard failed closed.` }))

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    await $.command.register({ name: 'worktree-new', description: 'Create a worktree and branch from the base branch head.', argumentHint: '<name> [base-branch]' })
    await $.command.register({ name: 'merge-tranche', description: 'Cherry-pick an agent branch here, run the gate tests file by file, classify failures against the baseline.', argumentHint: '<branch> [extra test files...]' })
    await $.command.register({ name: 'agent-ledger', description: 'Show every subagent launched this session with tokens, duration and flags.', argumentHint: '[baseline]' })
    return next(e)
  })

  on('command.run', { command: 'worktree-new' }, async ($, e) => {
    const cfg = await loadConfig($)
    const [name, base = cfg.baseBranch] = e.args.trim().split(/\s+/)
    if (!name) return { text: 'usage: /worktree-new <name> [base-branch]' }
    const head = await sh($, `git rev-parse ${base}`)
    if (head.exitCode !== 0) return { text: `base branch ${base} not found: ${head.stderr.trim()}` }
    const sha = head.stdout.trim()
    const r = await sh($, `git worktree add -q -b ${name} ${cfg.worktreeRoot}/${name} ${sha}`)
    return { text: r.exitCode === 0 ? `worktree ${cfg.worktreeRoot}/${name} on branch ${name} at ${sha.slice(0, 9)} (head of ${base})` : `worktree add failed: ${r.stderr.trim()}` }
  })

  on('command.run', { command: 'merge-tranche' }, async ($, e) => {
    const cfg = await loadConfig($)
    const [branch, ...extra] = e.args.trim().split(/\s+/).filter(Boolean)
    if (!branch) return { text: 'usage: /merge-tranche <branch> [extra test files...]' }
    const current = (await sh($, 'git rev-parse --abbrev-ref HEAD')).stdout.trim()
    const dirty = (await sh($, 'git status --short --untracked-files=no')).stdout.trim()
    if (dirty) return { text: `the checkout (${current}) has uncommitted tracked changes; commit or set them aside with a WIP commit first:\n${dirty}` }
    const cherry = await sh($, `git cherry ${current} ${branch}`)
    if (cherry.exitCode !== 0) return { text: `git cherry failed: ${cherry.stderr.trim()}` }
    const commits = cherry.stdout.split('\n').filter(l => l.startsWith('+')).map(l => l.slice(2).trim())
    const lines: string[] = [`merge-tranche ${branch} → ${current}: ${commits.length} commit(s) to pick`]
    if (commits.length) {
      const pick = await sh($, `git cherry-pick ${commits.join(' ')}`)
      if (pick.exitCode !== 0) {
        await sh($, 'git cherry-pick --abort')
        return { text: `${lines[0]}\ncherry-pick CONFLICT, aborted and left the checkout as it was:\n${(pick.stdout + pick.stderr).trim().slice(0, 1500)}` }
      }
      lines.push(`picked: ${commits.map(c => c.slice(0, 9)).join(' ')}`)
    }
    let baseline: Record<string, { failed: number; errors: number }> = {}
    const baselinePath = `${cwd}/${cfg.baselineFile}`
    try { if (await $.fs.exists(baselinePath)) baseline = JSON.parse(await $.fs.read(baselinePath)) } catch { baseline = {} }
    const files = [...cfg.gateTests, ...extra]
    const results: Record<string, { failed: number; errors: number; passed: number; summary: string }> = {}
    const classes = { NEW: [] as string[], PRE_EXISTING: [] as string[], FIXED: [] as string[], GREEN: [] as string[] }
    for (const f of files) {
      const r = await sh($, cfg.testCommand.replace('{file}', f), cfg.testTimeoutSeconds)
      const t = tally(r.stdout, r.stderr)
      if (r.exitCode === 124) t.summary = `TIMEOUT after ${cfg.testTimeoutSeconds}s`
      results[f] = t
      const red = t.failed + t.errors > 0 || r.exitCode === 124
      const wasRed = (baseline[f]?.failed ?? 0) + (baseline[f]?.errors ?? 0) > 0
      if (red && !wasRed) classes.NEW.push(`${f}: ${t.summary}`)
      else if (red && wasRed) classes.PRE_EXISTING.push(`${f}: ${t.summary} (baseline ${baseline[f].failed} failed, ${baseline[f].errors} errors)`)
      else if (!red && wasRed) classes.FIXED.push(`${f}: ${t.summary}`)
      else classes.GREEN.push(`${f}: ${t.summary}`)
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const out = `${cwd}/.claude/tranche-flow-results-${stamp}.json`
    await $.fs.write(out, JSON.stringify({ branch, commits, results }, null, 1))
    for (const [k, v] of Object.entries(classes)) lines.push(`${k} (${v.length})${v.length ? ':\n  ' + v.join('\n  ') : ''}`)
    lines.push(`results written to ${out}; baseline ${baseline && Object.keys(baseline).length ? cfg.baselineFile : 'absent (every red file reads as NEW; save one with /merge-tranche --baseline next time you have a known-good run)'}`)
    if (classes.NEW.length) $.ui.notify(`merge-tranche ${branch}: ${classes.NEW.length} NEW red file(s)`)
    return { text: lines.join('\n') }
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const row: LedgerRow = { id: 'pending', description: String((e as any).description ?? ''), startedAt: Date.now() }
    ledger.push(row)
    const ran = await next(e)
    const text = typeof (ran as any)?.result === 'string' ? (ran as any).result : JSON.stringify((ran as any)?.result ?? '')
    const m = text.match(/agentId:\s*([a-z0-9]+)/)
    if (m) row.id = m[1]
    return ran
  }).catch(($, e, next) => (next.called ? next(e) : next(e)))

  on('session.append', async ($, e, next) => {
    try {
      const content = (e.message as any)?.content
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((b: any) => b?.text ?? '').join('\n') : ''
      if (text.includes('<task-notification>') && text.includes('<subagent_tokens>')) {
        const id = (text.match(/<task-id>([^<]+)<\/task-id>/) ?? [])[1]
        const tokens = Number((text.match(/<subagent_tokens>(\d+)<\/subagent_tokens>/) ?? [])[1] ?? 0)
        const toolUses = Number((text.match(/<tool_uses>(\d+)<\/tool_uses>/) ?? [])[1] ?? 0)
        const durationMs = Number((text.match(/<duration_ms>(\d+)<\/duration_ms>/) ?? [])[1] ?? 0)
        const flag = Number((options as any)?.tokenFlag ?? 300000)
        let row = ledger.find(r => r.id === id)
        if (!row) { row = { id: id ?? 'unknown', description: '', startedAt: Date.now() - durationMs }; ledger.push(row) }
        Object.assign(row, { finishedAt: Date.now(), tokens, toolUses, durationMs, flagged: tokens > flag })
        if (row.flagged) $.ui.notify(`agent ${row.id} (${row.description || 'no description'}) used ${tokens.toLocaleString()} tokens (flag ${flag.toLocaleString()})`)
        if (cwd) await $.fs.write(`${cwd}/.claude/agent-ledger.jsonl`, ledger.map(r => JSON.stringify(r)).join('\n') + '\n')
      }
    } catch (err) {
      $.ui.log(`tranche-flow: ledger parse skipped (${String(err)})`)
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : next(e)))

  on('command.run', { command: 'agent-ledger' }, async () => {
    if (!ledger.length) return { text: 'no subagents launched this session' }
    const total = ledger.reduce((s, r) => s + (r.tokens ?? 0), 0)
    const rows = ledger.map(r => `${r.flagged ? '⚑' : ' '} ${r.id.padEnd(18)} ${String(r.tokens ?? '-').padStart(9)} tok ${r.durationMs ? (r.durationMs / 60000).toFixed(1) + ' min' : 'running'.padStart(8)}  ${r.description}`)
    return { text: ['  id                 tokens      duration  description', ...rows, `total ${total.toLocaleString()} tokens over ${ledger.length} agent(s); ⚑ = over the flag`].join('\n') }
  })
}
