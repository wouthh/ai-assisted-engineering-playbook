#!/usr/bin/env node
// prloop: wait for an external PR reviewer bot and tell the agent what to do next.
// Single file, no dependencies. Needs Node 20+, git and an authenticated `gh`.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const EXIT = { clean: 0, findings: 10, not_requested: 20, requested_while_unresolved: 21, timeout: 30, error: 40, conflict: 41, blocked: 50 };

const HELP = `prloop - wait for a PR review bot and report the next step as JSON.

Usage:
  prloop status <pr> [--repo owner/name]
  prloop ready <pr> [--repo owner/name]
  prloop mark-tested [--sha <sha>]
  prloop wait <pr> [--repo owner/name] [--timeout 40m] [--ack-timeout 3m] [--interval 75s]
  prloop sync <pr> [--repo owner/name] [--union <glob>]...
  prloop run --repo owner/name --pr N[,N...] [--agent claude|codex|none]
             [--max-rounds 8] [--merge rebase|squash|merge] [--worktree <path>]
             [--deadline 4h] [--model <m>] [--effort <e>] [--union <glob>]...

Reviewer options (flag or env):
  --reviewer-login <regex>  PRLOOP_REVIEWER_LOGIN  default: codex
  --trigger <text>          PRLOOP_TRIGGER         default: @codex review
  --clean-regex <regex>     PRLOOP_CLEAN_REGEX     default: didn.t find any major issues
  --timeout <dur>           PRLOOP_TIMEOUT         default: 40m after the request
  --ack-timeout <dur>       PRLOOP_ACK_TIMEOUT     default: 3m without any reaction
  --interval <dur>          PRLOOP_INTERVAL        default: 75s between polls

Exit codes: 0 clean/ok, 10 findings, 20 not_requested, 21 requested_while_unresolved,
            30 timeout, 40 error, 41 conflict, 50 blocked (run) / not ready (ready).`;

// ---------- small helpers ----------

export function parseArgs(argv) {
  const out = { _: [], union: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const [k, inline] = a.slice(2).split(/=(.*)/s);
    const key = k.replace(/-(\w)/g, (_, c) => c.toUpperCase());
    const val = inline ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
    if (key === 'union') out.union.push(val); else out[key] = val;
  }
  return out;
}

export function parseDuration(s) {
  const m = /^(\d+)(s|m|h)?$/.exec(String(s));
  if (!m) throw new Error(`bad duration: ${s}`);
  return Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5 }[m[2] ?? 's'];
}

