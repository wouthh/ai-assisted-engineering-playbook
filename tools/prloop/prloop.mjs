#!/usr/bin/env node
// prloop: wait for an external PR reviewer bot and tell the agent what to do next.
// Single file, no dependencies. Needs Node 20+, git and an authenticated `gh`.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism, freemem, homedir, loadavg, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const EXIT = { clean: 0, findings: 10, not_requested: 20, requested_while_unresolved: 21, not_tested: 22, timeout: 30, unavailable: 31, error: 40, conflict: 41, blocked: 50 };

const HELP = `prloop - wait for a PR review bot, gate review requests, and supervise fix agents.

Recommended: start the supervisor once in the background, check in with --status.
  prloop run --repo owner/name --pr N[,N...] [--gate "<cmd>"] [--max-agents 2] [--max-rounds 6]
             [--agent claude|codex|none] [--merge rebase|squash|merge|repo] [--worktree <path>]
             [--deadline 6h] [--model <m>] [--effort <e>] [--union <glob>]...
  prloop run --status [--repo owner/name]   PR states plus one machine line (load, free memory, gate slots)
  prloop reset-rounds <pr> [--repo owner/name]   one explicit, logged reset of the round counter
  prloop lock-status [<dir>]              who holds the worktree lock of <dir> (default: .); exit 50 when held

Agent-in-the-loop commands:
  prloop status <pr> [--repo owner/name]
  prloop ready <pr> [--gate "<cmd>"] [--force-gate]
                                         runs the gate (skipped when it already passed on this clean tree),
                                         marks the head tested, checks the request gate
  prloop mark-tested [--sha <sha>] [--gate "<cmd>"]
                                         manual escape hatch; with --gate, records that this gate passed on the clean tree
  prloop wait <pr>
  prloop sync <pr> [--union <glob>]...

Options (flag or env):
  --gate <cmd>              PRLOOP_GATE            the project's full validation command
  --reviewer cloud|local|auto  PRLOOP_REVIEWER     default: auto (local review when the bot is unavailable)
  --reviewer-login <regex>  PRLOOP_REVIEWER_LOGIN  default: exactly chatgpt-codex-connector
  --trigger <text>          PRLOOP_TRIGGER         default: @codex review
  --clean-regex <regex>     PRLOOP_CLEAN_REGEX     default: didn.t find any major issues
  --unavailable-regex <re>  PRLOOP_UNAVAILABLE_REGEX  bot replies that mean it cannot review
  --timeout <dur>           PRLOOP_TIMEOUT         default: 40m after the request
  --ack-timeout <dur>       PRLOOP_ACK_TIMEOUT     default: 3m without any reaction
  --interval <dur>          PRLOOP_INTERVAL        default: 75s between polls
  --max-local-reviews <n>   PRLOOP_MAX_LOCAL_REVIEWS  default: 3 per PR
  --agent claude|codex|none PRLOOP_AGENT           fix agent and local reviewer; --model, --effort
  --agent-timeout <dur>     PRLOOP_AGENT_TIMEOUT   default: 90m of work (gate queueing not counted); kills the agent
  --gate-weight <w>         PRLOOP_GATE_WEIGHT     light (skips the slot queue while load allows), heavy, or a slot count
  --review-before-gate <b>  PRLOOP_REVIEW_BEFORE_GATE  true: request the review first, run the gate in parallel
                                                   default: true for a declared heavy gate

Per repository: .prloop.json in the repository root may set gate, gateWeight, union, merge (the method
for --merge repo) and reviewBeforeGate; flags and environment override it.

Self-check: \`run\` and \`ready\` warn when prloop's own checkout is dirty, off its default branch or behind it.
  --require-current         PRLOOP_REQUIRE_CURRENT=1  fail with a usage error instead of warning

Machine resources (on by default; shared by every prloop process of the user; defaults may be set in
<state dir>/config.json as gateSlots, maxLoad, minFreeMem, resourceWait and gateTmpdir):
  --gate-slots <n>          PRLOOP_GATE_SLOTS      default: 2 gates at once, machine-wide
  --max-load <x>            PRLOOP_MAX_LOAD        default: 0.75 x CPU cores (1-minute load average)
  --min-free-mem <size>     PRLOOP_MIN_FREE_MEM    default: the larger of 4G and 10% of RAM
  --resource-wait <dur>     PRLOOP_RESOURCE_WAIT   default: 30m, then proceed with one slot only
  --gate-tmpdir <dir>       PRLOOP_GATE_TMPDIR     run each gate and agent with a private TMPDIR under <dir>

Exit codes: 0 clean/ok/merged, 10 findings, 20 not_requested, 21 requested_while_unresolved, 22 not_tested,
            30 timeout, 31 unavailable, 40 error, 41 conflict, 50 blocked / not ready / needs a human / merge pending.`;

// ---------- small helpers ----------

const FLAGS = new Set(['help', 'status', 'requireCurrent', 'forceGate']);

// Every option except FLAGS takes a value; a missing one fails instead of becoming `true`.
export function parseArgs(argv) {
  const out = { _: [], union: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const [k, inline] = a.slice(2).split(/=(.*)/s);
    const key = k.replace(/-(\w)/g, (_, c) => c.toUpperCase());
    const val = FLAGS.has(key) ? true : inline ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : undefined);
    if (val === undefined) throw new Error(`--${k} needs a value`);
    if (key === 'union') out.union.push(val); else out[key] = val;
  }
  return out;
}

export function parseDuration(s, name = 'duration') {
  const m = /^(\d+)(s|m|h)?$/.exec(String(s));
  const ms = m ? Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5 }[m[2] ?? 's'] : NaN;
  // Zero or NaN would make a wait spin or a deadline pass at once.
  if (!(ms > 0) || !Number.isFinite(ms)) throw new Error(`--${name} must be a positive duration such as 90s, 40m or 6h, not ${s}`);
  return ms;
}

// NaN or Infinity (a long digit string) would make a cap check never trip, and zero agents would never start one.
const positiveInt = (name, v) => {
  if (!/^\d+$/.test(String(v)) || !(Number(v) > 0) || !Number.isSafeInteger(Number(v))) throw new Error(`--${name} must be a positive integer, not ${v}`);
  return Number(v);
};

// Undefined keeps the per-machine default, computed when the metrics are read.
const positiveNumber = (name, v) => {
  if (v === undefined) return undefined;
  if (!/^\d+(\.\d+)?$/.test(String(v)) || !(Number(v) > 0) || !Number.isFinite(Number(v))) throw new Error(`--${name} must be a positive number, not ${v}`);
  return Number(v);
};

