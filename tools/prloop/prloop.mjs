#!/usr/bin/env node
// prloop: wait for an external PR reviewer bot and tell the agent what to do next.
// Single file, no dependencies. Needs Node 20+, git and an authenticated `gh`.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const EXIT = { clean: 0, findings: 10, not_requested: 20, requested_while_unresolved: 21, not_tested: 22, timeout: 30, unavailable: 31, error: 40, conflict: 41, blocked: 50 };

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
  --reviewer cloud|local|auto  PRLOOP_REVIEWER     default: auto (local review when the bot is unavailable)
  --unavailable-regex <re>  PRLOOP_UNAVAILABLE_REGEX  bot replies that mean it cannot review
  --max-local-reviews <n>   PRLOOP_MAX_LOCAL_REVIEWS  default: 3 per PR
  --agent claude|codex      PRLOOP_AGENT           local reviewer (and run's fixer); --model, --effort

Exit codes: 0 clean/ok/merged, 10 findings, 20 not_requested, 21 requested_while_unresolved, 22 not_tested,
            30 timeout, 31 unavailable, 40 error, 41 conflict, 50 blocked (run) / not ready (ready).`;

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
    mode: String(opts.reviewer ?? env.PRLOOP_REVIEWER ?? 'auto'),
    reviewer: new RegExp(opts.reviewerLogin ?? env.PRLOOP_REVIEWER_LOGIN ?? 'codex', 'i'),
    // Phrasings seen from the Codex connector when it cannot review.
    unavailable: new RegExp(opts.unavailableRegex ?? env.PRLOOP_UNAVAILABLE_REGEX
      ?? 'reached your .*usage limits|couldn.t complete this request|unable to review|quota', 'i'),
    maxLocal: Number(opts.maxLocalReviews ?? env.PRLOOP_MAX_LOCAL_REVIEWS ?? 3),
    agent: String(opts.agent ?? env.PRLOOP_AGENT ?? 'claude'),
    model: opts.model ?? env.PRLOOP_MODEL,
    effort: opts.effort ?? env.PRLOOP_EFFORT,
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
  pullRequest(number:$pr){number url state headRefName reactions(last:50){nodes{content createdAt user{login}}} baseRefName headRefOid mergeable mergeStateStatus mergeCommit{oid}
    timelineItems(last:1,itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT]){nodes{... on HeadRefForcePushedEvent{createdAt}}}
    commits(last:1){nodes{commit{oid committedDate}}}
    reviewThreads(first:100){pageInfo{hasNextPage} nodes{id isResolved isOutdated path line comments(first:1){nodes{body createdAt author{login}}}}}
    comments(last:100){nodes{id databaseId body createdAt author{login} reactions(last:50){nodes{content createdAt user{login}}}}}
    reviews(last:50){nodes{id body state submittedAt author{login} commit{oid} comments{totalCount}}}}}}`;

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

// Local reviews are posted under the user's account; this prefix marks them as reviewer output.
export const LOCAL = '[local review]';
const isLocal = (body) => typeof body === 'string' && body.startsWith(LOCAL);
export const localCleanBody = (head) => `${LOCAL} No issues found on ${head}.`;

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
  // ponytail: GitHub exposes no push time. A force-push event covers a head replaced by an older
  // commit; a fast-forward to a commit dated before an existing request is still not detected.
  const headTime = [pr.commits.nodes[0]?.commit.committedDate, pr.timelineItems?.nodes[0]?.createdAt]
    .filter(Boolean).sort().at(-1) ?? '1970-01-01T00:00:00Z';
  if (pr.reviewThreads.pageInfo?.hasNextPage) throw new Error('more than 100 review threads: prloop cannot see them all, so it fails closed');
  const isBot = (n) => cfg.reviewer.test(login(n)) || isLocal(n.body);
  const threads = pr.reviewThreads.nodes.filter((t) => !t.isResolved).map((t) => {
    const c = t.comments.nodes[0] ?? {};
    return { id: t.id, path: t.path, line: t.line, outdated: !!t.isOutdated, author: login(c), fromReviewer: isBot(c), createdAt: c.createdAt, body: (c.body ?? '').slice(0, 2000) };
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
  for (const s of summaries) {
    if (cfg.clean.test(s.body) || (isLocal(s.body) && s.body.includes(localCleanBody(head)))) signals.push({ at: s.at, state: 'clean' });
    else if (!isLocal(s.body) && cfg.unavailable.test(s.body)) signals.push({ at: s.at, state: 'unavailable' });
  }
  const newFindings = threads.filter((t) => t.fromReviewer && t.createdAt >= since);
  // A local review whose findings could not be anchored inline carries them in its body.
  const localFindingReview = botReviews.some((r) => isLocal(r.body) && !r.comments?.totalCount);
  const localArtifacts = [...pr.reviews.nodes, ...pr.comments.nodes].filter((n) => isLocal(n.body));
  const local = { total: localArtifacts.length, onHead: localArtifacts.some((n) => n.commit?.oid === head || n.body.includes(head)) };
  const requestsOnHead = pr.comments.nodes.filter((c) => !isBot(c) && c.createdAt >= headTime
    && c.body.toLowerCase().includes(cfg.trigger.toLowerCase())).length;
  const oldUnresolved = current ? threads.filter((t) => t.createdAt < triggerNode.createdAt) : [];

  signals.sort((a, b) => a.at.localeCompare(b.at));
  const reviewer = newFindings.length || localFindingReview ? 'findings' : signals.at(-1)?.state ?? 'none';
  // An automatic review has no request comment; its clock starts at the first reaction.
  const startedAt = current ? triggerNode.createdAt : signals[0]?.at;
  const age = startedAt ? nowMs - Date.parse(startedAt) : 0;
  const stale = !!startedAt && reviewer !== 'clean'
    && ((reviewer === 'none' && age >= cfg.ackTimeout) || age >= cfg.timeout);

  let verdict;
  if (reviewer === 'findings') verdict = 'findings';
  else if (oldUnresolved.length) verdict = 'requested_while_unresolved';
  else if (reviewer === 'clean') verdict = threads.length ? 'findings' : 'clean';
  else if (reviewer === 'unavailable' || (stale && requestsOnHead >= 2)) verdict = 'unavailable';
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
    pr: pr.number, url: pr.url, state: pr.state, mergeCommit: pr.mergeCommit?.oid ?? null, head, branch: pr.headRefName, base: pr.baseRefName,
    mergeable: pr.mergeable, mergeState: pr.mergeStateStatus,
    unresolvedThreads: threads,
    trigger: triggerNode && { id: triggerNode.id, databaseId: triggerNode.databaseId, createdAt: triggerNode.createdAt, afterHead: current, body: triggerNode.body },
    reviewerState: { state: reviewer, count: newFindings.length }, local,
    unavailableReason: reviewer === 'unavailable' ? 'the reviewer reported it cannot review' : verdict === 'unavailable' ? 'two requests on this head timed out' : undefined,
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
export async function waitFor(repo, prNum, cfg, { interval, fetch = fetchPr, now = Date.now, pause = sleep, cwd = process.cwd(), runLocal = localReview }) {
  for (let failures = 0; ; await pause(interval)) {
    let s;
    try { s = classify(fetch(repo, prNum), cfg, now()); failures = 0; } catch (e) {
      if (++failures >= 3) return { verdict: 'error', pr: Number(prNum), error: String(e.stderr || e.message).slice(0, 500) };
      continue;
    }
    const plan = reviewPlan(s, cfg);
    if (plan.blocked) return { verdict: 'blocked', pr: s.pr, head: s.head, reason: plan.blocked };
    if (plan.local) {
      const r = runLocal(repo, s, cfg, cwd);
      if (r) return r; // gate missing or reviewer failed; otherwise the posted result is classified next poll
      continue;
    }
    if (s.verdict !== 'pending') return finish(s);
  }
}

// Decides whether this snapshot needs a local review. Pure, so the fallback rules are testable.
export function reviewPlan(s, cfg) {
  const done = ['clean', 'findings', 'requested_while_unresolved'].includes(s.verdict);
  const wants = cfg.mode === 'local' ? !done : cfg.mode === 'auto' && s.verdict === 'unavailable';
  if (!wants) return {};
  if (s.local.onHead) return { blocked: `a local review already ran on head ${short(s.head)}; only one per head` };
  if (s.local.total >= cfg.maxLocal) return { blocked: `local review limit (${cfg.maxLocal}) reached for this PR` };
  return { local: true };
}

function finish(s) {
  const base = { verdict: s.verdict, pr: s.pr, head: s.head };
  if (s.verdict === 'clean') return { ...base, next: 'review is clean on the current head' };
  if (s.verdict === 'unavailable') return { ...base, reason: s.unavailableReason,
    next: 'the cloud reviewer is unavailable: retry later, or use `--reviewer local` or `auto` for a local review' };
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

// ---------- local review ----------

const REVIEW_SCHEMA = { type: 'object', additionalProperties: false, required: ['findings'], properties: { findings: { type: 'array', items: {
  type: 'object', additionalProperties: false, required: ['path', 'line', 'severity', 'body'], properties: {
    path: { type: 'string' }, line: { type: 'integer' }, severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] }, body: { type: 'string' } } } } } };

// Validates the reviewer's JSON; throws on anything malformed.
export function parseReview(text) {
  const obj = typeof text === 'string' ? JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) : text;
  if (!Array.isArray(obj?.findings)) throw new Error('reviewer output has no findings array');
  for (const f of obj.findings) {
    if (typeof f.path !== 'string' || !f.path || !Number.isInteger(f.line) || f.line < 0
      || !['P0', 'P1', 'P2', 'P3'].includes(f.severity) || typeof f.body !== 'string' || !f.body.trim()) {
      throw new Error(`malformed finding: ${JSON.stringify(f).slice(0, 200)}`);
    }
  }
  return obj.findings;
}

// Review payload for POST /repos/{repo}/pulls/{n}/reviews. Findings without a usable line go in the body.
export function localReviewPayload(head, findings, inline = true) {
  const inl = inline ? findings.filter((f) => f.line > 0) : [];
  const rest = findings.filter((f) => !inl.includes(f));
  return {
    commit_id: head, event: 'COMMENT',
    body: [`${LOCAL} ${findings.length} finding(s) on ${head}.`, ...rest.map((f) => `- ${f.path}${f.line ? `:${f.line}` : ''} [${f.severity}] ${f.body}`)].join('\n'),
    comments: inl.map((f) => ({ path: f.path, line: f.line, side: 'RIGHT', body: `${LOCAL} [${f.severity}] ${f.body}` })),
  };
}

function runReviewer(cfg, prompt, cwd) {
  const dir = mkdtempSync(join(tmpdir(), 'prloop-review-'));
  try {
    if (cfg.agent === 'codex') { // any other agent setting, including none, reviews with claude
      writeFileSync(join(dir, 'schema.json'), JSON.stringify(REVIEW_SCHEMA));
      const r = spawnSync('codex', ['exec', '--sandbox', 'read-only', '--output-schema', join(dir, 'schema.json'), '-o', join(dir, 'out.json'),
        ...(cfg.model ? ['-m', cfg.model] : []), ...(cfg.effort ? ['-c', `model_reasoning_effort=${cfg.effort}`] : []), prompt],
      { cwd, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
      if (r.status !== 0) throw new Error(`codex reviewer exited with ${r.status}: ${(r.stderr ?? '').slice(-300)}`);
      return parseReview(readFileSync(join(dir, 'out.json'), 'utf8'));
    }
    const r = spawnSync('claude', ['-p', prompt, '--model', cfg.model ?? 'claude-opus-5-5', '--effort', cfg.effort ?? 'medium',
      '--permission-mode', 'dontAsk', '--allowedTools', 'Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git show:*)',
      '--output-format', 'json', '--json-schema', JSON.stringify(REVIEW_SCHEMA)],
    { cwd, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.status !== 0) throw new Error(`claude reviewer exited with ${r.status}: ${(r.stderr ?? '').slice(-300)}`);
    const out = JSON.parse(r.stdout);
    return parseReview(out.structured_output ?? out.result);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// Runs one read-only review of the current head in `cwd` and posts it. Returns a verdict to stop on,
// or null when the result was posted and the next poll should classify it.
export function localReview(repo, s, cfg, cwd) {
  const missing = s.unresolvedThreads.length ? [`${s.unresolvedThreads.length} unresolved threads`] : [];
  if (tryGit(['branch', '--show-current'], cwd) !== s.branch) missing.push(`run wait inside a checkout of ${s.branch} for a local review`);
  else missing.push(...localGate(s, cwd));
  if (missing.length) return { verdict: 'not_requested', pr: s.pr, head: s.head, missing, next: `a local review needs: ${missing.join('; ')}` };
  tryGit(['fetch', '--quiet', 'origin', s.base], cwd);
  const prompt = `Review pull request #${s.pr}: the changes in \`git diff origin/${s.base}...HEAD\` at head ${s.head}.
Do not modify any file. Report only real defects (bugs, security, data loss, broken contracts), not style.
Return JSON {"findings":[{"path","line","severity":"P0".."P3","body"}]} with "line" in the new file (0 if none) and an empty array when there are no issues.`;
  let findings;
  try { findings = runReviewer(cfg, prompt, cwd); } catch (e) {
    return { verdict: 'blocked', pr: s.pr, head: s.head, reason: `local reviewer failed: ${String(e.message).slice(0, 400)}` };
  }
  if (git(['status', '--porcelain'], cwd) || git(['rev-parse', 'HEAD'], cwd) !== s.head) {
    return { verdict: 'blocked', pr: s.pr, head: s.head, reason: 'the local reviewer changed the checkout; review discarded' };
  }
  const post = (path, body) => sh('gh', ['api', '-X', 'POST', path, '--input', '-'], { input: JSON.stringify(body), stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    if (!findings.length) post(`repos/${repo}/issues/${s.pr}/comments`, { body: localCleanBody(s.head) });
    else {
      try { post(`repos/${repo}/pulls/${s.pr}/reviews`, localReviewPayload(s.head, findings)); }
      catch { post(`repos/${repo}/pulls/${s.pr}/reviews`, localReviewPayload(s.head, findings, false)); } // a line outside the diff
    }
  } catch (e) {
    return { verdict: 'blocked', pr: s.pr, head: s.head, reason: `posting the local review failed: ${String(e.stderr || e.message).slice(0, 300)}` };
  }
  return null;
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
      v = await waitFor(repo, prNum, cfg, { interval: cfg.interval, cwd: cwd ?? process.cwd() });
    }
    st.lastVerdict = v.verdict;
    if (v.verdict === 'error' || v.verdict === 'blocked' || v.verdict === 'unavailable') return blocked(v.error ?? v.reason ?? 'wait failed');
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
      const missing = cwd ? localGate(s, cwd) : [`no worktree for ${s.branch} to confirm the head was tested; pass --worktree`];
      if (!missing.length) {
        if (s.mergeable !== 'MERGEABLE') return blocked(`GitHub reports mergeable=${s.mergeable}, mergeState=${s.mergeState}`);
        sh('gh', ['pr', 'merge', String(prNum), '--repo', repo, `--${opts.merge}`, '--match-head-commit', s.head]);
        // A merge queue or auto-merge accepts the command without merging yet: report the real state.
        for (let i = 0; i < 6 && s.state !== 'MERGED'; i++) { await sleep(5000); s = classify(fetchPr(repo, prNum), cfg); }
        st.result = s.state === 'MERGED' ? 'merged' : 'merge_pending'; saveState(repo, prNum, st);
        return { pr: prNum, verdict: st.result, head: v.head, state: s.state, mergeCommit: s.mergeCommit };
      }
      if (!cwd) return blocked(missing[0]);
      v = { verdict: 'not_tested', pr: prNum, head: s.head, missing,
        next: `review is clean but the merge gate is not met: ${missing.join('; ')}. Run the gate on this head and \`prloop mark-tested\`; do not request another review unless the head changes` };
    }
    if (++st.rounds > maxRounds) return blocked(`max rounds (${maxRounds}) reached`, { last: v.verdict });
    if (v.verdict === 'findings') {
      const repeated = recordFindings(st.seen, v.findings);
      if (repeated.length) return blocked('the same finding came back after two fixes', { fingerprints: repeated });
    }
    saveState(repo, prNum, st);
    const prompt = buildPrompt(repo, v);
    if (cfg.agent === 'none') return { ...v, prompt };
    if (!cwd) return blocked(`no worktree checked out for ${s.branch}; pass --worktree`);
    const before = classify(fetchPr(repo, prNum), cfg);
    const r = runAgent(cfg.agent, prompt, cwd, opts);
    if (DENIED.test(r.output)) return blocked('agent reported a permission denial', { output: r.output.slice(-800) });
    if (r.status !== 0) return blocked(`agent exited with status ${r.status}`, { output: r.output.slice(-800) });
    const after = classify(fetchPr(repo, prNum), cfg);
    const progressed = after.head !== before.head || after.unresolvedThreads.length < before.unresolvedThreads.length
      || (after.trigger?.id && after.trigger.id !== before.trigger?.id) || (v.verdict === 'not_tested' && isTested(after.head, cwd));
    if (!progressed) return blocked('agent pushed no commit, resolved no thread and posted no request');
  }
}

// blocked wins; otherwise the first verdict that still needs action; 0 when all are done.
export function runExitCode(results) {
  const codes = results.map((r) => EXIT[r.verdict] ?? 0);
  return codes.includes(EXIT.blocked) ? EXIT.blocked : codes.find(Boolean) ?? 0;
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
      const code = runExitCode(results);
      return out(results.length === 1 ? results[0] : { results }, code);
    }
    if (!prArg) throw new Error(`${cmd} needs a PR number`);
    const repo = resolveRepo(opts);
    if (cmd === 'status') {
      const s = classify(fetchPr(repo, prArg), cfg);
      const local = tryGit(['rev-parse', '--git-dir']) ? localGate(s, process.cwd()) : [];
      const unresolvedThreads = s.unresolvedThreads.map((t) => ({ ...t, body: t.body.slice(0, 300) }));
      return out({ ...s, unresolvedThreads, reasons: [...s.reasons, ...local], readyToRequest: s.readyToRequest && !local.length,
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