export function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const git = (args, cwd) => sh('git', args, { cwd });
const tryGit = (args, cwd) => { try { return git(args, cwd); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (sha) => (sha ?? '').slice(0, 7);

export function config(opts, env = process.env) {
  return {
    reviewer: new RegExp(opts.reviewerLogin ?? env.PRLOOP_REVIEWER_LOGIN ?? 'codex', 'i'),
    trigger: String(opts.trigger ?? env.PRLOOP_TRIGGER ?? '@codex review'),
    clean: new RegExp(opts.cleanRegex ?? env.PRLOOP_CLEAN_REGEX ?? 'didn.t find any major issues', 'i'),
    timeout: parseDuration(opts.timeout ?? env.PRLOOP_TIMEOUT ?? '40m'),
    ackTimeout: parseDuration(opts.ackTimeout ?? env.PRLOOP_ACK_TIMEOUT ?? '3m'),
    interval: parseDuration(opts.interval ?? env.PRLOOP_INTERVAL ?? '75s'),
  };
}

// ---------- GitHub reads ----------

const PR_QUERY = `query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){
  mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed
  pullRequest(number:$pr){number url state headRefName reactions(last:50){nodes{content createdAt user{login}}} baseRefName headRefOid mergeable mergeStateStatus
    commits(last:1){nodes{commit{oid committedDate}}}
    reviewThreads(first:100){nodes{id isResolved isOutdated path line comments(first:1){nodes{body createdAt author{login}}}}}
    comments(last:100){nodes{id databaseId body createdAt author{login} reactions(last:50){nodes{content createdAt user{login}}}}}
    reviews(last:50){nodes{id body state submittedAt author{login} commit{oid}}}}}}`;

export function resolveRepo(opts) {
  if (opts.repo) return opts.repo;
  return sh('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
}

// Retries transient gh/network failures twice with a short backoff.
function ghRetry(args) {
  for (let i = 0; ; i++) {
    try { return sh('gh', args); } catch (e) {
      if (i >= 2 || /not found|could not resolve to|bad credentials/i.test(e.stderr ?? '')) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000 * (i + 1));
    }
  }
}

export function fetchPr(repo, pr) {
  const [owner, name] = repo.split('/');
  const out = ghRetry( ['api', 'graphql', '-f', `query=${PR_QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `pr=${pr}`]);
  const r = JSON.parse(out).data.repository;
  if (!r?.pullRequest) throw new Error(`PR ${repo}#${pr} not found`);
  return { ...r.pullRequest, repoSettings: { merge: r.mergeCommitAllowed, squash: r.squashMergeAllowed, rebase: r.rebaseMergeAllowed } };
}

// ---------- pure classification (tested with fixtures) ----------

const login = (n) => n?.author?.login ?? n?.user?.login ?? '';
// First meaningful line of a comment, without badges, HTML and markdown emphasis.
export const title = (s) => ((s ?? '').split('\n')
  .map((l) => l.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/<[^>]+>/g, '').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim())
  .find(Boolean) ?? '');

export const fingerprint = (t) => `${t.path ?? ''}::${title(t.body).toLowerCase()}`;

// Classifies one PR snapshot. Rules carried over from the earlier review queue:
// - only signals newer than the head commit (or the current request) count;
// - reactions on the request comment and on the PR body both count, and the latest one wins
//   (an automatic review reacts on the PR body; a 👍 there after 👀 is a clean result);
// - a no-issues comment or review outside any thread is a clean result for the head;
// - an unacknowledged request is stale after `ackTimeout`, an acknowledged one after `timeout`,
//   measured from the request time so re-running `wait` does not restart the clock;
// - outdated threads stay unresolved until someone resolves them: an outdated anchor is not a fix.
export function classify(pr, cfg, nowMs = Date.now()) {
  const head = pr.headRefOid;
  const headTime = pr.commits.nodes[0]?.commit.committedDate ?? '1970-01-01T00:00:00Z';
  const isBot = (n) => cfg.reviewer.test(login(n));
  const threads = pr.reviewThreads.nodes.filter((t) => !t.isResolved).map((t) => {
    const c = t.comments.nodes[0] ?? {};
    return { id: t.id, path: t.path, line: t.line, outdated: !!t.isOutdated, author: login(c), createdAt: c.createdAt, body: (c.body ?? '').slice(0, 300) };
  });
  const triggerNode = [...pr.comments.nodes].reverse()
    .find((c) => !isBot(c) && c.body.toLowerCase().includes(cfg.trigger.toLowerCase()));
  const current = !!triggerNode && triggerNode.createdAt >= headTime;
  const since = current ? triggerNode.createdAt : headTime;

  const signals = [...(current ? triggerNode.reactions.nodes : []), ...(pr.reactions?.nodes ?? [])]
    .filter((r) => isBot(r) && r.createdAt >= since && (r.content === 'EYES' || r.content === 'THUMBS_UP'))
    .map((r) => ({ at: r.createdAt, state: r.content === 'EYES' ? 'reviewing' : 'clean' }));
  const botReviews = pr.reviews.nodes.filter((r) => isBot(r) && r.commit?.oid === head && r.submittedAt >= since);
  const botComments = pr.comments.nodes.filter((c) => isBot(c) && c.createdAt >= since);
  const summaries = [...botReviews.map((r) => ({ at: r.submittedAt, body: r.body })), ...botComments.map((c) => ({ at: c.createdAt, body: c.body }))]
    .filter((s) => s.body);
  for (const s of summaries) if (cfg.clean.test(s.body)) signals.push({ at: s.at, state: 'clean' });
  const newFindings = threads.filter((t) => cfg.reviewer.test(t.author) && t.createdAt >= since);
  const oldUnresolved = current ? threads.filter((t) => t.createdAt < triggerNode.createdAt) : [];

  signals.sort((a, b) => a.at.localeCompare(b.at));
  const reviewer = newFindings.length ? 'findings' : signals.at(-1)?.state ?? 'none';
  // An automatic review has no request comment; its clock starts at the first reaction.
  const startedAt = current ? triggerNode.createdAt : signals[0]?.at;
  const age = startedAt ? nowMs - Date.parse(startedAt) : 0;
  const stale = !!startedAt && reviewer !== 'clean'
    && ((reviewer === 'none' && age >= cfg.ackTimeout) || age >= cfg.timeout);

  let verdict;
  if (reviewer === 'findings') verdict = 'findings';
  else if (oldUnresolved.length) verdict = 'requested_while_unresolved';
  else if (reviewer === 'clean') verdict = threads.length ? 'findings' : 'clean';
  else if (stale) verdict = 'timeout';
  else if (current || reviewer === 'reviewing') verdict = 'pending';
  else verdict = 'not_requested';

  const reasons = [];
  if (threads.length) reasons.push(`${threads.length} unresolved threads: ${threads.map((t) => t.id).join(', ')}`);
  if (verdict === 'pending') reasons.push(current
    ? `review already requested on head ${short(head)} (comment ${triggerNode.databaseId}); run \`prloop wait\` instead`
    : `reviewer is already reviewing head ${short(head)}; run \`prloop wait\` instead`);
  if (reviewer === 'clean') reasons.push(`head ${short(head)} is already reviewed clean`);

  return {
    pr: pr.number, url: pr.url, head, branch: pr.headRefName, base: pr.baseRefName,
    mergeable: pr.mergeable, mergeState: pr.mergeStateStatus,
    unresolvedThreads: threads,
    trigger: triggerNode && { id: triggerNode.id, databaseId: triggerNode.databaseId, createdAt: triggerNode.createdAt, afterHead: current, body: triggerNode.body },
    reviewerState: { state: reviewer, count: newFindings.length },
    summaries: summaries.map((s) => s.body.slice(0, 600)),
    rerequestBody: triggerNode?.body ?? cfg.trigger,
    verdict, readyToRequest: reasons.length === 0, reasons,
  };
}

// ---------- local checkout gate ----------

function markerFile(cwd) {
  const dir = tryGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  return dir && join(dir, 'prloop-tested');
}

export function isTested(sha, cwd) {
  const f = markerFile(cwd);
  return !!f && existsSync(f) && readFileSync(f, 'utf8').split('\n').includes(sha);
}

export function markTested(sha, cwd) {
  const f = markerFile(cwd);
  if (!f) throw new Error('not inside a git checkout');
  const full = git(['rev-parse', sha ?? 'HEAD'], cwd);
  const prev = existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).slice(-50) : [];
  writeFileSync(f, [...prev, full].join('\n') + '\n');
  return full;
}

const clearTested = (cwd) => { const f = markerFile(cwd); if (f) rmSync(f, { force: true }); };

export function localGate(s, cwd) {
  const reasons = [];
  if (tryGit(['branch', '--show-current'], cwd) === s.branch) {
    if (git(['status', '--porcelain'], cwd)) reasons.push('working tree is not clean: commit or remove local changes');
    const local = git(['rev-parse', 'HEAD'], cwd);
    if (local !== s.head) reasons.push(`local HEAD ${short(local)} differs from remote PR head ${short(s.head)}: push or pull first`);
  }
  if (!isTested(s.head, cwd)) reasons.push(`head ${short(s.head)} not marked tested: run your gate, then \`prloop mark-tested\``);
  return reasons;
}

// ---------- sync with base ----------

// Union of both sides for append-only files: base lines first, then branch lines, identical lines once.
export function unionLines(baseSide, branchSide) {
  const seen = new Set();
  const out = [];
  for (const line of [...baseSide.split('\n'), ...branchSide.split('\n')]) {
    if (line === '' || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out.join('\n') + '\n';
}

// Resolves conflicts that only touch union files; returns the remaining manual conflicts.
export function resolveUnion(cwd, globs, baseStage) {
  const files = git(['diff', '--name-only', '--diff-filter=U'], cwd).split('\n').filter(Boolean);
  if (!files.length) return null; // the step failed for another reason
  const res = globs.map(globToRegex);
  const manual = files.filter((f) => !res.some((r) => r.test(f)));
  if (manual.length) return manual;
  for (const f of files) {
    const stage = (n) => tryGit(['show', `:${n}:${f}`], cwd);
    const base = stage(baseStage), branch = stage(baseStage === 2 ? 3 : 2);
    if (base === null || branch === null) return [f]; // delete/modify: needs a human
    writeFileSync(join(cwd, f), unionLines(base, branch));
    git(['add', '--', f], cwd);
  }
  return [];
}

export function syncBranch({ cwd, branch, base, head, settings, union = [], remote = 'origin' }) {
  if (tryGit(['branch', '--show-current'], cwd) !== branch) return { verdict: 'error', error: `run sync inside a checkout of ${branch}` };
  if (git(['status', '--porcelain'], cwd)) return { verdict: 'error', error: 'working tree is not clean' };
  git(['fetch', '--quiet', remote, base, branch], cwd);
  if (git(['rev-parse', 'HEAD'], cwd) !== head) return { verdict: 'error', error: `local HEAD differs from remote PR head ${short(head)}: push or pull first` };
  if (tryGit(['merge-base', '--is-ancestor', `${remote}/${base}`, 'HEAD'], cwd) !== null) return { verdict: 'up_to_date', head };
  // ponytail: merge whenever merge or squash merges are allowed; rebase only for rebase-only repos.
  const rebase = !settings.merge && !settings.squash;
  const env = { ...process.env, GIT_EDITOR: 'true' };
  const step = (args) => spawnSync('git', args, { cwd, env, encoding: 'utf8' }).status === 0;
  let ok = step(rebase ? ['rebase', `${remote}/${base}`] : ['merge', '--no-edit', `${remote}/${base}`]);
  for (let i = 0; !ok && i < 200; i++) {
    // During a rebase stage 2 is the base side; during a merge stage 3 is.
    const manual = resolveUnion(cwd, union, rebase ? 2 : 3);
    if (!manual) break;
    if (manual.length) {
      step([rebase ? 'rebase' : 'merge', '--abort']);
      return { verdict: 'conflict', conflicts: manual, method: rebase ? 'rebase' : 'merge', next: 'resolve these conflicts by hand, then run your gate and push' };
    }
    ok = step(rebase ? ['rebase', '--continue'] : ['commit', '--no-edit']);
  }
  if (!ok) {
    step([rebase ? 'rebase' : 'merge', '--abort']);
    return { verdict: 'error', error: `${rebase ? 'rebase' : 'merge'} failed` };
  }
  const push = rebase ? ['push', `--force-with-lease=${branch}:${head}`, remote, `HEAD:${branch}`] : ['push', remote, `HEAD:${branch}`];
  if (!step(push)) return { verdict: 'error', error: 'push failed; the branch is updated locally only' };
  clearTested(cwd);
  const newHead = git(['rev-parse', 'HEAD'], cwd);
  return { verdict: 'synced', method: rebase ? 'rebase' : 'merge', head: newHead, previousHead: head, next: 'head changed: run your gate, `prloop mark-tested`, then request a review' };
}

// ---------- wait ----------

// Polls until the snapshot is no longer pending. Terminates because a request goes stale after
// `cfg.timeout`; transient GitHub errors are retried until three fail in a row.
export async function waitFor(repo, prNum, cfg, { interval, fetch = fetchPr, now = Date.now, pause = sleep }) {
  for (let failures = 0; ; await pause(interval)) {
    let s;
    try { s = classify(fetch(repo, prNum), cfg, now()); failures = 0; } catch (e) {
      if (++failures >= 3) return { verdict: 'error', pr: Number(prNum), error: String(e.stderr || e.message).slice(0, 500) };
      continue;
    }
    if (s.verdict !== 'pending') return finish(s);
  }
}

function finish(s) {
  const base = { verdict: s.verdict, pr: s.pr, head: s.head };
  if (s.verdict === 'clean') return { ...base, next: 'review is clean on the current head' };
  if (s.verdict === 'timeout') return { ...base, reviewerState: s.reviewerState, trigger: s.trigger, rerequestBody: s.rerequestBody,
    next: s.reviewerState.state === 'none'
      ? 'the reviewer never acknowledged the request: run `prloop ready`, then repost rerequestBody as a new comment'
      : 'the review timed out: run `prloop ready`, then repost rerequestBody as a new comment' };
  if (s.verdict === 'findings') return { ...base, findings: s.unresolvedThreads, summaries: s.summaries,
    next: 'fix, run your gate, push, `prloop mark-tested`, reply to and resolve each thread, `prloop ready`, then request a review' };
  if (s.verdict === 'not_requested') return { ...base, unresolvedThreads: s.unresolvedThreads.map((t) => t.id),
    next: `no "${s.trigger?.body ?? 'trigger'}" comment after head ${short(s.head)}: run \`prloop ready\`, then request a review` };
  return { ...base, unresolvedThreads: s.unresolvedThreads,
    next: 'a review was requested while threads were unresolved: resolve them, then request a review again' };
}

// ---------- supervisor ----------

const stateDir = () => join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'prloop');
const statePath = (repo, pr) => join(stateDir(), `${repo.replace('/', '__')}__${pr}.json`);
const loadState = (repo, pr) => {
  try { return JSON.parse(readFileSync(statePath(repo, pr), 'utf8')); } catch { return { rounds: 0, seen: {} }; }
};
const saveState = (repo, pr, st) => { mkdirSync(stateDir(), { recursive: true }); writeFileSync(statePath(repo, pr), JSON.stringify(st, null, 2)); };

// Records findings; returns the fingerprints that came back after a fix twice (seen on 3+ distinct threads).
export function recordFindings(seen, findings) {
  const repeated = [];
  for (const f of findings) {
    const fp = fingerprint(f);
    const ids = (seen[fp] ??= []);
    if (!ids.includes(f.id)) ids.push(f.id);
    if (ids.length >= 3) repeated.push(fp);
  }
  return repeated;
}

export const DENIED = /permission (was |has been )?denied|denied permission|not (been )?permitted|requires? (your )?approval/i;

export function buildPrompt(repo, v) {
  const details = v.verdict === 'conflict'
    ? `Merge conflicts with the base branch in: ${v.conflicts.join(', ')}. Merge or rebase the base yourself and resolve them.`
    : v.verdict === 'timeout'
      ? `The reviewer did not answer. If \`prloop ready\` passes, repost exactly this comment:\n${v.rerequestBody}`
      : v.verdict === 'findings'
        ? `Findings:\n${v.findings.map((f) => `- ${f.id} ${f.path ?? ''}:${f.line ?? ''} ${title(f.body)}`).join('\n')}${v.summaries?.length ? `\nReviewer summary:\n${v.summaries.join('\n').slice(0, 1500)}` : ''}`
        : v.next;
  return `You are working on PR #${v.pr} in ${repo} (current verdict: ${v.verdict}).
${details}

Rules:
1. Fix valid findings in this checkout. If a finding is wrong, reply on the thread with evidence instead.
2. Run the project's test gate. Commit with a normal commit and push. Never rebase, amend or force-push.
3. Run \`prloop mark-tested\` only after the gate passes on the pushed head.
4. Reply to each addressed thread and resolve it.
5. Run \`prloop ready ${v.pr} --repo ${repo}\`. When it exits 0, post the review request comment once. Then stop; do not wait for the review.`;
}

function runAgent(kind, prompt, cwd, opts) {
  const model = opts.model ?? process.env.PRLOOP_MODEL;
  const effort = opts.effort ?? process.env.PRLOOP_EFFORT;
  const [cmd, args] = kind === 'codex'
    ? ['codex', ['exec', '--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true',
      ...(model ? ['-m', model] : []), ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : []), prompt]]
    : ['claude', ['-p', prompt, '--model', model ?? 'claude-opus-5-5', '--effort', effort ?? 'medium',
      '--permission-mode', 'auto', '--output-format', 'json']];
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.status ?? 1, output: `${r.stdout ?? ''}\n${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}` };
}

export function findWorktree(branch, cwd) {
  const list = tryGit(['worktree', 'list', '--porcelain'], cwd) ?? '';
  for (const block of list.split('\n\n')) {
    const wt = /^worktree (.+)$/m.exec(block)?.[1];
    if (wt && block.split('\n').includes(`branch refs/heads/${branch}`)) return wt;
  }
  return null;
}

async function supervise(repo, prNum, cfg, opts, deadline) {
  const st = loadState(repo, prNum);
  const blocked = (reason, extra = {}) => { st.result = 'blocked'; saveState(repo, prNum, st); return { pr: prNum, verdict: 'blocked', reason, ...extra }; };
  const maxRounds = Number(opts.maxRounds ?? 8);
  for (;;) {
    if (Date.now() > deadline) return blocked('overall deadline reached');
    let raw = fetchPr(repo, prNum), s = classify(raw, cfg);
    const cwd = opts.worktree ? resolve(opts.worktree) : findWorktree(s.branch, process.cwd());
    const needsSync = () => s.mergeState === 'BEHIND' || s.mergeState === 'DIRTY' || s.mergeable === 'CONFLICTING';
    let v = null;
    if (needsSync()) {
      if (!cwd) return blocked(`PR is ${s.mergeState} and no worktree for ${s.branch}; pass --worktree`);
      v = { ...syncBranch({ cwd, branch: s.branch, base: s.base, head: s.head, settings: raw.repoSettings, union: opts.union }), pr: prNum };
      if (v.verdict === 'error') return blocked(`sync failed: ${v.error}`);
      if (v.verdict !== 'conflict') v = null;
    }
    if (!v) {
      v = await waitFor(repo, prNum, cfg, { interval: cfg.interval });
    }
    st.lastVerdict = v.verdict;
    if (v.verdict === 'error') return blocked(v.error ?? 'wait failed');
    if (v.verdict === 'clean') {
      if (!opts.merge) { st.result = 'clean'; saveState(repo, prNum, st); return { pr: prNum, verdict: 'clean', head: v.head }; }
      // GitHub computes mergeability lazily; give it a moment.
      for (let i = 0; i < 6; i++) {
        s = classify(fetchPr(repo, prNum), cfg);
        if (s.mergeable !== 'UNKNOWN') break;
        await sleep(5000);
      }
      if (s.head !== v.head) continue;
      if (needsSync()) { // the next loop syncs, which changes the head and needs a fresh review
        if (++st.rounds > maxRounds) return blocked(`max rounds (${maxRounds}) reached while syncing`);
        continue;
      }
      if (s.mergeable !== 'MERGEABLE') return blocked(`GitHub reports mergeable=${s.mergeable}, mergeState=${s.mergeState}`);
      sh('gh', ['pr', 'merge', String(prNum), '--repo', repo, `--${opts.merge}`, '--match-head-commit', s.head]);
      st.result = 'merged'; saveState(repo, prNum, st);
      return { pr: prNum, verdict: 'merged', head: s.head };
    }
    if (++st.rounds > maxRounds) return blocked(`max rounds (${maxRounds}) reached`, { last: v.verdict });
    if (v.verdict === 'findings') {
      const repeated = recordFindings(st.seen, v.findings);
      if (repeated.length) return blocked('the same finding came back after two fixes', { fingerprints: repeated });
    }
    saveState(repo, prNum, st);
    const prompt = buildPrompt(repo, v);
    if (opts.agent === 'none') return { ...v, prompt };
    if (!cwd) return blocked(`no worktree checked out for ${s.branch}; pass --worktree`);
    const before = classify(fetchPr(repo, prNum), cfg);
    const r = runAgent(opts.agent ?? 'claude', prompt, cwd, opts);
    if (DENIED.test(r.output)) return blocked('agent reported a permission denial', { output: r.output.slice(-800) });
    if (r.status !== 0) return blocked(`agent exited with status ${r.status}`, { output: r.output.slice(-800) });
    const after = classify(fetchPr(repo, prNum), cfg);
    const progressed = after.head !== before.head || after.unresolvedThreads.length < before.unresolvedThreads.length
      || (after.trigger?.id && after.trigger.id !== before.trigger?.id);
    if (!progressed) return blocked('agent pushed no commit, resolved no thread and posted no request');
  }
}

// ---------- CLI ----------

export async function main(argv) {
  const opts = parseArgs(argv);
  const [cmd, prArg] = opts._;
  if (!cmd || opts.help || cmd === 'help') { console.log(HELP); return 0; }
  const out = (obj, code) => { console.log(JSON.stringify(obj)); return code; };
  const cfg = config(opts);
  try {
    if (cmd === 'mark-tested') return out({ verdict: 'ok', tested: markTested(opts.sha, process.cwd()) }, 0);
    if (cmd === 'run') {
      if (!opts.repo || !opts.pr) throw new Error('run needs --repo owner/name and --pr N[,N...]');
      if (opts.merge && !['rebase', 'squash', 'merge'].includes(opts.merge)) throw new Error('--merge must be rebase, squash or merge');
      const deadline = Date.now() + parseDuration(opts.deadline ?? '4h');
      const results = [];
      // ponytail: PRs run sequentially; parallel supervisors per PR if throughput matters.
      for (const n of String(opts.pr).split(',')) results.push(await supervise(opts.repo, Number(n), cfg, opts, deadline));
      const code = results.length === 1 && opts.agent === 'none' ? (EXIT[results[0].verdict] ?? 0)
        : results.some((r) => r.verdict === 'blocked') ? EXIT.blocked : 0;
      return out(results.length === 1 ? results[0] : { results }, code);
    }
    if (!prArg) throw new Error(`${cmd} needs a PR number`);
    const repo = resolveRepo(opts);
    if (cmd === 'status') {
      const s = classify(fetchPr(repo, prArg), cfg);
      const local = tryGit(['rev-parse', '--git-dir']) ? localGate(s, process.cwd()) : [];
      return out({ ...s, reasons: [...s.reasons, ...local], readyToRequest: s.readyToRequest && !local.length,
        tested: isTested(s.head, process.cwd()) }, 0);
    }
    if (cmd === 'ready') {
      const s = classify(fetchPr(repo, prArg), cfg);
      const missing = [...s.reasons, ...localGate(s, process.cwd())];
      return out({ ready: !missing.length, pr: s.pr, head: s.head, missing, trigger: cfg.trigger }, missing.length ? EXIT.blocked : 0);
    }
    if (cmd === 'wait') {
      const v = await waitFor(repo, prArg, cfg, { interval: cfg.interval });
      return out(v, EXIT[v.verdict]);
    }
    if (cmd === 'sync') {
      const pr = fetchPr(repo, prArg);
      const v = syncBranch({ cwd: process.cwd(), branch: pr.headRefName, base: pr.baseRefName, head: pr.headRefOid, settings: pr.repoSettings, union: opts.union });
      return out({ pr: Number(prArg), ...v }, v.verdict === 'conflict' ? EXIT.conflict : v.verdict === 'error' ? EXIT.error : 0);
    }
    throw new Error(`unknown command: ${cmd}`);
  } catch (e) {
    return out({ verdict: 'error', error: String(e.stderr || e.message).trim().slice(0, 500) }, EXIT.error);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