// Binary units: 512M, 4G, 4GiB or plain bytes.
export function parseSize(v, name = 'min-free-mem') {
  if (v === undefined) return undefined;
  const m = /^(\d+(?:\.\d+)?)\s*([KMGT]?)(i?B)?$/i.exec(String(v));
  const bytes = m ? Math.round(Number(m[1]) * 1024 ** ' KMGT'.indexOf(m[2].toUpperCase() || ' ')) : NaN;
  if (!(bytes > 0) || !Number.isSafeInteger(bytes)) throw new Error(`--${name} must be a positive size such as 512M or 4G, not ${v}`);
  return bytes;
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
// Explicit flags so user or repository config cannot hide untracked files or dirty submodules.
// --no-optional-locks: a status check must not refresh and rewrite the index (see git-status "Background refresh").
const dirty = (cwd) => git(['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'], cwd) !== '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (sha) => (sha ?? '').slice(0, 7);

// Values that one key of a config file may hold; anything else is a usage error, not a silent default.
const REPO_KEYS = { gate: 'string', gateWeight: 'string|number', union: 'array', merge: 'string', reviewBeforeGate: 'boolean' };
const MACHINE_KEYS = { gateSlots: 'number|string', maxLoad: 'number|string', minFreeMem: 'number|string', resourceWait: 'string', gateTmpdir: 'string' };
function readConfigFile(file, keys) {
  if (!file || !existsSync(file)) return {};
  let obj;
  try { obj = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new Error(`${file}: ${e.message}`); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error(`${file} must hold a JSON object`);
  for (const [k, v] of Object.entries(obj)) {
    const type = Array.isArray(v) ? 'array' : typeof v;
    if (!keys[k]) throw new Error(`${file}: unknown key ${k} (known: ${Object.keys(keys).join(', ')})`);
    if (!keys[k].split('|').includes(type) || (type === 'array' && !v.every((x) => typeof x === 'string'))) throw new Error(`${file}: ${k} must be ${keys[k]}`);
  }
  return obj;
}
// One machine-wide setting for every prloop process of the user: gate slots and resource limits.
export const machineConfig = () => readConfigFile(join(stateDir(), 'config.json'), MACHINE_KEYS);
// The repository's own declaration of its gate, in the root of the checkout `cwd` belongs to.
export const repoConfig = (cwd) => { const top = tryGit(['rev-parse', '--show-toplevel'], cwd); return readConfigFile(top && join(top, '.prloop.json'), REPO_KEYS); };

// light (a short gate) costs 0: it skips the slot queue while load and memory allow; heavy or N take 1 or N slots.
export function gateCost(w) {
  if (w === undefined || w === 'heavy') return 1;
  if (w === 'light') return 0;
  const n = Number(w);
  if (!(n > 0) || !Number.isFinite(n) || (n >= 1 && !Number.isInteger(n))) throw new Error(`--gate-weight must be light, heavy or a positive slot count, not ${w}`);
  return n < 1 ? 0 : n;
}

const bool = (name, v) => {
  if (v === undefined || typeof v === 'boolean') return v;
  if (/^(true|1|yes)$/i.test(v)) return true;
  if (/^(false|0|no)$/i.test(v)) return false;
  throw new Error(`--${name} must be true or false, not ${v}`);
};

// Precedence: flag, environment, repository file (.prloop.json), machine file (<state dir>/config.json), default.
export function config(opts, env = process.env, { machine = {}, repo = {} } = {}) {
  const agent = String(opts.agent ?? env.PRLOOP_AGENT ?? 'claude');
  // Any other value would fall through to the write-enabled Claude agent.
  if (!['claude', 'codex', 'none'].includes(agent)) throw new Error(`--agent must be claude, codex or none, not ${agent}`);
  const maxLocal = String(opts.maxLocalReviews ?? env.PRLOOP_MAX_LOCAL_REVIEWS ?? 3);
  // NaN would make the cap check always false and silently lift it.
  if (!/^\d+$/.test(maxLocal)) throw new Error(`--max-local-reviews must be a nonnegative integer, not ${maxLocal}`);
  const mode = String(opts.reviewer ?? env.PRLOOP_REVIEWER ?? 'auto');
  const gateWeight = opts.gateWeight ?? env.PRLOOP_GATE_WEIGHT ?? repo.gateWeight;
  return {
    mode,
    // Anchored: any account whose login merely contains the bot's name could otherwise approve.
    reviewer: new RegExp(opts.reviewerLogin ?? env.PRLOOP_REVIEWER_LOGIN ?? '^chatgpt-codex-connector(\\[bot\\])?$', 'i'),
    // Phrasings seen from the Codex connector when it cannot review.
    unavailable: new RegExp(opts.unavailableRegex ?? env.PRLOOP_UNAVAILABLE_REGEX
      ?? 'reached your .*usage limits|couldn.t complete this request|unable to review|quota', 'i'),
    maxLocal: Number(maxLocal),
    agent,
    model: opts.model ?? env.PRLOOP_MODEL,
    effort: opts.effort ?? env.PRLOOP_EFFORT,
    gate: opts.gate ?? env.PRLOOP_GATE ?? repo.gate,
    forceGate: !!opts.forceGate,
    agentTimeout: parseDuration(opts.agentTimeout ?? env.PRLOOP_AGENT_TIMEOUT ?? '90m', 'agent-timeout'),
    trigger: String(opts.trigger ?? env.PRLOOP_TRIGGER ?? '@codex review'),
    clean: new RegExp(opts.cleanRegex ?? env.PRLOOP_CLEAN_REGEX ?? 'didn.t find any major issues', 'i'),
    timeout: parseDuration(opts.timeout ?? env.PRLOOP_TIMEOUT ?? '40m', 'timeout'),
    ackTimeout: parseDuration(opts.ackTimeout ?? env.PRLOOP_ACK_TIMEOUT ?? '3m', 'ack-timeout'),
    interval: parseDuration(opts.interval ?? env.PRLOOP_INTERVAL ?? '75s', 'interval'),
    deadline: parseDuration(opts.deadline ?? '6h', 'deadline'),
    maxRounds: positiveInt('max-rounds', opts.maxRounds ?? 6),
    maxAgents: positiveInt('max-agents', opts.maxAgents ?? 2),
    gateSlots: positiveInt('gate-slots', opts.gateSlots ?? env.PRLOOP_GATE_SLOTS ?? machine.gateSlots ?? 2),
    maxLoad: positiveNumber('max-load', opts.maxLoad ?? env.PRLOOP_MAX_LOAD ?? machine.maxLoad),
    minFreeMem: parseSize(opts.minFreeMem ?? env.PRLOOP_MIN_FREE_MEM ?? machine.minFreeMem),
    resourceWait: parseDuration(opts.resourceWait ?? env.PRLOOP_RESOURCE_WAIT ?? machine.resourceWait ?? '30m', 'resource-wait'),
    gateTmpdir: (tmp => tmp && resolve(tmp))(opts.gateTmpdir ?? env.PRLOOP_GATE_TMPDIR ?? machine.gateTmpdir),
    gateWeight, gateCost: gateCost(gateWeight),
    // A local review needs the gate first, so --reviewer local always gates before the review.
    reviewBeforeGate: mode !== 'local' && (bool('review-before-gate', opts.reviewBeforeGate ?? env.PRLOOP_REVIEW_BEFORE_GATE ?? repo.reviewBeforeGate)
      ?? (gateWeight !== undefined && gateCost(gateWeight) >= 1)),
  };
}

// ---------- GitHub reads ----------

const PR_QUERY = `query($owner:String!,$name:String!,$pr:Int!){viewer{login} repository(owner:$owner,name:$name){
  mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed
  pullRequest(number:$pr){number url state headRefName reactions(last:50){pageInfo{hasPreviousPage} nodes{content createdAt user{login}}} baseRefName baseRefOid headRefOid mergeable mergeStateStatus mergeCommit{oid}
    timelineItems(last:1,itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT]){nodes{... on HeadRefForcePushedEvent{createdAt}}}
    commits(last:1){nodes{commit{oid committedDate}}}
    reviewThreads(first:100){pageInfo{hasNextPage} nodes{id isResolved isOutdated path line comments(first:100){pageInfo{hasNextPage} nodes{body createdAt author{login} pullRequestReview{state}}}}}
    comments(last:100){pageInfo{hasPreviousPage} nodes{id databaseId body createdAt author{login} reactions(last:50){nodes{content createdAt user{login}}}}}
    reviews(last:50){pageInfo{hasPreviousPage} nodes{id body state submittedAt author{login} commit{oid} comments{totalCount}}}}}}`;

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
  const { viewer, repository: r } = JSON.parse(out).data;
  if (!r?.pullRequest) throw new Error(`PR ${repo}#${pr} not found`);
  return { ...r.pullRequest, viewer, headSeenAt: headSeenAt(`${repo}#${pr}`, r.pullRequest.headRefOid), carry: loadState(repo, pr).carry,
    repoSettings: { merge: r.mergeCommitAllowed, squash: r.squashMergeAllowed, rebase: r.rebaseMergeAllowed } };
}

// When prloop saw this PR's current head become its head. GitHub exposes no push time, and a
// fast-forward or a return to an earlier SHA keeps an old committer date, so this local observation of
// each head transition is the lower bound for current-head evidence. It errs safe: a signal posted
// before prloop noticed the change is ignored, costing at most a re-request.
export function headSeenAt(key, sha) {
  const f = join(stateDir(), 'heads.json');
  let seen = {};
  try { seen = JSON.parse(readFileSync(f, 'utf8')); } catch { /* first use */ }
  if (seen[key]?.sha !== sha) {
    seen[key] = { sha, at: new Date().toISOString() };
    seen = Object.fromEntries(Object.entries(seen).sort((a, b) => a[1].at.localeCompare(b[1].at)).slice(-500)); // bounded
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(f, JSON.stringify(seen));
  }
  return seen[key].at;
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

// A commit named in a comment is this head only as the full OID, or as an abbreviation that resolves to exactly
// this one object in the local repository: a bare prefix match could name another commit with the same prefix.
export const disambiguate = (prefix, cwd) => (tryGit(['rev-parse', `--disambiguate=${prefix}`], cwd) ?? '').split('\n').filter(Boolean);
const namesHead = (named, head, cfg) => (named.length === 40 ? named === head : (cfg.disambiguate ?? disambiguate)(named).join() === head);

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
  // GitHub exposes no push time: take the latest of the commit date, the last force-push and when prloop
  // first saw this head, so an older commit that becomes the head cannot inherit earlier signals.
  const headTime = [pr.commits.nodes[0]?.commit.committedDate, pr.timelineItems?.nodes[0]?.createdAt, pr.headSeenAt]
    .filter(Boolean).sort().at(-1) ?? '1970-01-01T00:00:00Z';
  if (pr.reviewThreads.pageInfo?.hasNextPage) throw new Error('more than 100 review threads: prloop cannot see them all, so it fails closed');
  // Local review output counts only from the authenticated user who posts it; anyone can type the prefix.
  const trusted = (n) => isLocal(n.body) && !!pr.viewer?.login && login(n) === pr.viewer.login;
  const isBot = (n) => cfg.reviewer.test(login(n)) || trusted(n);
  // Inline comments of a dismissed bot review stay as unresolved threads; that review was withdrawn, so they are
  // dropped too, unless any reply is not from a bot (or unseen): that is human feedback, as are a dismissed human review's threads.
  const dismissedBot = (t) => t.comments.nodes[0]?.pullRequestReview?.state === 'DISMISSED' && !t.comments.pageInfo?.hasNextPage
    && t.comments.nodes.every(isBot);
  const threads = pr.reviewThreads.nodes.filter((t) => !t.isResolved && !dismissedBot(t)).map((t) => {
    const c = t.comments.nodes[0] ?? {};
    return { id: t.id, path: t.path, line: t.line, outdated: !!t.isOutdated, author: login(c), fromReviewer: isBot(c), createdAt: c.createdAt, body: (c.body ?? '').slice(0, 2000) };
  });
  const triggerNode = [...pr.comments.nodes].reverse()
    .find((c) => !isBot(c) && c.body.toLowerCase().includes(cfg.trigger.toLowerCase()));
  const current = !!triggerNode && triggerNode.createdAt >= headTime;
  if (!current && pr.comments.pageInfo?.hasPreviousPage && pr.comments.nodes[0]?.createdAt > headTime) {
    throw new Error('more than 100 comments since the head commit: prloop cannot see a possible request, so it fails closed');
  }
  const since = current ? triggerNode.createdAt : headTime;

  // A requested review reacts on the request, or on the PR body after the request. Without a request, PR-body reactions
  // count only once the bot has started (👀) after this head, so a late 👍 from a review of the previous head cannot clear this one.
  // PR-body reactions carry no commit or request: with a request, a body 👍 never counts, even after this cycle's 👀, since a
  // previous head's review still in flight may post it then. A requested result must be bound to the request or the head.
  const bodyReactions = (pr.reactions?.nodes ?? []).filter((r) => isBot(r) && r.createdAt >= headTime);
  // A PR-body 👀 from before the current request belongs to an earlier cycle and cannot acknowledge this one.
  const ackAt = [...(current ? triggerNode.reactions.nodes : []), ...bodyReactions].filter((r) => r.createdAt >= since)
    .filter((r) => isBot(r) && r.content === 'EYES').map((r) => r.createdAt).sort()[0];
  const reactions = current ? [...triggerNode.reactions.nodes, ...bodyReactions.filter((r) => r.content === 'EYES')]
    : bodyReactions.some((r) => r.content === 'EYES') ? bodyReactions : [];
  const signals = reactions
    .filter((r) => isBot(r) && r.createdAt >= since && (r.content === 'EYES' || r.content === 'THUMBS_UP'))
    .map((r) => ({ at: r.createdAt, state: r.content === 'EYES' ? 'reviewing' : 'clean' }));
  // A dismissed review was withdrawn: it is neither a clean nor a findings signal.
  const botReviews = pr.reviews.nodes.filter((r) => isBot(r) && r.state !== 'DISMISSED' && r.commit?.oid === head && r.submittedAt >= since);
  // Issue comments carry no commit: they count only after a request or a 👀 on this head, and a clean or
  // failure one only after the bot acknowledged this cycle (👀 on the current request or on the PR body after this head), so a
  // delayed comment about the previous head cannot clear this one, even after a new request. Local clean
  // bodies name the head.
  const started = current || bodyReactions.some((r) => r.content === 'EYES');
  const botComments = pr.comments.nodes.filter((c) => isBot(c) && c.createdAt >= since && (started || trusted(c)));
  const summaries = [...botReviews.map((r) => ({ at: r.submittedAt, body: r.body, local: trusted(r), acked: true })),
    ...botComments.map((c) => ({ at: c.createdAt, body: c.body, local: trusted(c), acked: !!ackAt && c.createdAt >= ackAt,
      named: /Reviewed commit:\W*([0-9a-f]{7,40})/i.exec(c.body)?.[1] }))]
    .filter((s) => s.body);
  // Without an acknowledgement, a clean comment after the current request counts only when it names this head.
  // A comment naming another commit never clears this head.
  const cleanOk = (s) => (s.named ? namesHead(s.named.toLowerCase(), head, cfg) && (s.acked || current) : s.acked);
  for (const s of summaries) {
    if (s.local ? s.body.includes(localCleanBody(head)) : cleanOk(s) && cfg.clean.test(s.body)) signals.push({ at: s.at, state: 'clean' });
    else if (!s.local && s.acked && cfg.unavailable.test(s.body)) signals.push({ at: s.at, state: 'unavailable' });
  }
  const newFindings = threads.filter((t) => t.fromReviewer && t.createdAt >= since);
  // A local review whose findings could not be anchored inline carries them in its body.
  const localFindingReview = botReviews.some((r) => trusted(r) && !r.comments?.totalCount);
  const localArtifacts = [...pr.reviews.nodes, ...pr.comments.nodes].filter(trusted);
  const local = { truncated: !!(pr.comments.pageInfo?.hasPreviousPage || pr.reviews.pageInfo?.hasPreviousPage),
    total: localArtifacts.length, onHead: localArtifacts.some((n) => n.commit?.oid === head || n.body.includes(head)) };
  const requestsOnHead = pr.comments.nodes.filter((c) => !isBot(c) && c.createdAt >= headTime
    && c.body.toLowerCase().includes(cfg.trigger.toLowerCase())).length;
  const oldUnresolved = current ? threads.filter((t) => t.createdAt < triggerNode.createdAt) : [];

  // A sync that left the PR's own change identical carries the previous head's clean verdict to this head.
  // It counts as the earliest signal, so any real review of this head overrides it, and a new request on
  // this head supersedes it: that review stays pending until its own cycle completes.
  const carried = pr.carry?.to === head && !current ? pr.carry : null;
  if (carried) signals.push({ at: headTime, state: 'clean' });
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
  if (reviewer === 'clean') reasons.push(`head ${short(head)} is already reviewed clean${carried && signals.at(-1).at === headTime ? ` (carried from ${short(carried.from)}: unchanged patch-id)` : ''}`);

  return {
    pr: pr.number, url: pr.url, state: pr.state, mergeCommit: pr.mergeCommit?.oid ?? null, head, branch: pr.headRefName, base: pr.baseRefName, baseOid: pr.baseRefOid,
    mergeable: pr.mergeable, mergeState: pr.mergeStateStatus,
    unresolvedThreads: threads,
    trigger: triggerNode && { id: triggerNode.id, databaseId: triggerNode.databaseId, createdAt: triggerNode.createdAt, afterHead: current, body: triggerNode.body },
    reviewerState: { state: reviewer, count: newFindings.length }, local, carry: carried,
    unavailableReason: reviewer === 'unavailable' ? 'the reviewer reported it cannot review' : verdict === 'unavailable' ? 'two requests on this head timed out' : undefined,
    summaries: summaries.map((s) => s.body.slice(0, 600)),
    triggerText: cfg.trigger, rerequestBody: triggerNode?.body ?? cfg.trigger,
    verdict, readyToRequest: reasons.length === 0, reasons,
  };
}

// ---------- machine resources ----------
// Several prloop processes and unrelated work can share one machine: agents and gates start only while the
// load average and free memory allow it, and gates take one of N slots shared by all of the user's prloop
// processes. None of this can deadlock: a resource wait ends after --resource-wait with one slot only.

const GiB = 2 ** 30;
const SLOT_POLL = 5e3;
const gib = (b) => (b / GiB).toFixed(1);
const logStderr = (e) => console.error(JSON.stringify({ at: new Date().toISOString(), ...e }));
// One directory per UID, whatever the session's environment: an interactive shell, cron, CI and sudo of one
// account must share one slot pool, and a shared name would collide between accounts.
export const slotDir = () => join('/tmp', `prloop-slots-${process.getuid?.() ?? 'user'}`);

// MemAvailable counts reclaimable page cache; os.freemem() does not, so it is only the fallback.
export function machineMetrics() {
  let freeMem = freemem();
  try { const m = /^MemAvailable:\s+(\d+) kB/m.exec(readFileSync('/proc/meminfo', 'utf8')); if (m) freeMem = Number(m[1]) * 1024; } catch { /* not Linux */ }
  return { load: loadavg()[0], cores: availableParallelism(), freeMem, totalMem: totalmem() };
}

export const limits = (cfg, m) => ({ maxLoad: cfg.maxLoad ?? 0.75 * m.cores, minFreeMem: cfg.minFreeMem ?? Math.max(4 * GiB, Math.round(0.1 * m.totalMem)) });

// One admission check. `w` tracks one wait period: `waiting_for_resources` is logged once when it starts and
// `resource_wait_expired` once after --resource-wait. Returns ok, wait, or expired (proceed with one slot only).
export function admitStep(w, cfg, m, now, log) {
  const { maxLoad, minFreeMem } = limits(cfg, m);
  if (m.load <= maxLoad && m.freeMem >= minFreeMem) { delete w.since; delete w.expired; return 'ok'; }
  const numbers = { load: Number(m.load.toFixed(2)), maxLoad: Number(maxLoad.toFixed(2)), freeGiB: Number(gib(m.freeMem)), minFreeGiB: Number(gib(minFreeMem)) };
  if (w.since === undefined) { w.since = now; log({ event: 'waiting_for_resources', ...numbers }); }
  if (now - w.since < cfg.resourceWait) return 'wait';
  if (!w.expired) { w.expired = true; log({ event: 'resource_wait_expired', proceeding: 'with one slot only', ...numbers }); }
  return 'expired';
}

// Blocks until admitted; checks every --interval. Pass the same `w` to keep one wait period across calls.
export async function admit(cfg, { metrics = machineMetrics, now = Date.now, pause = sleep, log = logStderr } = {}, w = {}) {
  for (;;) {
    const r = admitStep(w, cfg, metrics(), now(), log);
    if (r !== 'wait') return r;
    await pause(cfg.interval);
  }
}

// A process instance is its PID plus, where /proc exposes it (Linux), its start time in clock ticks since boot,
// so a claim of a crashed process is not kept alive by an unrelated process that later reuses its PID.
export const procStart = (pid) => { try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' ')[19] ?? null; } catch { return null; } };
const alive = (pid, start) => {
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  return !start || procStart(pid) === null || procStart(pid) === start;
};
// A claim also lists the children its owner spawned (a gate shell, an agent): a child outlives a killed prloop,
// so the claim stays live while the owner or any listed child runs.
const anyAlive = (children = []) => children.some((c) => alive(c.pid, c.start));
const child = (pid) => ({ pid, start: procStart(pid) });
// Slot claim content: the owner's start time, then one `<pid> <start>` line per child.
const slotClaimAlive = (file, pid) => {
  let lines;
  try { lines = readFileSync(file, 'utf8').split('\n'); } catch { lines = ['']; }
  const kids = lines.slice(1).filter(Boolean).map((l) => { const [p, st] = l.split(' '); return { pid: Number(p), start: st || null }; });
  return alive(pid, lines[0].trim() || null) || anyAlive(kids);
};

function ensureSlotDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid()) || (st.mode & 0o022)) {
    throw new Error(`gate slot directory ${dir} must be a directory owned by you and writable only by you`);
  }
}

// Slot claims are files named slot-<i>.<pid>.<n> holding the owner's start time. A claim whose process is gone
// (killed, crashed, PID reused) is stale and removed; its name is unique, so removing it can never delete a live claim.
let claims = 0;
const liveClaims = (dir, i, mine) => readdirSync(dir).filter((f) => {
  const m = /^slot-(\d+)\.(\d+)\.\d+$/.exec(f);
  if (!m || Number(m[1]) !== i || f === mine) return false;
  if (slotClaimAlive(join(dir, f), Number(m[2]))) return true;
  rmSync(join(dir, f), { force: true });
  return false;
});

// Takes the first free of `slots` slots; returns a release function, whose adopt(pid) adds a child, or null. A process writes its claim and then
// keeps it only if no other live claim exists for that slot: of two racing claims, the later check always sees
// the earlier claim, so at most one keeps the slot (both may back off and retry on the next poll).
export function acquireSlot(dir, slots, pid = process.pid) {
  ensureSlotDir(dir);
  for (let i = 0; i < slots; i++) {
    if (liveClaims(dir, i).length) continue;
    const name = `slot-${i}.${pid}.${claims++}`;
    writeFileSync(join(dir, name), procStart(pid) ?? '', { flag: 'wx' });
    if (!liveClaims(dir, i, name).length) {
      const release = () => rmSync(join(dir, name), { force: true });
      release.adopt = (pid) => { const c = child(pid); appendFileSync(join(dir, name), `\n${c.pid} ${c.start ?? ''}`); };
      return release;
    }
    rmSync(join(dir, name), { force: true });
  }
  return null;
}

// ---------- worktree lock ----------

// One writer per worktree. Claims are files <git-dir>/prloop-lock/<pid>.<n> holding { pid, start, startedAt, purpose, token },
// taken with the same claim-then-recheck scheme as gate slots; a claim of a dead process is removed (its name is unique).
// The token reaches a spawned agent as PRLOOP_LOCK_TOKEN, so its own `ready`, `sync` and `mark-tested` calls pass.
const lockDir = (cwd) => { const g = tryGit(['rev-parse', '--absolute-git-dir'], cwd); return g && join(g, 'prloop-lock'); };
const lockClaims = (dir, mine) => (existsSync(dir) ? readdirSync(dir) : []).flatMap((f) => {
  if (f === mine || f.startsWith('.')) return [];
  let c;
  try { c = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { c = { pid: Number(f.split('.')[0]) }; } // still being written
  if (alive(c.pid, c.start) || anyAlive(c.children)) return [c];
  rmSync(join(dir, f), { force: true });
  return [];
});

// Returns { token, release, adopt(pid) } or { holder } when another live process holds the worktree.
export function takeLock(cwd, purpose, pid = process.pid) {
  const dir = lockDir(cwd);
  if (!dir) throw new Error(`${cwd} is not a Git worktree`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const [held] = lockClaims(dir);
  if (held) return { holder: held };
  const name = `${pid}.${claims++}`, token = randomUUID();
  const claim = { pid, start: procStart(pid), startedAt: new Date().toISOString(), purpose, token, children: [] };
  writeFileSync(join(dir, name), JSON.stringify(claim), { flag: 'wx', mode: 0o600 });
  const [other] = lockClaims(dir, name);
  if (other) { rmSync(join(dir, name), { force: true }); return { holder: other }; }
  // Written to a new file and renamed, so a reader never sees a partial claim.
  const adopt = (kid) => { claim.children.push(child(kid)); writeFileSync(join(dir, `.${name}`), JSON.stringify(claim), { mode: 0o600 }); renameSync(join(dir, `.${name}`), join(dir, name)); };
  return { token, adopt, release: () => rmSync(join(dir, name), { force: true }) };
}

// The live claim on `cwd` that `token` does not match, or null.
export function lockHolder(cwd, token = process.env.PRLOOP_LOCK_TOKEN) {
  const dir = lockDir(cwd);
  return (dir && lockClaims(dir).find((c) => !token || c.token !== token)) ?? null;
}

export const lockMessage = (cwd, h) => `worktree ${cwd} is locked by prloop process ${h.pid} (${h.purpose ?? 'unknown purpose'}, since ${h.startedAt ?? 'unknown'}): wait until it finishes`;

// `n` distinct slots at once, or none: a gate that needs several backs off fully instead of holding some while it waits.
export function acquireSlots(dir, slots, n = 1) {
  const got = [];
  for (let r; got.length < Math.min(n, slots); got.push(r)) if (!(r = acquireSlot(dir, slots))) { got.forEach((f) => f()); return null; }
  return Object.assign(() => got.forEach((f) => f()), { adopt: (pid) => got.forEach((f) => f.adopt(pid)) });
}

// While a `prloop ready` started by a fix agent waits for its gate (key lock, resources, slot), the agent is queued, not
// working: `run` passes PRLOOP_QUEUE_FILE and stops that agent's --agent-timeout clock while the file names a live process.
export function markQueued(on, file = process.env.PRLOOP_QUEUE_FILE) {
  if (!file) return;
  if (on) writeFileSync(file, String(process.pid)); else rmSync(file, { force: true });
}
const queuedNow = (file) => { try { return alive(Number(readFileSync(file, 'utf8'))); } catch { return false; } };

export const slotsInUse = (dir) => {
  try { return new Set(readdirSync(dir).flatMap((f) => { const m = /^slot-(\d+)\.(\d+)\.\d+$/.exec(f); return m && slotClaimAlive(join(dir, f), Number(m[2])) ? [m[1]] : []; })).size; } catch { return 0; }
};

// Runs `gate` after admission, holding machine-wide slots (cfg.gateCost; a light gate, cost 0, takes none while load
// and memory allow, so a short gate never queues behind long ones), optionally with a private TMPDIR that is removed
// afterwards (a full test suite can fill a small tmpfs /tmp). Admission is rechecked on every slot poll, so a
// gate never starts on a machine that became busy while it waited. The slot claim adopts the gate shell, so the
// slot stays taken while a gate whose prloop was killed still runs. Returns { status, stdout, stderr }.
export async function runGate(gate, cwd, cfg, deps = {}) {
  const { dir = slotDir(), pause = sleep, log = logStderr } = deps;
  const w = {};
  let release, logged = false;
  const cost = cfg.gateCost ?? 1;
  for (;;) {
    const admitted = await admit(cfg, deps, w);
    // After an expired resource wait even a light gate takes the one slot, like any other gate.
    if (cost === 0 && admitted === 'ok') { release = Object.assign(() => {}, { adopt() {} }); break; }
    const slots = admitted === 'expired' ? 1 : cfg.gateSlots;
    if ((release = acquireSlots(dir, slots, Math.max(1, cost)))) break;
    if (!logged) { logged = true; log({ event: 'waiting_for_gate_slot', slots, inUse: slotsInUse(dir) }); }
    await pause(SLOT_POLL);
  }
  deps.admitted?.();
  let tmp;
  try {
    const env = { ...process.env };
    if (cfg.gateTmpdir) { mkdirSync(cfg.gateTmpdir, { recursive: true }); env.TMPDIR = tmp = mkdtempSync(join(cfg.gateTmpdir, 'prloop-gate-')); }
    const onSpawn = (pid) => { release.adopt(pid); deps.adopt?.(pid); };
    return await spawnAsync('sh', ['-c', `(${gate}) 2>&1`], cwd, { env, onSpawn });
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    release();
  }
}

export function machineLine(cfg, { metrics = machineMetrics, dir = slotDir() } = {}) {
  const m = metrics();
  const { maxLoad, minFreeMem } = limits(cfg, m);
  return `load ${m.load.toFixed(2)} (max ${maxLoad.toFixed(2)}, ${m.cores} cores), free memory ${gib(m.freeMem)} GiB (min ${gib(minFreeMem)} GiB), gate slots ${slotsInUse(dir)}/${cfg.gateSlots} in use`;
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
  editLines(f, (lines) => [...lines.slice(-50), full]);
  return full;
}

// Rewrites the lines of a shared state file under an exclusive lock, so concurrent `ready` processes cannot
// lose each other's updates (a failed gate's removal undone by another gate's stale rewrite). The lock is a
// one-slot claim directory <file>.lock.d (see acquireSlot): a dead owner's claim has a unique name, so removing
// it can never delete a live claim. The new content is written to a temporary file and renamed into place.
export function editLines(f, edit, { pid = process.pid } = {}) {
  const wait = new Int32Array(new SharedArrayBuffer(4));
  let release;
  while (!(release = acquireSlot(`${f}.lock.d`, 1, pid))) Atomics.wait(wait, 0, 0, 10 + Math.random() * 20);
  try {
    const lines = existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : [];
    writeFileSync(`${f}.tmp`, edit(lines).map((l) => `${l}\n`).join(''));
    renameSync(`${f}.tmp`, f);
  } finally { release(); }
}

// Passed gates, keyed by the clean checkout's exact HEAD, its repository and the gate command, since a gate may
// inspect commit metadata or history beyond the tree. Failures are not recorded.
const gateCacheFile = () => join(stateDir(), 'gate-cache');
export function gateKey(gate, cwd) {
  if (!gate || dirty(cwd)) return null; // HEAD names a checkout's content only when it is clean
  const repo = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  return `${git(['rev-parse', 'HEAD'], cwd)} ${createHash('sha256').update(`${repo}\0${gate}`).digest('hex')}`;
}
// The HEAD SHA when `gate` already passed on this clean checkout, else null.
export function gatePassed(gate, cwd) {
  const k = gateKey(gate, cwd);
  return k && existsSync(gateCacheFile()) && readFileSync(gateCacheFile(), 'utf8').split('\n').includes(k) ? k.split(' ')[0] : null;
}
export function recordGatePass(gate, cwd, key = gateKey(gate, cwd)) {
  if (!key) return null;
  mkdirSync(stateDir(), { recursive: true });
  editLines(gateCacheFile(), (lines) => [...lines.filter((l) => l !== key).slice(-199), key]);
  return key.split(' ')[0];
}
function forgetGatePass(key) {
  if (key && existsSync(gateCacheFile())) editLines(gateCacheFile(), (lines) => lines.filter((l) => l !== key));
}

// Runs the project gate for `ready` when one is configured and the clean, pushed PR head is not yet
// tested (or always with --force-gate); a pass marks the head tested and a failure unmarks it. Returns null
// when nothing ran. `deps` injects the machine metrics, slot directory, clock and logger (see runGate).
export async function readyGate(s, cfg, cwd, deps = {}) {
  if (!cfg.gate || localGate(s, cwd).some((r) => !r.includes('not marked tested'))) return null;
  // Pipelined review: a head that still needs a review request is requested first; the gate runs once the request
  // is posted (or the head is already reviewed), in parallel with the review.
  if (cfg.reviewBeforeGate && s.readyToRequest && !cfg.forceGate && gatePassed(cfg.gate, cwd) !== s.head) return { ok: true, deferred: true };
  // Only an exact cached pass of this command on this head skips the gate: a marker left by another gate never does.
  const key = gateKey(cfg.gate, cwd);
  markQueued(true);
  let release = () => {};
  try {
    if (key) release = await gateKeyLock(key, deps.pause ?? sleep);
    const cached = !cfg.forceGate && gatePassed(cfg.gate, cwd);
    if (cached) { markTested(s.head, cwd); return { ok: true, cached }; }
    const r = await runGate(cfg.gate, cwd, cfg, { ...deps, adopt: release.adopt, admitted: () => markQueued(false) }); // the gate shell keeps the key lock if ready dies
    if (r.status === 0) {
      if (key && gateKey(cfg.gate, cwd) === key) recordGatePass(cfg.gate, cwd, key); // the gate left the tree as it found it
      markTested(s.head, cwd);
      return { ok: true };
    }
    unmarkTested(s.head, cwd); // a forced rerun that fails withdraws the earlier validation, cached pass included
    forgetGatePass(key);
    return { ok: false, status: r.status, tail: String(r.stdout || r.stderr).trimEnd().split('\n').slice(-60).join('\n') };
  } finally { markQueued(false); release(); }
}

// Single-flight per gate-cache key: concurrent `ready` runs for the same head and command check, run and record
// one at a time, so the second finds the first's pass instead of running the gate again. The lock is a one-slot
// claim directory (see acquireSlot) removed when free; a claim attempt that loses that race to rmdir retries.
async function gateKeyLock(key, pause) {
  const dir = join(stateDir(), 'gate-locks', key.replace(' ', '-'));
  for (;;) {
    let release = null;
    try { release = acquireSlot(dir, 1); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (release) return Object.assign(() => { release(); try { rmdirSync(dir); } catch {} }, { adopt: release.adopt });
    await pause(SLOT_POLL);
  }
}

// Drops only `sha`, so syncing one PR keeps the markers of other PR heads in the same repository.
export function unmarkTested(sha, cwd) {
  const f = markerFile(cwd);
  if (f && existsSync(f)) editLines(f, (lines) => lines.filter((l) => l !== sha));
}

// With `gate`, the head counts as tested only by an exact cached pass of that command, never by another gate's marker.
export function localGate(s, cwd, gate) {
  const reasons = [];
  const branch = tryGit(['branch', '--show-current'], cwd);
  if (branch !== s.branch) reasons.push(`not in a checkout of ${s.branch} (current: ${branch || 'none'}): run this inside the PR checkout`);
  else {
    if (dirty(cwd)) reasons.push('working tree is not clean: commit or remove local changes');
    const local = git(['rev-parse', 'HEAD'], cwd);
    if (local !== s.head) reasons.push(`local HEAD ${short(local)} differs from remote PR head ${short(s.head)}: push or pull first`);
  }
  if (gate ? gatePassed(gate, cwd) !== s.head : !isTested(s.head, cwd)) reasons.push(`head ${short(s.head)} not marked tested: run \`prloop ready --gate "<cmd>"\` (or your gate, then \`prloop mark-tested${gate ? ' --gate "<cmd>"' : ''}\`)`);
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
    // A symlink side would make the write follow the link and stage the link instead of the union.
    const modes = git(['ls-files', '-u', '--', f], cwd).split('\n').map((l) => l.split(' ')[0]);
    if (modes.some((m) => m !== '100644' && m !== '100755') || lstatSync(join(cwd, f)).isSymbolicLink()) return [f];
    writeFileSync(join(cwd, f), unionLines(base, branch));
    git(['add', '--', f], cwd);
  }
  return [];
}

// Fetches the base and checks that origin/<base> contains the base commit GitHub reports for the PR,
// so a fork's stale same-named branch is never used. Returns an error string or null.
export function fetchBase(cwd, base, baseOid, remote = 'origin') {
  if (tryGit(['fetch', '--quiet', remote, base], cwd) === null) return `could not fetch ${remote}/${base}`;
  if (tryGit(['merge-base', `${remote}/${base}`, 'HEAD'], cwd) === null) return `${remote}/${base} shares no history with HEAD`;
  if (baseOid && tryGit(['merge-base', '--is-ancestor', baseOid, `${remote}/${base}`], cwd) === null) {
    return `${remote}/${base} does not contain the PR base commit ${short(baseOid)}; point ${remote} at the base repository`;
  }
  return null;
}

// `git patch-id --stable` of the PR's own change (`<base>...<head>`); null for an empty diff. Union-merged files are
// compared without context lines: the union moves the PR's lines below the base's, which changes only context.
export function patchId(cwd, base, head, unioned = []) {
  const diff = (extra, paths) => sh('git', ['diff', '--no-color', '--no-ext-diff', ...extra, `${base}...${head}`, '--', ...paths], { cwd });
  const lit = (f) => `:(literal)${f}`;
  const text = [diff([], ['.', ...unioned.map((f) => `:(exclude,literal)${f}`)]), unioned.length ? diff(['-U0'], unioned.map(lit)) : '']
    .filter(Boolean).join('\n');
  return text ? sh('git', ['patch-id', '--stable'], { cwd, input: `${text}\n`, stdio: ['pipe', 'pipe', 'pipe'] }).split(' ')[0] || null : null;
}

// Conflicted files the repository marks generated (`linguist-generated` in .gitattributes): regenerate, don't hand-merge.
const generatedFiles = (cwd, files) => (files.length ? tryGit(['check-attr', 'linguist-generated', '--', ...files], cwd) ?? '' : '')
  .split('\n').flatMap((l) => { const m = /^(.*): linguist-generated: (set|true)$/.exec(l); return m ? [m[1]] : []; });

// `rebase` forces a rebase (and linearizing), for `run --merge rebase`; otherwise the repository's merge settings decide.
export function syncBranch({ cwd, branch, base, baseOid, head, settings, union = [], remote = 'origin', rebase: forceRebase = false }) {
  // A fork PR's branch usually tracks its own remote; push there, not to the base repository.
  const headRemote = tryGit(['config', `branch.${branch}.remote`], cwd) || remote;
  if (tryGit(['branch', '--show-current'], cwd) !== branch) return { verdict: 'error', error: `run sync inside a checkout of ${branch}` };
  if (dirty(cwd)) return { verdict: 'error', error: 'working tree is not clean' };
  const baseError = fetchBase(cwd, base, baseOid, remote);
  if (baseError) return { verdict: 'error', error: baseError };
  tryGit(['fetch', '--quiet', headRemote, branch], cwd);
  if (git(['rev-parse', 'HEAD'], cwd) !== head) return { verdict: 'error', error: `local HEAD differs from remote PR head ${short(head)}: push or pull first` };
  // Sync to the fetched base branch: GitHub's baseRefOid can lag far behind it, and a branch that contains that
  // commit may still conflict with the real base. fetchBase checked that the fetched branch contains it.
  const target = `${remote}/${base}`;
  // ponytail: merge whenever merge or squash merges are allowed; rebase only for rebase-only repos.
  const rebase = forceRebase || (!settings.merge && !settings.squash);
  // A rebase-only repository refuses a branch with merge commits even when it contains the base: linearize it.
  const merges = rebase && !!git(['rev-list', '--merges', `${target}..HEAD`], cwd);
  const upToDate = tryGit(['merge-base', '--is-ancestor', target, 'HEAD'], cwd) !== null;
  if (!merges && upToDate) return { verdict: 'up_to_date', head };
  const env = { ...process.env, GIT_EDITOR: 'true' };
  const step = (args) => spawnSync('git', args, { cwd, env, encoding: 'utf8' }).status === 0;
  const unioned = new Set();
  let ok = step(rebase ? ['rebase', target] : ['merge', '--no-edit', target]);
  for (let i = 0; !ok && i < 200; i++) {
    const conflicted = git(['diff', '--name-only', '--diff-filter=U'], cwd).split('\n').filter(Boolean);
    // During a rebase stage 2 is the base side; during a merge stage 3 is.
    const manual = resolveUnion(cwd, union, rebase ? 2 : 3);
    if (!manual) break;
    if (!manual.length) conflicted.forEach((f) => unioned.add(f));
    if (manual.length) {
      step([rebase ? 'rebase' : 'merge', '--abort']);
      const generated = generatedFiles(cwd, manual);
      return { verdict: 'conflict', conflicts: manual, generated, method: rebase ? 'rebase' : 'merge',
        next: `resolve these conflicts by hand${generated.length ? ` (regenerate ${generated.join(', ')} from their sources instead of merging them)` : ''}, then run your gate and push` };
    }
    ok = step(rebase ? ['rebase', '--continue'] : ['commit', '--no-edit']);
  }
  if (!ok) {
    step([rebase ? 'rebase' : 'merge', '--abort']);
    return { verdict: 'error', error: `${rebase ? 'rebase' : 'merge'} failed` };
  }
  // A rebase drops merge commits, including edits made only in them: push only when the result equals merging the base.
  if (merges) {
    // merge-tree exits 1 on conflicts but still writes a tree; conflicts only in union-resolved files are excluded
    // from the tree comparison, since the rebase resolved them line by line. Instead every line the old head had in
    // such a file must survive, with the merged mode, so lines or modes changed only in a merge commit are not dropped.
    const mt = upToDate ? null : spawnSync('git', ['merge-tree', '--write-tree', '--name-only', target, head], { cwd, encoding: 'utf8' });
    const [tree, ...conflicts] = upToDate ? [git(['rev-parse', `${head}^{tree}`], cwd)] : mt.status <= 1 ? mt.stdout.split('\n\n')[0].split('\n').filter(Boolean) : [];
    const same = !!tree && conflicts.every((f) => unioned.has(f))
      && tryGit(['diff', '--quiet', tree, 'HEAD', '--', '.', ...conflicts.map((f) => `:(exclude,literal)${f}`)], cwd) !== null
      && conflicts.every((f) => {
        // Modes too: a merge-only chmod would otherwise be dropped silently.
        const mode = (rev) => (tryGit(['ls-tree', rev, '--', f], cwd) ?? '').split(' ')[0];
        if (mode(tree) !== mode('HEAD')) return false;
        const now = new Set((tryGit(['show', `HEAD:${f}`], cwd) ?? '').split('\n'));
        return (tryGit(['show', `${head}:${f}`], cwd) ?? '').split('\n').every((l) => now.has(l));
      });
    if (!same) {
      git(['reset', '--quiet', '--hard', head], cwd);
      return { verdict: 'error', error: 'linearizing would drop changes made in merge commits: linearize the branch by hand' };
    }
  }
  const push = rebase ? ['push', `--force-with-lease=${branch}:${head}`, headRemote, `HEAD:${branch}`] : ['push', headRemote, `HEAD:${branch}`];
  if (!step(push)) return { verdict: 'error', error: 'push failed; the branch is updated locally only' };
  unmarkTested(head, cwd);
  const newHead = git(['rev-parse', 'HEAD'], cwd);
  // No manual resolution happened here (that aborts above); any difference in the PR's own change needs a new review.
  const before = patchId(cwd, target, head, [...unioned]), after = patchId(cwd, target, newHead, [...unioned]);
  const unchanged = !!before && before === after;
  const treeUnchanged = git(['rev-parse', `${head}^{tree}`], cwd) === git(['rev-parse', 'HEAD^{tree}'], cwd);
  return { verdict: 'synced', method: rebase ? 'rebase' : 'merge', ...(merges ? { linearized: true } : {}), head: newHead, previousHead: head, patchId: after, unchanged, treeUnchanged, unioned: [...unioned],
    next: unchanged ? 'head changed but the PR\'s own change did not: run your gate; a previous clean review carries over'
      : 'head changed: run your gate, `prloop mark-tested`, then request a review' };
}

// ---------- wait ----------

// Polls until the snapshot is no longer pending. Terminates because a request goes stale after
// `cfg.timeout`; transient GitHub errors are retried until three fail in a row.
export async function waitFor(repo, prNum, cfg, { interval, fetch = fetchPr, now = Date.now, pause = sleep, cwd = process.cwd(), runLocal = localReview, metrics = machineMetrics, log = logStderr }) {
  const resources = {}; // one resource wait across polls, as in `run`
  let reviewed; // { head, agentLog } of a local review that posted; reported only while that head is current
  for (let failures = 0; ; await pause(interval)) {
    let s;
    try { s = classify(fetch(repo, prNum), cfg, now()); failures = 0; } catch (e) {
      if (++failures >= 3) return { verdict: 'error', pr: Number(prNum), error: String(e.stderr || e.message).slice(0, 500) };
      continue;
    }
    const plan = reviewPlan(s, cfg);
    if (plan.blocked) return { verdict: 'blocked', pr: s.pr, head: s.head, reason: plan.blocked };
    if (plan.local) {
      await admit(cfg, { metrics, now, pause, log }, resources);
      // The head may have moved while waiting for resources: review the current snapshot, or poll again.
      try { s = classify(fetch(repo, prNum), cfg, now()); } catch { continue; }
      if (!reviewPlan(s, cfg).local) continue;
      const head = s.head;
      const r = await runLocal(repo, s, cfg, cwd, (p) => { reviewed = { head, agentLog: p }; });
      // Gate missing, reviewer failed or posting failed; otherwise the posted result is classified next poll.
      if (r) return { ...r, ...(reviewed?.head === head ? { agentLog: reviewed.agentLog } : {}) };
      continue;
    }
    if (s.verdict !== 'pending') return { ...finish(s), ...(reviewed?.head === s.head ? { agentLog: reviewed.agentLog } : {}) };
  }
}

// Decides whether this snapshot needs a local review. Pure, so the fallback rules are testable.
export function reviewPlan(s, cfg) {
  const done = ['clean', 'findings', 'requested_while_unresolved'].includes(s.verdict);
  const wants = cfg.mode === 'local' ? !done : cfg.mode === 'auto' && s.verdict === 'unavailable';
  if (!wants) return {};
  if (s.local.truncated) return { blocked: 'too many comments or reviews to verify the local review limits; review manually' };
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
    next: `no "${s.triggerText}" comment after head ${short(s.head)}: run \`prloop ready\`, then request a review` };
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

async function runReviewer(cfg, prompt, cwd, keep) {
  const dir = scratch(cfg, 'prloop-review-');
  try {
    if (cfg.agent === 'codex') { // otherwise claude; localReview never gets here with --agent none
      writeFileSync(join(dir, 'schema.json'), JSON.stringify(REVIEW_SCHEMA));
      const r = await spawnAgent('codex', ['exec', '--sandbox', 'read-only', '--output-schema', join(dir, 'schema.json'), '-o', join(dir, 'out.json'),
        ...(cfg.model ? ['-m', cfg.model] : []), ...(cfg.effort ? ['-c', `model_reasoning_effort=${cfg.effort}`] : []), prompt], cwd, cfg);
      keep({ ...r, final: existsSync(join(dir, 'out.json')) ? readFileSync(join(dir, 'out.json'), 'utf8') : r.stdout });
      if (r.timedOut) throw new Error(timeoutReason(r, cfg));
      if (r.status !== 0) throw new Error(`codex reviewer exited with ${r.status}: ${(r.stderr ?? '').slice(-300)}`);
      return parseReview(readFileSync(join(dir, 'out.json'), 'utf8'));
    }
    const r = await spawnAgent('claude', ['-p', prompt, '--model', cfg.model ?? 'claude-opus-5-5', '--effort', cfg.effort ?? 'medium',
      '--permission-mode', 'dontAsk', '--allowedTools', 'Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git show:*)',
      '--output-format', 'json', '--json-schema', JSON.stringify(REVIEW_SCHEMA)], cwd, cfg);
    keep({ ...r, final: r.stdout });
    if (r.timedOut) throw new Error(timeoutReason(r, cfg));
    if (r.status !== 0) throw new Error(`claude reviewer exited with ${r.status}: ${(r.stderr ?? '').slice(-300)}`);
    const out = JSON.parse(r.stdout);
    return parseReview(out.structured_output ?? out.result);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export function localReviewPrompt(s) {
  // Diff from the reported base commit: the remote branch may carry commits that the PR still includes.
  return `Review pull request #${s.pr}: the changes in \`git diff ${s.baseOid ?? `origin/${s.base}`}...HEAD\` at head ${s.head}.
Do not modify any file. Report only real defects (bugs, security, data loss, broken contracts), not style.
Return JSON {"findings":[{"path","line","severity":"P0".."P3","body"}]} with "line" in the new file (0 if none) and an empty array when there are no issues.`;
}

// Runs one read-only review of the current head in `cwd` and posts it. Returns a verdict to stop on,
// or null when the result was posted and the next poll should classify it.
// `onLog` receives the path of the reviewer's saved raw output.
export async function localReview(repo, s, cfg, cwd, onLog = () => {}) {
  if (cfg.agent === 'none') return { verdict: 'blocked', pr: s.pr, head: s.head,
    reason: '--agent none runs no local reviewer: review the head yourself or rerun with --agent claude or codex' };
  const missing = s.unresolvedThreads.length ? [`${s.unresolvedThreads.length} unresolved threads`] : [];
  missing.push(...localGate(s, cwd, cfg.gate));
  if (missing.length) return { verdict: 'not_requested', pr: s.pr, head: s.head, missing, next: `a local review needs: ${missing.join('; ')}` };
  // Fail closed: a missing or stale base would make an empty diff look like a clean review.
  const baseError = fetchBase(cwd, s.base, s.baseOid);
  if (baseError) return { verdict: 'blocked', pr: s.pr, head: s.head, reason: `local review: ${baseError}` };
  const prompt = localReviewPrompt(s);
  let findings, agentLog;
  const keep = (r) => onLog(agentLog = saveAgentLog(repo, s.pr, r), r);
  try { findings = await runReviewer(cfg, prompt, cwd, keep); } catch (e) {
    return { verdict: 'blocked', pr: s.pr, head: s.head, reason: `local reviewer failed: ${String(e.message).slice(0, 400)}`, ...(agentLog ? { agentLog } : {}) };
  }
  if (dirty(cwd) || git(['rev-parse', 'HEAD'], cwd) !== s.head) {
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
// `prloop sync` may record a carry-over while a run holds this PR's state in memory: the newer carry wins.
const saveState = (st) => {
  const disk = loadState(st.repo, st.pr).carry;
  if (disk && !(st.carry?.at >= disk.at)) st.carry = disk;
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(statePath(st.repo, st.pr), JSON.stringify(st, null, 2));
};

// Appends one event to the PR's run log, or to a new log when no run has written this PR yet.
function logEvent(st, e) {
  mkdirSync(stateDir(), { recursive: true });
  st.log ??= join(stateDir(), `run-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  appendFileSync(st.log, `${JSON.stringify({ at: new Date().toISOString(), repo: st.repo, pr: st.pr, head: short(st.head), ...e })}\n`);
}

// Carries the clean verdict of `from` to the synced head; recorded in the state file and the event log.
export function recordCarry(repo, prNum, from, v) {
  const st = { rounds: 0, seen: {}, ...loadState(repo, prNum), repo, pr: Number(prNum), head: v.head };
  st.carry = { from, to: v.head, patchId: v.patchId, at: new Date().toISOString() };
  logEvent(st, { phase: 'carried', from: short(from), to: short(v.head), patchId: v.patchId });
  saveState(st); // after logging, so a new log path is kept
  return st.carry;
}

// The coordinator's one explicit reset of the round cap for a PR; a second one is refused.
export function resetRounds(repo, prNum) {
  const st = { rounds: 0, seen: {}, ...loadState(repo, prNum), repo, pr: Number(prNum) };
  if ((st.roundResets ?? 0) >= 1) throw new Error(`the rounds of ${repo}#${prNum} were already reset once: hand the PR over to a human`);
  const previous = st.rounds ?? 0;
  Object.assign(st, { rounds: 0, roundResets: 1 });
  logEvent(st, { phase: 'rounds_reset', reason: `rounds ${previous} -> 0` });
  saveState(st);
  return { verdict: 'ok', pr: st.pr, previousRounds: previous, rounds: 0, next: 'rerun prloop run for this PR' };
}

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

// Comment text without badges, HTML, markdown emphasis and the reviewer's boilerplate footer.
export const plain = (body) => String(body ?? '').replace(/\n+(AGENTS\.md reference|Useful\? React)[\s\S]*$/, '').replace(/<details>[\s\S]*?(<\/details>|$)/g, '')
  .replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/<[^>]+>/g, '').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();

// The fix agent sees only this trigger, never the round history.
export function buildPrompt(t) {
  const data = t.trigger === 'conflict' ? `Conflicted files: ${t.conflicts.join(', ')}${t.generated?.length ? `\nGenerated files among them (regenerate them from their sources after resolving the rest, never merge them by hand): ${t.generated.join(', ')}` : ''}`
    : t.findings?.length ? `Findings:\n${t.findings.map((f) => `- ${f.id} ${f.path ?? ''}:${f.line ?? ''} ${plain(f.body).slice(0, 600)}`).join('\n')}`
      : `Missing: ${(t.missing ?? []).join('; ') || 'a review request on the current head'}`;
  const failure = t.gateFailure ? `\nThe full gate failed on head ${t.gateFailure.head}; its last lines:\n${t.gateFailure.tail.slice(-3000)}` : '';
  const summary = t.summaries?.length ? `\nReviewer summary for this head (may hold findings that are not threads):\n${t.summaries.map(plain).join('\n').slice(0, 1500)}` : '';
  const request = t.localReview
    ? 'Do not post a review request: prloop reviews this PR locally once `prloop ready` passes.'
    : `Post the review request as a new PR comment, reusing exactly:\n${t.requestBody}`;
  // A local review needs the gate first, so its agent never defers it.
  const pipelined = t.reviewBeforeGate && !t.localReview;
  const ready = `prloop ready ${t.pr} --repo ${t.repo}${t.localReview ? ' --review-before-gate false' : ''}`;
  const gate = pipelined ? `\`${ready}\` checks that the head may be requested; this repository requests the review first and prloop runs the full gate (${t.gate}) in parallel, so \`ready\` does not run it while the head still needs a request`
    : t.gate ? `\`${ready}\` runs the gate (${t.gate}) and marks the head tested`
      : `\`${ready} --gate "<the full gate documented in AGENTS.md or README>"\` runs it and marks the head tested`;
  const minutes = Math.ceil((t.agentTimeout ?? 90 * 6e4) / 6e4);
  return `You are fixing PR #${t.pr} in ${t.repo}, branch ${t.branch}, head ${t.head}, worktree ${t.cwd}.
Trigger: ${t.trigger}. ${t.note ?? ''}
${data}${failure}${summary}

Do these steps in order, in this session:
1. Read only the referenced files plus every AGENTS.md that applies to them (root and nested).
2. Fix each valid finding with a regression test. Reply with evidence on invalid findings and leave them unresolved, except a finding proven to misread AGENTS.md, which you resolve after the evidence reply once every AGENTS.md that applies to its path confirms it is invalid. Resolve conflicts.
3. Run focused tests while fixing; never run the full project gate yourself: only \`prloop ready\` runs it, at most once per tree. If you already ran exactly that gate command and it passed on the current clean tree, \`prloop mark-tested --gate "<cmd>"\` records it instead of rerunning. Commit and push with normal commits (run \`prloop sync ${t.pr}\` first if the base moved).
4. Resolve the threads you fixed; reply on the disputed ones.
5. Gate: ${gate}. If it reports a gate failure, do not rerun \`prloop ready\` straight away: rerun the failing tests or step with their focused command, fix them (including failures you did not cause when they block the gate), commit and push, and call \`prloop ready\` again only when you are confident the full gate passes. At most 5 \`prloop ready\` calls; stop as blocked only if the same failure persists after 3 consecutive fix attempts, or the failure is environmental (missing tool, no network, permission denied), and report the exact failing step. If \`prloop ready\` fails for another reason, make one repair attempt, then stop as blocked.
6. ${request}
7. End your final message with this JSON on its own last line, always, also when you stop early or are blocked:
{"status":"requested|blocked|nothing_to_do","head":"<sha>","fixed":["<thread ids>"],"disputed":["<thread ids>"],"reason":"<short>"}
Use "blocked" with the reason when disputed findings remain unresolved.

Run \`prloop ready\` and any long test command in the foreground with a timeout of at least ${minutes} minutes. Never background a command; if one is backgrounded anyway, wait for it to finish before ending your turn. Your final message must end with the JSON status line.
Never wait for or poll reviews, merge, touch other PRs, rewrite history except through \`prloop sync\`, or retry in a loop. A denied action or a missing tool means stop immediately and report "blocked" with the denied command or missing tool named in "reason".`;
}

// Finds the agent's final JSON line, also inside a JSON wrapper such as `claude --output-format json`.
const cliWrapper = (text) => { try { const w = JSON.parse(String(text ?? '')); return w && typeof w === 'object' ? w : null; } catch { return null; } };

// Turns, cost and tokens from a claude `--output-format json` wrapper; null when the output carries no usage
// (codex exec prints none in the mode prloop uses). Input tokens include cache creation and cache reads.
export function agentUsage(text) {
  const w = cliWrapper(text), u = w?.usage;
  if (!u || typeof u !== 'object') return null;
  const n = (v) => (Number.isFinite(v) ? v : 0);
  return { turns: n(w.num_turns), costUsd: n(w.total_cost_usd), inputTokens: n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens),
    outputTokens: n(u.output_tokens) };
}

// Adds one finished agent or local reviewer to the PR's totals; values stay null until some run reports usage.
export function addUsage(st, stdout) {
  const t = (st.usage ??= { agentRuns: 0, turns: null, costUsd: null, inputTokens: null, outputTokens: null });
  t.agentRuns++;
  const u = agentUsage(stdout);
  if (u) for (const [k, v] of Object.entries(u)) t[k] = k === 'costUsd' ? Math.round(((t[k] ?? 0) + v) * 1e6) / 1e6 : (t[k] ?? 0) + v;
  return t;
}

// The last flat JSON object with a known status anywhere in the agent's final message: on its own line, inline,
// or pretty-printed inside a ```json fence. With `--output-format json` the CLI wrapper's `result` is searched.
export function parseAgentResult(text) {
  const w = cliWrapper(text);
  const body = typeof w?.result === 'string' ? w.result : String(text ?? '');
  for (const m of [...body.matchAll(/\{[^{}]*"status"[^{}]*\}/g)].reverse()) {
    try {
      const r = JSON.parse(m[0]);
      if (['requested', 'blocked', 'nothing_to_do'].includes(r?.status)) return { fixed: [], disputed: [], ...r };
    } catch { /* keep looking */ }
  }
  return null;
}

// Why a session ended without a result line: what the CLI JSON wrapper reports (error subtype, API error status,
// permission denials, terminal reason), else the tail of the final message.
const tail = (t) => String(t ?? '').trim().slice(-300);
export function agentFailure(text) {
  const w = cliWrapper(text);
  if (!w) return `the agent output had no parseable result line; it ended: ${tail(text) || '(empty)'}`;
  const why = [];
  if (w.subtype === 'error_max_turns') why.push('the agent session ended at its max-turns limit');
  else if (typeof w.subtype === 'string' && w.subtype.startsWith('error')) why.push(`the agent session ended with ${w.subtype}`);
  else if (w.is_error) why.push(`the agent session ended on an error: ${tail(w.result)}`);
  if (w.api_error_status) why.push(`API error status ${w.api_error_status}`);
  if (w.permission_denials?.length) {
    const input = (i) => String(i?.command ?? i?.file_path ?? i?.url ?? JSON.stringify(i ?? '')).slice(0, 80);
    why.push(`permission denied for ${w.permission_denials.map((d) => `${d.tool_name ?? 'a tool'} (${input(d.tool_input)})`).join(', ')}`);
  }
  if (w.terminal_reason && w.terminal_reason !== 'completed') why.push(`terminal reason ${w.terminal_reason}`);
  return why.length ? why.join('; ') : `the agent output had no parseable result line; it ended: ${tail(w.result) || '(empty)'}`;
}

// Keeps each spawned agent's raw output for diagnosis (owner-only); see pruneAgentLogs.
export function saveAgentLog(repo, pr, r, now = Date.now()) {
  const dir = join(stateDir(), 'agents');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${repo.replace('/', '__')}__${pr}__${new Date(now).toISOString().replace(/[:.]/g, '-')}.log`);
  const final = r.final !== r.stdout ? `\n## final message\n${r.final}` : '';
  writeFileSync(file, `# exit status ${r.status}\n## stdout\n${r.stdout}\n## stderr\n${r.stderr}${final}\n`, { mode: 0o600 });
  return file;
}

// Run on startup of `run` and `wait`: deletes agent logs older than 14 days.
export function pruneAgentLogs(now = Date.now()) {
  const dir = join(stateDir(), 'agents');
  for (const f of existsSync(dir) ? readdirSync(dir) : []) {
    try { if (now - statSync(join(dir, f)).mtimeMs > 14 * 864e5) rmSync(join(dir, f)); } catch { /* gone */ }
  }
}

// `lock` (a worktree lock) passes its token to the child and adopts it, so the lock outlives a killed prloop.
// Each stream keeps only its last OUTPUT_TAIL bytes (trimmed in amortized steps), so a verbose or looping
// child cannot exhaust the heap; callers use only the tail (failure reports, the agent's final JSON line).
export const OUTPUT_TAIL = 4 << 20;
const keepTail = (s) => (s.length > 2 * OUTPUT_TAIL ? s.slice(-OUTPUT_TAIL) : s);
// With `timeout` the child leads its own process group, and the whole group is killed once it has used up that
// budget. Time during which `paused()` is true (the agent's gate is queued) does not count.
const spawnAsync = (cmd, args, cwd, { env = process.env, lock, onSpawn = lock?.adopt, timeout, paused = () => false } = {}) => new Promise((done) => {
  const c = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: !!timeout, env: lock?.token ? { ...env, PRLOOP_LOCK_TOKEN: lock.token } : env });
  if (c.pid && onSpawn) onSpawn(c.pid);
  let timedOut = false, timer, left = timeout, last = Date.now();
  // ponytail: sampled at least every second, so a queue that starts or ends between samples is off by up to a second.
  const tick = () => {
    const t = Date.now();
    if (!paused()) left -= t - last;
    last = t;
    if (left > 0) { timer = setTimeout(tick, Math.min(left, 1000)); return; }
    timedOut = true;
    try { process.kill(-c.pid, 'SIGKILL'); } catch { c.kill('SIGKILL'); }
  };
  if (timeout && c.pid) timer = setTimeout(tick, Math.min(timeout, 1000));
  let stdout = '', stderr = '';
  c.stdout.on('data', (d) => { stdout = keepTail(stdout + d); });
  c.stderr.on('data', (d) => { stderr = keepTail(stderr + d); });
  const tail = (s) => s.slice(-OUTPUT_TAIL);
  c.on('error', (e) => { clearTimeout(timer); done({ status: 1, stdout: tail(stdout), stderr: `${tail(stderr)}${e.message}` }); });
  c.on('close', (code) => { clearTimeout(timer); done({ status: code ?? 1, stdout: tail(stdout), stderr: tail(stderr), ...(timedOut ? { timedOut } : {}) }); });
});

// The agent's own `prloop ready` gets this run's effective gate and limits, so it shares the same slot pool and weight.
// Claude Code moves a Bash command to the background after its default timeout, and a -p session then ends
// before the command (the gate) finishes: raise both limits to the agent's own budget.
export const agentEnv = (cfg, env = process.env) => {
  const limits = { PRLOOP_GATE: cfg.gate, PRLOOP_GATE_WEIGHT: cfg.gateWeight, PRLOOP_GATE_SLOTS: cfg.gateSlots, PRLOOP_MAX_LOAD: cfg.maxLoad,
    PRLOOP_MIN_FREE_MEM: cfg.minFreeMem, PRLOOP_RESOURCE_WAIT: cfg.resourceWait && `${Math.ceil(cfg.resourceWait / 1e3)}s`,
    PRLOOP_GATE_TMPDIR: cfg.gateTmpdir, PRLOOP_REVIEW_BEFORE_GATE: cfg.reviewBeforeGate };
  const out = { ...env, ...Object.fromEntries(Object.entries(limits).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])) };
  return cfg.agent === 'claude' ? { ...out, BASH_DEFAULT_TIMEOUT_MS: String(cfg.agentTimeout), BASH_MAX_TIMEOUT_MS: String(cfg.agentTimeout) } : out;
};
// Scratch for prloop and its agents: under --gate-tmpdir when set (a small /tmp fills up), else the system tmpdir.
const scratch = (cfg, prefix) => {
  if (cfg.gateTmpdir) mkdirSync(cfg.gateTmpdir, { recursive: true });
  return mkdtempSync(join(cfg.gateTmpdir ?? tmpdir(), prefix));
};
// With --gate-tmpdir, each agent run gets its own TMPDIR there too (agents may run tests), removed when it ends.
async function spawnAgent(cmd, args, cwd, cfg) {
  const env = { ...agentEnv(cfg) };
  const tmp = cfg.gateTmpdir && (env.TMPDIR = scratch(cfg, 'prloop-agent-'));
  mkdirSync(join(stateDir(), 'agents'), { recursive: true, mode: 0o700 });
  const queue = env.PRLOOP_QUEUE_FILE = join(stateDir(), 'agents', `queued-${randomUUID()}`);
  try { return await spawnAsync(cmd, args, cwd, { lock: cfg.lock, timeout: cfg.agentTimeout, env, paused: () => queuedNow(queue) }); }
  finally { if (tmp) rmSync(tmp, { recursive: true, force: true }); rmSync(queue, { force: true }); }
}

// A timed-out agent that printed nothing was most likely stuck on one command; say so instead of an empty log.
const minutes = (ms) => (ms >= 6e4 ? `${Math.round(ms / 6e4)}m` : `${Math.ceil(ms / 1e3)}s`);
const timeoutReason = (r, cfg) => `agent timed out after ${minutes(cfg.agentTimeout)} of work${String(r.stdout).trim() || String(r.stderr).trim() ? ''
  : ' with no output: it was killed before printing its result, so check its last command (time its gate spent queued is not counted)'}`;

async function runFixAgent(cfg, prompt, cwd) {
  if (cfg.agent === 'codex') {
    const dir = scratch(cfg, 'prloop-agent-out-');
    try {
      const r = await spawnAgent('codex', ['exec', '--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true', '-o', join(dir, 'last.txt'),
        ...(cfg.model ? ['-m', cfg.model] : []), ...(cfg.effort ? ['-c', `model_reasoning_effort=${cfg.effort}`] : []), prompt], cwd, cfg);
      return { ...r, final: existsSync(join(dir, 'last.txt')) ? readFileSync(join(dir, 'last.txt'), 'utf8') : r.stdout };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  const r = await spawnAgent('claude', ['-p', prompt, '--model', cfg.model ?? 'claude-opus-5-5', '--effort', cfg.effort ?? 'medium',
    '--permission-mode', 'auto', '--output-format', 'json'], cwd, cfg);
  return { ...r, final: r.stdout };
}

// A wrong --worktree would let a write-enabled agent commit to another branch or repository: require the
// PR branch checked out at exactly the PR head, so local commits ahead of or diverged from it cannot be pushed.
export function checkWorktree(cwd, s) {
  if (tryGit(['branch', '--show-current'], cwd) !== s.branch) return `worktree ${cwd} does not have ${s.branch} checked out`;
  if (tryGit(['rev-parse', 'HEAD'], cwd) !== s.head) return `worktree ${cwd} HEAD is not PR head ${short(s.head)}: push or pull first`;
  // Pre-existing changes would be committed and pushed by the fix agent along with its own.
  if (tryGit(['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'], cwd) !== '') return `worktree ${cwd} has uncommitted changes: commit, stash or clean them first`;
  return null;
}

export function findWorktree(branch, cwd) {
  const list = tryGit(['worktree', 'list', '--porcelain'], cwd) ?? '';
  for (const block of list.split('\n\n')) {
    const wt = /^worktree (.+)$/m.exec(block)?.[1];
    if (wt && block.split('\n').includes(`branch refs/heads/${branch}`)) return wt;
  }
  return null;
}

const TERMINAL = new Set(['merged', 'merge_pending', 'clean', 'blocked', 'needs_human', 'needs_agent', 'deadline']);

// Polls every PR round-robin in one process and spawns at most `--max-agents` agents or local reviews at a time.
// Exits only when every PR is terminal, printing one summary line per PR.
export async function runAll(opts, cfg, { metrics = machineMetrics, now = Date.now } = {}) {
  const repo = opts.repo;
  const prs = String(opts.pr).split(',').map(Number);
  const deadline = Date.now() + cfg.deadline;
  const { maxAgents, maxRounds } = cfg;
  mkdirSync(stateDir(), { recursive: true });
  pruneAgentLogs();
  const log = join(stateDir(), `run-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  // Rounds and seen findings persist across runs on purpose; `prloop reset-rounds` resets the rounds once.
  const states = prs.map((n) => ({ ...loadState(repo, n), repo, pr: n, log, phase: 'polling', reason: undefined, next: undefined, agentLog: undefined, mergeRetried: undefined }));
  const busy = new Map();
  const event = (st, phase, extra = {}) => {
    Object.assign(st, { phase, updatedAt: new Date().toISOString() }, extra);
    saveState(st);
    logEvent(st, { phase, ...pick(extra, ['verdict', 'reason', 'status', 'agentLog']) });
  };
  const block = (st, reason, next = 'a human decision is needed') => event(st, 'blocked', { reason, next });
  // One resource wait for the whole run: the machine is the same for every PR.
  const wait = {};
  // After an expired wait only one agent or local review runs at a time. Within step() the current PR is not
  // in `busy` yet, so busy.size counts only the others.
  const resourcesAllow = (st) => {
    const r = admitStep(wait, cfg, metrics(), now(), ({ event: phase, ...e }) => logEvent(st, { phase, ...e }));
    return r === 'ok' || (r === 'expired' && busy.size === 0);
  };

  // Another process works in this worktree: skip this poll and log the holder once.
  const lockedOut = (st, cwd, h) => {
    if (st.lockedBy !== h.pid) logEvent(st, { phase: 'worktree_locked', reason: lockMessage(cwd, h) });
    st.lockedBy = h.pid;
  };
  // Holds the worktree lock for the spawned agent; `--agent none` spawns nothing.
  async function fix(st, s, cwd, v) {
    const lock = cfg.agent === 'none' ? { release() {} } : takeLock(cwd, `fix agent for PR #${st.pr}`);
    if (lock.holder) return lockedOut(st, cwd, lock.holder);
    st.lockedBy = undefined;
    try { return await fixLocked(st, s, cwd, v, lock); } finally { lock.release(); }
  }

  async function fixLocked(st, s, cwd, v, lock) {
    if (++st.rounds > maxRounds) return block(st, `max rounds (${maxRounds}) reached`,
      'judge the remaining findings by real impact: merge low-risk ones as deferred, or `prloop reset-rounds` once for important defects');
    if (v.findings?.length) {
      const repeated = recordFindings(st.seen, v.findings);
      if (repeated.length) return block(st, 'the same finding came back after two fixes', 'decide whether the finding is valid');
    }
    const t = { ...v, repo, pr: st.pr, branch: s.branch, head: s.head, cwd, gate: cfg.gate, agentTimeout: cfg.agentTimeout, reviewBeforeGate: cfg.reviewBeforeGate, localReview: cfg.mode === 'local' || !!v.localReview, requestBody: s.rerequestBody };
    const prompt = buildPrompt(t);
    if (cfg.agent === 'none') return event(st, 'needs_agent', { verdict: v.verdict, prompt, next: 'spawn an agent with this prompt, then rerun prloop run' });
    event(st, 'agent', { verdict: v.verdict });
    // With a configured gate, progress is that gate's pass: a generic marker may come from another gate.
    const tested = (sha) => (cfg.gate ? gatePassed(cfg.gate, cwd) === sha : isTested(sha, cwd));
    const testedBefore = tested(s.head);
    const r = await runFixAgent({ ...cfg, lock }, prompt, cwd);
    lock.release(); // the spawn ended; the progress check below only reads
    addUsage(st, r.stdout);
    const agentLog = st.agentLog = saveAgentLog(repo, st.pr, r);
    const fail = (reason) => event(st, 'blocked', { reason, next: `a human decision is needed; the agent output is in ${agentLog}`, agentLog });
    if (r.timedOut) return fail(timeoutReason(r, cfg));
    const result = parseAgentResult(r.final);
    if (DENIED.test(`${r.final}\n${r.stderr}`)) return fail('the agent reported a permission denial');
    if (r.status !== 0) return fail(`the agent exited with status ${r.status}: ${cliWrapper(r.final) ? agentFailure(r.final) : tail(r.stderr)}`);
    const progressed = () => {
      const after = classify(fetchPr(repo, st.pr), cfg);
      return after.head !== s.head || after.unresolvedThreads.length < s.unresolvedThreads.length
        || after.trigger?.id !== s.trigger?.id || (!testedBefore && tested(after.head));
    };
    if (!result) {
      const reason = agentFailure(r.final);
      // A pushed head, resolved thread, request or gate is real progress: keep polling instead of blocking.
      if (!progressed()) return fail(reason);
      logEvent(st, { phase: 'agent_no_result', reason: `agent made progress without a result line (${reason})`, agentLog });
      return event(st, 'polling', { status: 'no_result' });
    }
    if (result.disputed?.length && result.status !== 'requested') {
      return event(st, 'needs_human', { status: result.status, reason: `disputed findings: ${result.disputed.join(', ')}`, next: 'decide the disputed threads' });
    }
    if (result.status === 'blocked') return fail(`agent: ${result.reason ?? 'blocked'}`);
    if (!progressed()) return fail(`agent made no progress (${result.status}): no commit, resolved thread, request or gate`);
    event(st, 'polling', { status: result.status });
  }

  // Locked like a standalone sync, so two supervisors never fetch, merge or push in one checkout at once.
  // Returns the sync result only when the branch was already up to date; otherwise it handled the outcome.
  function syncPr(st, s, raw, cwd, slot, rebase = opts.merge === 'rebase') {
    const lock = takeLock(cwd, `sync of PR #${st.pr}`);
    if (lock.holder) return lockedOut(st, cwd, lock.holder);
    let v;
    try { v = syncBranch({ cwd, branch: s.branch, base: s.base, baseOid: raw.baseRefOid, head: s.head, settings: raw.repoSettings, union: opts.union, rebase }); } finally { lock.release(); }
    if (v.verdict === 'error') return block(st, `sync failed: ${v.error}`);
    if (v.verdict === 'synced' && v.unchanged && s.verdict === 'clean') {
      st.carry = recordCarry(repo, st.pr, s.head, v);
      return event(st, 'polling', { verdict: 'carried', head: v.head });
    }
    if (v.verdict === 'synced') return event(st, 'polling', { verdict: 'synced', head: v.head });
    if (v.verdict === 'conflict') return slot() && fix(st, s, cwd, { verdict: 'conflict', trigger: 'conflict', conflicts: v.conflicts, generated: v.generated });
    return v;
  }

  async function step(st) {
    let raw, s;
    try { raw = fetchPr(repo, st.pr); s = classify(raw, cfg); st.failures = 0; } catch (e) {
      if ((st.failures = (st.failures ?? 0) + 1) >= 3) block(st, `GitHub read failed: ${String(e.stderr || e.message).slice(0, 300)}`);
      return;
    }
    st.head = s.head;
    if (s.state === 'MERGED') return event(st, 'merged', { mergeCommit: s.mergeCommit });
    if (s.state === 'CLOSED') return block(st, 'the PR is closed');
    const cwd = opts.worktree ? resolve(opts.worktree) : findWorktree(s.branch, process.cwd());
    // The holder check comes first: a locked fix agent's uncommitted edit or local commit is not a bad checkout.
    const holder = cwd && lockHolder(cwd, null);
    if (holder) return lockedOut(st, cwd, holder);
    const wrong = cwd && checkWorktree(cwd, s);
    if (wrong) return block(st, wrong);
    const slot = () => busy.size < maxAgents && resourcesAllow(st);
    // A behind head is always synced, even when mergeable, so the gate runs on the combined base-plus-branch
    // state before a merge; an unchanged patch carries the clean review, so this costs no new review.
    if (s.mergeState === 'BEHIND' || s.mergeState === 'DIRTY' || s.mergeable === 'CONFLICTING') {
      if (!cwd) return block(st, `PR is ${s.mergeState} and no worktree has ${s.branch}; pass --worktree`);
      const v = syncPr(st, s, raw, cwd, slot);
      if (v?.verdict !== 'up_to_date') return v;
    }
    // Pipelined review: once the head is requested (or already reviewed clean), prloop runs the gate itself, in parallel
    // with the review. A failure goes to a fix agent with the gate's tail; a merge needs both on the same head.
    const gated = (sha) => gatePassed(cfg.gate, cwd) === sha;
    if (cfg.reviewBeforeGate && cfg.gate && cwd && ['pending', 'clean'].includes(s.verdict) && !gated(s.head) && st.gateFailure?.head !== s.head) {
      const lock = takeLock(cwd, `gate of PR #${st.pr}`);
      if (lock.holder) return lockedOut(st, cwd, lock.holder);
      st.lockedBy = undefined;
      event(st, 'gate');
      let g;
      try { g = await readyGate(s, cfg, cwd, { metrics, now, log: ({ event: phase, ...e }) => logEvent(st, { phase, ...e }) }); } finally { lock.release(); }
      if (g?.ok) return event(st, 'polling', { verdict: 'gate_passed' });
      st.gateFailure = { head: s.head, tail: g?.tail ?? 'the worktree no longer matches the PR head' };
      return event(st, 'polling', { verdict: 'gate_failed', reason: `gate exited with ${g?.status}` });
    }
    const gateFailure = cfg.reviewBeforeGate && st.gateFailure?.head === s.head ? st.gateFailure : undefined;
    if (gateFailure && s.verdict !== 'findings') {
      if (!cwd) return block(st, `no worktree has ${s.branch} checked out; pass --worktree`);
      return slot() && fix(st, s, cwd, { verdict: 'gate_failed', trigger: 'gate_failed', gateFailure, missing: [`the full gate passing on head ${short(s.head)}`] });
    }
    const plan = reviewPlan(s, cfg);
    if (plan.blocked) return block(st, plan.blocked);
    if (plan.local) {
      if (!cwd) return block(st, `no worktree has ${s.branch} for a local review; pass --worktree`);
      if (!slot()) return;
      const lock = takeLock(cwd, `local review of PR #${st.pr}`);
      if (lock.holder) return lockedOut(st, cwd, lock.holder);
      st.lockedBy = undefined;
      event(st, 'local_review');
      let r;
      try { r = await localReview(repo, s, { ...cfg, lock }, cwd, (p, out) => { st.agentLog = p; addUsage(st, out.stdout); }); } finally { lock.release(); }
      if (!r) return event(st, 'polling', { verdict: 'local_review_posted', agentLog: st.agentLog });
      if (r.verdict === 'blocked') return r.agentLog ? event(st, 'blocked', { reason: r.reason, next: `a human decision is needed; the reviewer output is in ${r.agentLog}`, agentLog: r.agentLog }) : block(st, r.reason);
      return fix(st, s, cwd, { verdict: 'not_requested', trigger: 'local_review', missing: r.missing, localReview: true });
    }
    if (s.verdict === 'pending') return st.phase === 'waiting' ? undefined : event(st, 'waiting', { verdict: 'pending' });
    if (s.verdict === 'unavailable') return block(st, `cloud reviewer unavailable: ${s.unavailableReason}`, 'retry later or use --reviewer auto or local');
    if (s.verdict === 'clean' && !opts.merge) return event(st, 'clean', { next: 'the current head is reviewed clean; merge when authorized' });
    if (s.verdict === 'clean') {
      if (s.unresolvedThreads.length) return; // classify reports findings in that case; defensive
      const missing = cwd ? localGate(s, cwd, cfg.gate) : [`no worktree for ${s.branch} to confirm the head was tested; pass --worktree`];
      if (!cwd) return block(st, missing[0]);
      if (missing.length) return slot() && fix(st, s, cwd, { verdict: 'not_tested', trigger: 'not_requested', missing,
        note: 'The head is already reviewed clean and only needs the gate: run `prloop ready`, which runs the gate and marks the head tested, then reports that the head is already reviewed clean. That report is expected: skip the review request and report status nothing_to_do.' });
      if (s.mergeable !== 'MERGEABLE') return s.mergeable === 'UNKNOWN' ? undefined : block(st, `GitHub reports mergeable=${s.mergeable}`);
      const merge = () => sh('gh', ['pr', 'merge', String(st.pr), '--repo', repo, `--${opts.merge}`, '--match-head-commit', s.head]);
      try { merge(); } catch (e) {
        // GitHub refuses a rebase merge of a branch with merge commits even when it reports the PR clean:
        // linearize it once (the new head then needs the gate again) or, when there is nothing to linearize, retry once.
        const why = String(e.stderr || e.message).trim().slice(0, 300);
        if (opts.merge !== 'rebase' || st.mergeRetried) return block(st, `GitHub refused the merge: ${why}`);
        st.mergeRetried = true;
        logEvent(st, { phase: 'merge_refused', reason: `${why}; syncing (linearize) and retrying once` });
        const v = syncPr(st, s, raw, cwd, slot, true);
        if (v?.verdict !== 'up_to_date') return v;
        try { merge(); } catch (e2) { return block(st, `GitHub refused the merge again: ${String(e2.stderr || e2.message).trim().slice(0, 300)}`); }
      }
      const after = classify(fetchPr(repo, st.pr), cfg);
      // A merge queue or auto-merge accepts the command without merging yet: report the real state.
      return after.state === 'MERGED' ? event(st, 'merged', { mergeCommit: after.mergeCommit })
        : event(st, 'merge_pending', { reason: `state ${after.state} after merge`, next: 'a merge queue or auto-merge holds the PR; verify later' });
    }
    if (!cwd) return block(st, `no worktree has ${s.branch} checked out; pass --worktree`);
    if (!slot()) return;
    const trigger = s.verdict === 'timeout' ? 'timeout' : s.verdict === 'not_requested' ? 'not_requested'
      : s.unresolvedThreads.some((x) => isLocal(x.body)) ? 'local_review' : 'findings';
    return fix(st, s, cwd, { verdict: s.verdict, trigger, findings: s.unresolvedThreads, summaries: s.verdict === 'findings' ? s.summaries : [], missing: [...s.reasons, ...localGate(s, cwd)], gateFailure });
  }

  for (;;) {
    for (const st of states) {
      if (TERMINAL.has(st.phase) || busy.has(st.pr)) continue;
      if (Date.now() > deadline) { event(st, 'deadline', { reason: 'overall deadline reached', next: 'rerun prloop run or hand over' }); continue; }
      const p = step(st).catch((e) => block(st, `prloop error: ${String(e.stderr || e.message).slice(0, 300)}`))
        .finally(() => busy.delete(st.pr));
      busy.set(st.pr, p);
      if (!['agent', 'local_review', 'gate'].includes(st.phase)) await p; // only agents, local reviews and gates run in parallel
    }
    if (states.every((st) => TERMINAL.has(st.phase))) break;
    await Promise.race([sleep(cfg.interval), ...busy.values()]);
  }
  return states.map((st) => ({ pr: st.pr, verdict: st.phase === 'needs_agent' ? st.verdict : st.phase, reason: st.reason, head: st.head,
    rounds: st.rounds, next: st.next, ...(st.usage ? { usage: st.usage } : {}), ...(st.agentLog ? { agentLog: st.agentLog } : {}), ...(st.prompt && st.phase === 'needs_agent' ? { prompt: st.prompt } : {}) }));
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

// Cheap check-in for a coordinator: state files plus each PR's last few events, no GitHub calls.
export function runStatus(repoFilter, last = 5) {
  const dir = stateDir();
  const files = existsSync(dir) ? readdirSync(dir) : [];
  const logs = files.filter((x) => x.startsWith('run-')).sort().reverse().map((f) => join(dir, f));
  const read = (f) => { try { return readFileSync(f, 'utf8').split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }); } catch { return []; } };
  const prs = files.filter((f) => /__\d+\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
    .filter((st) => !repoFilter || st.repo === repoFilter)
    .map((st) => {
      // The state names its run log; older log lines carry no repo, so trust them only within that log.
      const mine = (f) => (e) => e.pr === st.pr && (f === st.log ? (e.repo ?? st.repo) : e.repo) === st.repo;
      let events = [];
      for (const f of [st.log, ...logs].filter(Boolean)) if ((events = read(f).filter(mine(f))).length) break;
      return { repo: st.repo, pr: st.pr, phase: st.phase, head: short(st.head), rounds: st.rounds, roundResets: st.roundResets, reason: st.reason, next: st.next,
        updatedAt: st.updatedAt, carry: st.carry, agentLog: st.agentLog, usage: st.usage, events: events.slice(-last) };
    });
  return { prs };
}

// blocked (also a merge still pending) wins; otherwise the first verdict that still needs action; 0 when all are done.
export function runExitCode(results) {
  const codes = results.map((r) => (['needs_human', 'deadline', 'merge_pending'].includes(r.verdict) ? EXIT.blocked : EXIT[r.verdict] ?? 0));
  return codes.includes(EXIT.blocked) ? EXIT.blocked : codes.find(Boolean) ?? 0;
}

// ---------- self-check ----------

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));

// The installed prloop should be a checkout of the published default branch; changes go through PRs.
// Returns null when there is nothing to report (also outside a Git repository), otherwise { warning?, note? }.
export function selfCheck(dir) {
  if (tryGit(['rev-parse', '--is-inside-work-tree'], dir) !== 'true') return null;
  const branch = (tryGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], dir) ?? 'origin/main').replace(/^origin\//, '');
  const problems = [];
  if (dirty(dir)) problems.push('has uncommitted changes');
  const current = tryGit(['branch', '--show-current'], dir);
  if (current !== branch) problems.push(`is on ${current || 'a detached HEAD'}, not ${branch}`);
  let note;
  // ls-remote only reads: no fetched objects, refs or FETCH_HEAD are written.
  try {
    const remote = sh('git', ['ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`], { cwd: dir, timeout: 10e3, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).split(/\s/)[0];
    // Behind unless the remote tip is HEAD or already contained in it; an unknown commit is newer work.
    if (tryGit(['merge-base', '--is-ancestor', remote, 'HEAD'], dir) === null) problems.push(`is behind origin/${branch}`);
  } catch { note = `could not read origin ${branch} within 10s; skipped the behind check`; }
  if (!problems.length) return note ? { note } : null;
  return { note, warning: `prloop checkout ${dir} ${problems.join(', ')}: update it with \`git -C ${dir} pull --ff-only\` on ${branch}, and move local changes to a PR` };
}

// ---------- CLI ----------

export async function main(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { console.log(JSON.stringify({ verdict: 'error', error: e.message })); return EXIT.error; }
  const [cmd, prArg] = opts._;
  if (!cmd || opts.help || cmd === 'help') { console.log(HELP); return 0; }
  const out = (obj, code) => { console.log(JSON.stringify(obj)); return code; };
  try {
    if (['ready', 'sync', 'mark-tested'].includes(cmd)) {
      const h = lockHolder(process.cwd());
      if (h) return out({ verdict: 'error', error: lockMessage(process.cwd(), h) }, EXIT.error);
    }
    if (cmd === 'lock-status') {
      const dir = resolve(prArg ?? '.');
      const holder = lockHolder(dir, null);
      return out({ dir, locked: !!holder, holder: holder ? pick(holder, ['pid', 'purpose', 'startedAt']) : null }, holder ? EXIT.blocked : 0);
    }
    if (cmd === 'mark-tested') {
      const cwd = process.cwd(), tested = markTested(opts.sha, cwd), gate = opts.gate ?? process.env.PRLOOP_GATE;
      // The caller ran this gate itself on the current clean tree: record it so `ready` does not rerun it.
      const gatePassedHead = gate && tested === git(['rev-parse', 'HEAD'], cwd) ? recordGatePass(gate, cwd) : null;
      return out({ verdict: 'ok', tested, ...(gatePassedHead ? { gatePassedHead } : {}) }, 0);
    }
    const repoFile = repoConfig(opts.worktree ? resolve(opts.worktree) : process.cwd());
    const cfg = config(opts, process.env, { machine: machineConfig(), repo: repoFile });
    if (!opts.union.length && repoFile.union) opts.union = repoFile.union;
    // The repository file names the method; merging itself still needs an explicit --merge.
    if (opts.merge === 'repo') opts.merge = repoFile.merge ?? (() => { throw new Error('--merge repo needs "merge" in .prloop.json'); })();
    if (cmd === 'run' && opts.status) return out({ machine: machineLine(cfg), ...runStatus(opts.repo) }, 0);
    if (cmd === 'run' || cmd === 'ready') {
      const c = selfCheck(SCRIPT_DIR);
      if (c?.warning && (opts.requireCurrent || process.env.PRLOOP_REQUIRE_CURRENT === '1')) return out({ verdict: 'error', error: c.warning }, EXIT.error);
      if (c) logStderr({ event: 'self_check', ...c });
    }
    if (cmd === 'run') {
      if (!opts.repo || !opts.pr) throw new Error('run needs --repo owner/name and --pr N[,N...]');
      if (opts.merge && !['rebase', 'squash', 'merge'].includes(opts.merge)) throw new Error('--merge must be rebase, squash, merge or repo');
      const results = await runAll(opts, cfg);
      for (const r of results) console.log(JSON.stringify(r));
      return runExitCode(results);
    }
    if (!prArg) throw new Error(`${cmd} needs a PR number`);
    const repo = resolveRepo(opts);
    if (cmd === 'status') {
      const s = classify(fetchPr(repo, prArg), cfg);
      const checkout = !!tryGit(['rev-parse', '--git-dir']);
      const local = checkout ? localGate(s, process.cwd(), cfg.gate) : [];
      const unresolvedThreads = s.unresolvedThreads.map((t) => ({ ...t, body: t.body.slice(0, 300) }));
      return out({ ...s, unresolvedThreads, reasons: [...s.reasons, ...local], readyToRequest: s.readyToRequest && !local.length,
        tested: !checkout ? false : cfg.gate ? gatePassed(cfg.gate, process.cwd()) === s.head : isTested(s.head, process.cwd()) }, 0);
    }
    if (cmd === 'ready') {
      let s = classify(fetchPr(repo, prArg), cfg);
      const gate = await readyGate(s, cfg, process.cwd());
      if (gate?.cached) console.error(`gate already passed for head ${gate.cached}`);
      if (gate && !gate.ok) return out({ ready: false, pr: s.pr, head: s.head, gate: 'failed', exitCode: gate.status, tail: gate.tail,
        next: 'rerun the failing tests or step with its focused command, fix until it passes, then run `prloop ready` again' }, EXIT.blocked);
      // Waiting for admission or a slot can outlast a push from elsewhere: judge the PR as it is now, not the gated snapshot.
      if (gate && !gate.deferred) s = classify(fetchPr(repo, prArg), cfg);
      // A deferred gate (pipelined review) runs after the request: an untested head does not block the request.
      const missing = [...s.reasons, ...localGate(s, process.cwd(), cfg.gate)].filter((r) => !(gate?.deferred && r.includes('not marked tested')));
      const pipelined = gate?.deferred ? { gate: 'deferred', next: 'post the review request; the full gate runs next, in parallel (`prloop run` runs it, or call `prloop ready` again after the request)' }
        : gate && cfg.reviewBeforeGate ? { gate: 'passed' } : {};
      return out({ ready: !missing.length, pr: s.pr, head: s.head, missing, trigger: cfg.trigger, ...pipelined }, missing.length ? EXIT.blocked : 0);
    }
    if (cmd === 'wait') {
      pruneAgentLogs();
      const v = await waitFor(repo, prArg, cfg, { interval: cfg.interval });
      return out(v, EXIT[v.verdict]);
    }
    if (cmd === 'reset-rounds') return out(resetRounds(repo, prArg), 0);
    if (cmd === 'sync') {
      // Hold the lock for the whole sync unless the caller's inherited token owns it, so two syncs never share the checkout.
      const cwd = process.cwd(), token = process.env.PRLOOP_LOCK_TOKEN, dir = lockDir(cwd);
      const lock = token && dir && lockClaims(dir).some((c) => c.token === token) ? { release() {} } : takeLock(cwd, `sync of PR #${prArg}`);
      if (lock.holder) return out({ verdict: 'error', error: lockMessage(cwd, lock.holder) }, EXIT.error);
      try {
        const pr = fetchPr(repo, prArg);
        const clean = classify(pr, cfg).verdict === 'clean';
        const v = syncBranch({ cwd, branch: pr.headRefName, base: pr.baseRefName, baseOid: pr.baseRefOid, head: pr.headRefOid, settings: pr.repoSettings, union: opts.union });
        const carry = v.verdict === 'synced' && v.unchanged && clean ? recordCarry(repo, prArg, pr.headRefOid, v) : undefined;
        return out({ pr: Number(prArg), ...v, carry }, v.verdict === 'conflict' ? EXIT.conflict : v.verdict === 'error' ? EXIT.error : 0);
      } finally { lock.release(); }
    }
    throw new Error(`unknown command: ${cmd}`);
  } catch (e) {
    return out({ verdict: 'error', error: String(e.stderr || e.message).trim().slice(0, 500) }, EXIT.error);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
