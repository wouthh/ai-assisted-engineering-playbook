import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  classify, config, globToRegex, localCleanBody, localGate, localReview, markTested, localReviewPayload, parseReview, reviewPlan, runExitCode, parseDuration, recordFindings, syncBranch, unionLines, waitFor,
} from '../prloop.mjs';

const fixture = () => JSON.parse(readFileSync(new URL('./pr-fixture.json', import.meta.url), 'utf8'));
const cfg = config({}, {});
const NOW = Date.parse('2026-01-01T10:06:00Z'); // one minute after the current request
const at = (hhmm) => `2026-01-01T${hhmm}:00Z`;
const BOT = { login: 'chatgpt-codex-connector' };
const request = (pr) => pr.comments.nodes.find((c) => c.id === 'IC_req');
const thread = (id, createdAt, body = 'P1: Handle the empty retry list', author = BOT) => ({
  id, isResolved: false, path: 'src/retry.js', line: 12,
  comments: { nodes: [{ body, createdAt, author }] },
});

test('pending request without bot signals keeps waiting', () => {
  const s = classify(fixture(), cfg, NOW);
  assert.equal(s.verdict, 'pending');
  assert.equal(s.trigger.databaseId, 101);
  assert.equal(s.trigger.afterHead, true);
  assert.equal(s.readyToRequest, false);
});

test('clean via thumbs-up on the current request', () => {
  const pr = fixture();
  request(pr).reactions.nodes.push({ content: 'THUMBS_UP', createdAt: at('10:20'), user: BOT });
  const s = classify(pr, cfg, NOW);
  assert.equal(s.reviewerState.state, 'clean');
  assert.equal(s.verdict, 'clean');
});

test('a thumbs-up on an older request does not count', () => {
  const pr = fixture();
  pr.comments.nodes.pop(); // only IC_old remains, posted before the head commit
  const s = classify(pr, cfg, NOW);
  assert.equal(s.verdict, 'not_requested');
  assert.equal(s.trigger.afterHead, false);
  assert.equal(s.readyToRequest, true);
});

test('not_requested names the configured trigger text', async () => {
  const pr = fixture();
  pr.comments.nodes = [];
  const v = await waitFor('example-org/example-repo', 7, config({ trigger: '/review' }, {}), { interval: 1, fetch: () => pr, now: () => NOW });
  assert.equal(v.verdict, 'not_requested');
  assert.match(v.next, /no "\/review" comment after head 1111111/);
});

test('clean via a reviewer comment matching the clean regex', () => {
  const pr = fixture();
  pr.comments.nodes.push({ id: 'IC_bot', databaseId: 102, body: "Codex Review: Didn't find any major issues. Nice work.",
    createdAt: '2026-01-01T10:20:00Z', author: BOT, reactions: { nodes: [] } });
  assert.equal(classify(pr, cfg, NOW).verdict, 'clean');
});

test('clean via a review on the current head', () => {
  const pr = fixture();
  pr.reviews.nodes.push({ id: 'R1', body: "Didn't find any major issues.", state: 'COMMENTED',
    submittedAt: '2026-01-01T10:20:00Z', author: BOT, commit: { oid: pr.headRefOid } });
  assert.equal(classify(pr, cfg, NOW).verdict, 'clean');
});

test('eyes means still reviewing', () => {
  const pr = fixture();
  request(pr).reactions.nodes.push({ content: 'EYES', createdAt: at('10:05'), user: BOT });
  const s = classify(pr, cfg, NOW);
  assert.equal(s.reviewerState.state, 'reviewing');
  assert.equal(s.verdict, 'pending');
});

test('new reviewer threads are findings with a summary', () => {
  const pr = fixture();
  pr.reviewThreads.nodes.push(thread('T1', '2026-01-01T10:20:00Z'));
  pr.reviews.nodes.push({ id: 'R1', body: 'Codex Review: here are some suggestions.', state: 'COMMENTED',
    submittedAt: '2026-01-01T10:20:00Z', author: BOT, commit: { oid: pr.headRefOid } });
  const s = classify(pr, cfg, NOW);
  assert.equal(s.verdict, 'findings');
  assert.deepEqual(s.reviewerState, { state: 'findings', count: 1 });
  assert.match(s.summaries[0], /suggestions/);
  assert.match(s.reasons[0], /1 unresolved threads: T1/);
});

test('request posted while older threads were unresolved', () => {
  const pr = fixture();
  pr.reviewThreads.nodes.push(thread('T0', '2026-01-01T08:00:00Z'));
  assert.equal(classify(pr, cfg, NOW).verdict, 'requested_while_unresolved');
});

test('the gate refuses while threads are unresolved', () => {
  const pr = fixture();
  pr.comments.nodes.pop();
  pr.reviewThreads.nodes.push(thread('T0', '2026-01-01T08:00:00Z', 'nit', { login: 'example-dev' }));
  const s = classify(pr, cfg, NOW);
  assert.equal(s.readyToRequest, false);
  assert.deepEqual(s.unresolvedThreads.map((t) => t.id), ['T0']);
});

test('a force-push to an older commit invalidates an earlier clean signal', () => {
  const pr = fixture();
  request(pr).reactions.nodes.push({ content: 'THUMBS_UP', createdAt: at('10:20'), user: BOT });
  pr.commits.nodes[0].commit.committedDate = at('08:00'); // older commit becomes the head
  pr.timelineItems = { nodes: [{ createdAt: at('10:30') }] };
  const s = classify(pr, cfg, Date.parse(at('10:31')));
  assert.equal(s.trigger.afterHead, false);
  assert.equal(s.verdict, 'not_requested');
});

test('more than one page of review threads fails closed', () => {
  const pr = fixture();
  pr.reviewThreads.pageInfo = { hasNextPage: true };
  assert.throws(() => classify(pr, cfg, NOW), /more than 100 review threads/);
});

test('run exit code: blocked wins, then the first verdict needing action', () => {
  assert.equal(runExitCode([{ verdict: 'clean' }, { verdict: 'merged' }]), 0);
  assert.equal(runExitCode([{ verdict: 'clean' }, { verdict: 'findings' }, { verdict: 'timeout' }]), 10);
  assert.equal(runExitCode([{ verdict: 'not_requested' }, { verdict: 'blocked' }]), 50);
});

test('the default reviewer login is anchored', () => {
  const pr = fixture();
  request(pr).reactions.nodes.push({ content: 'THUMBS_UP', createdAt: at('10:20'), user: { login: 'not-chatgpt-codex-connector-fan' } });
  assert.equal(classify(pr, cfg, NOW).verdict, 'pending');
});

test('custom reviewer and trigger', () => {
  const pr = fixture();
  pr.comments.nodes.push({ id: 'IC_x', databaseId: 103, body: '/review please', createdAt: '2026-01-01T11:00:00Z',
    author: { login: 'example-dev' }, reactions: { nodes: [{ content: 'THUMBS_UP', createdAt: at('11:01'), user: { login: 'other-review-bot' } }] } });
  const custom = config({ reviewerLogin: '^other-review-bot$', trigger: '/review' }, {});
  assert.equal(classify(pr, custom, NOW).verdict, 'clean');
});

test('wait times out after an acknowledged review stalls, with the request body to repost', async () => {
  const pr = fixture();
  request(pr).reactions.nodes.push({ content: 'EYES', createdAt: at('10:05'), user: BOT });
  let t = NOW, polls = 0;
  const v = await waitFor('example-org/example-repo', 7, cfg, {
    interval: cfg.interval, fetch: () => { polls++; return pr; }, now: () => t, pause: async (ms) => { t += ms; },
  });
  assert.equal(v.verdict, 'timeout');
  assert.equal(v.rerequestBody, '@codex review\n\nFocus on the retry path.');
  assert.ok(t - Date.parse(at('10:05')) >= cfg.timeout);
  assert.ok(polls > 10);
});

test('an unacknowledged request goes stale after the ack timeout and may be re-requested', () => {
  const s = classify(fixture(), cfg, Date.parse(at('10:09')));
  assert.equal(s.verdict, 'timeout');
  assert.equal(s.readyToRequest, true);
});

test('wait retries transient errors and gives up after three in a row', async () => {
  let calls = 0;
  const v = await waitFor('example-org/example-repo', 7, cfg, {
    interval: 1, fetch: () => { calls++; throw new Error('HTTP 502'); }, now: () => NOW, pause: async () => {},
  });
  assert.equal(v.verdict, 'error');
  assert.equal(calls, 3);
});

test('reactions on the PR body count and the latest signal wins', () => {
  const pr = fixture();
  pr.comments.nodes.pop(); // automatic review: no request comment after the head
  pr.reactions.nodes.push({ content: 'EYES', createdAt: at('10:01'), user: BOT });
  assert.equal(classify(pr, cfg, NOW).verdict, 'pending');
  pr.reactions.nodes.push({ content: 'THUMBS_UP', createdAt: at('10:30'), user: BOT });
  assert.equal(classify(pr, cfg, NOW).verdict, 'clean');
  pr.reactions.nodes.push({ content: 'EYES', createdAt: at('10:40'), user: BOT });
  assert.equal(classify(pr, cfg, NOW).reviewerState.state, 'reviewing');
});

test('outdated threads are flagged but still block a request', () => {
  const pr = fixture();
  pr.comments.nodes.pop();
  pr.reviewThreads.nodes.push({ ...thread('T0', at('08:00')), isOutdated: true });
  const s = classify(pr, cfg, NOW);
  assert.equal(s.unresolvedThreads[0].outdated, true);
  assert.equal(s.readyToRequest, false);
});

test('wait returns findings immediately', async () => {
  const pr = fixture();
  pr.reviewThreads.nodes.push(thread('T1', '2026-01-01T10:20:00Z', `P1: Handle the empty retry list\n\n${'detail '.repeat(100)}`));
  const v = await waitFor('example-org/example-repo', 7, cfg, { interval: 1, fetch: () => pr, now: () => NOW });
  assert.equal(v.verdict, 'findings');
  assert.equal(v.findings[0].path, 'src/retry.js');
  assert.ok(v.findings[0].body.length > 300, 'wait keeps enough of each finding to act on it');
});

test('fingerprint failsafe trips when a finding returns after two fixes', () => {
  const seen = {};
  const f = (id, body) => ({ id, path: 'src/retry.js', body });
  assert.deepEqual(recordFindings(seen, [f('T1', '**P1** Handle the empty retry list\nmore')]), []);
  assert.deepEqual(recordFindings(seen, [f('T1', 'P1 Handle the empty retry list')]), []); // same thread again
  assert.deepEqual(recordFindings(seen, [f('T2', 'P1  handle the EMPTY retry list')]), []);
  assert.equal(recordFindings(seen, [f('T3', 'P1 Handle the empty retry list')]).length, 1);
});

test('durations and globs', () => {
  assert.equal(parseDuration('40m'), 2400000);
  assert.equal(parseDuration('90s'), 90000);
  assert.ok(globToRegex('**/*.csv').test('data/log/updates.csv'));
  assert.ok(globToRegex('CHANGELOG.md').test('CHANGELOG.md'));
  assert.ok(!globToRegex('*.csv').test('data/updates.csv'));
});

test('union keeps base lines first and drops duplicates', () => {
  assert.equal(unionLines('id,title\na,1\nb,2\n', 'id,title\na,1\nc,3\n'), 'id,title\na,1\nb,2\nc,3\n');
});

// ---------- local reviewer fallback ----------

const botComment = (id, body, hhmm) => ({ id, databaseId: 900, body, createdAt: at(hhmm), author: BOT, reactions: { nodes: [] } });
const QUOTA = 'You have reached your Codex usage limits for code reviews. You can see your limits in the [Codex usage dashboard](https://example.invalid/usage).';

test('quota and failure replies mark the cloud reviewer unavailable', () => {
  for (const body of [QUOTA, "Codex couldn't complete this request. Try again later."]) {
    const pr = fixture();
    pr.comments.nodes.push(botComment('IC_q', body, '10:06'));
    const s = classify(pr, cfg, NOW);
    assert.equal(s.verdict, 'unavailable', body);
    assert.deepEqual(reviewPlan(s, cfg), { local: true });
    assert.deepEqual(reviewPlan(s, { ...cfg, mode: 'cloud' }), {});
  }
});

test('auto falls back only after two timed-out requests on the same head', () => {
  const pr = fixture();
  const later = Date.parse(at('11:00'));
  assert.equal(classify(pr, cfg, later).verdict, 'timeout');
  pr.comments.nodes.push({ ...request(pr), id: 'IC_req2', databaseId: 102, createdAt: at('10:20') });
  const s = classify(pr, cfg, later);
  assert.equal(s.verdict, 'unavailable');
  assert.equal(s.unavailableReason, 'two requests on this head timed out');
});

test('local reviews: mode, one per head and a per-PR cap', () => {
  const local = { ...cfg, mode: 'local' };
  const s = classify(fixture(), local, NOW);
  assert.deepEqual(reviewPlan({ ...s, verdict: 'not_requested' }, local), { local: true });
  assert.deepEqual(reviewPlan({ ...s, verdict: 'findings' }, local), {});
  assert.match(reviewPlan({ ...s, local: { total: 1, onHead: true } }, local).blocked, /only one per head/);
  assert.match(reviewPlan({ ...s, local: { total: 3, onHead: false } }, local).blocked, /limit \(3\)/);
  assert.match(reviewPlan({ ...s, local: { truncated: true, total: 0, onHead: false } }, local).blocked, /too many comments/);
});

test('posted local results classify like cloud results on that head', () => {
  const pr = fixture();
  const me = { login: 'example-dev' };
  pr.comments.nodes.push({ id: 'IC_l', databaseId: 950, body: localCleanBody(pr.headRefOid), createdAt: at('10:30'), author: me, reactions: { nodes: [] } });
  let s = classify(pr, cfg, NOW);
  assert.equal(s.verdict, 'clean');
  assert.deepEqual(s.local, { truncated: false, total: 1, onHead: true });
  pr.comments.nodes.at(-1).body = localCleanBody('2222222222222222222222222222222222222222');
  assert.notEqual(classify(pr, cfg, NOW).verdict, 'clean');
  pr.comments.nodes.at(-1).body = localCleanBody(pr.headRefOid);
  pr.comments.nodes.at(-1).author = { login: 'someone-else' }; // anyone can type the prefix
  s = classify(pr, cfg, NOW);
  assert.notEqual(s.verdict, 'clean');
  assert.deepEqual(s.local, { truncated: false, total: 0, onHead: false });

  const withThread = fixture();
  withThread.reviewThreads.nodes.push(thread('T9', at('10:30'), '[local review] [P1] Null check missing', me));
  withThread.reviews.nodes.push({ id: 'R9', body: '[local review] 1 finding(s) on x.', state: 'COMMENTED', submittedAt: at('10:30'),
    author: me, commit: { oid: withThread.headRefOid }, comments: { totalCount: 1 } });
  s = classify(withThread, cfg, NOW);
  assert.equal(s.verdict, 'findings');
  assert.equal(s.reviewerState.count, 1);
});

test('wait runs one local review on fallback, then classifies the posted result', async () => {
  const pr = fixture();
  pr.comments.nodes.push(botComment('IC_q', QUOTA, '10:06'));
  let calls = 0;
  const v = await waitFor('example-org/example-repo', 7, cfg, {
    interval: 1, now: () => NOW, pause: async () => {}, fetch: () => pr,
    runLocal: (repo, s) => {
      calls++;
      pr.comments.nodes.push({ id: 'IC_l', databaseId: 951, body: localCleanBody(s.head), createdAt: at('10:07'), author: { login: 'example-dev' }, reactions: { nodes: [] } });
      return null;
    },
  });
  assert.equal(calls, 1);
  assert.equal(v.verdict, 'clean');
});

test('local review payload: inline comments with a prefix, body fallback without a line', () => {
  const findings = [
    { path: 'src/a.js', line: 4, severity: 'P1', body: 'Off-by-one in the loop bound.' },
    { path: 'README.md', line: 0, severity: 'P3', body: 'Example uses a removed flag.' },
  ];
  const p = localReviewPayload('abc123', findings);
  assert.equal(p.commit_id, 'abc123');
  assert.equal(p.event, 'COMMENT');
  assert.deepEqual(p.comments, [{ path: 'src/a.js', line: 4, side: 'RIGHT', body: '[local review] [P1] Off-by-one in the loop bound.' }]);
  assert.match(p.body, /^\[local review\] 2 finding\(s\) on abc123\.\n- README\.md \[P3\]/);
  const flat = localReviewPayload('abc123', findings, false);
  assert.equal(flat.comments.length, 0);
  assert.match(flat.body, /src\/a\.js:4 \[P1\]/);
});

test('reviewer output is validated strictly', () => {
  assert.deepEqual(parseReview('Here you go: {"findings":[]}'), []);
  assert.equal(parseReview({ findings: [{ path: 'a', line: 1, severity: 'P2', body: 'x' }] }).length, 1);
  assert.throws(() => parseReview('no json here'));
  assert.throws(() => parseReview({ result: 'fine' }), /no findings array/);
  assert.throws(() => parseReview({ findings: [{ path: 'a', line: '1', severity: 'P2', body: 'x' }] }), /malformed finding/);
});

// ---------- sync against throwaway git repositories ----------

// Isolate git from the caller's configuration; syncBranch inherits this environment.
Object.assign(process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid' });

function gitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'prloop-test-'));
  const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const remote = join(dir, 'remote.git'), work = join(dir, 'work');
  run(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  run(dir, 'clone', '-q', remote, work);
  const commit = (msg, files) => { for (const [f, c] of Object.entries(files)) writeFileSync(join(work, f), c); run(work, 'add', '.'); run(work, 'commit', '-qm', msg); };
  commit('base', { 'log.csv': 'id\na\n', 'app.txt': 'one\n' });
  run(work, 'push', '-q', 'origin', 'main');
  run(work, 'switch', '-qc', 'feat');
  return { dir, work, run, commit };
}

function divergeOnMain(r, files) {
  r.run(r.work, 'switch', '-q', 'main');
  r.commit('main change', files);
  r.run(r.work, 'push', '-q', 'origin', 'main');
  r.run(r.work, 'switch', '-q', 'feat');
}

for (const settings of [{ merge: true, squash: true }, { merge: false, squash: false }]) {
  const method = settings.merge ? 'merge' : 'rebase';

  test(`sync (${method}) resolves append-only conflicts by union`, (t) => {
    const r = gitRepo();
    t.after(() => rmSync(r.dir, { recursive: true, force: true }));
    r.commit('feature', { 'log.csv': 'id\na\nfeature\n' });
    r.run(r.work, 'push', '-q', 'origin', 'feat');
    divergeOnMain(r, { 'log.csv': 'id\na\nbase\n' });
    const head = r.run(r.work, 'rev-parse', 'HEAD');
    const v = syncBranch({ cwd: r.work, branch: 'feat', base: 'main', head, settings, union: ['*.csv'] });
    assert.equal(v.verdict, 'synced', JSON.stringify(v));
    assert.equal(v.method, method);
    assert.equal(readFileSync(join(r.work, 'log.csv'), 'utf8'), 'id\na\nbase\nfeature\n');
    assert.equal(r.run(r.work, 'rev-parse', 'origin/feat'), v.head);
  });

  test(`sync (${method}) aborts cleanly on other conflicts`, (t) => {
    const r = gitRepo();
    t.after(() => rmSync(r.dir, { recursive: true, force: true }));
    r.commit('feature', { 'app.txt': 'feature\n', 'log.csv': 'id\na\nfeature\n' });
    r.run(r.work, 'push', '-q', 'origin', 'feat');
    divergeOnMain(r, { 'app.txt': 'base\n', 'log.csv': 'id\na\nbase\n' });
    const head = r.run(r.work, 'rev-parse', 'HEAD');
    const v = syncBranch({ cwd: r.work, branch: 'feat', base: 'main', head, settings, union: ['*.csv'] });
    assert.equal(v.verdict, 'conflict');
    assert.deepEqual(v.conflicts, ['app.txt']);
    assert.equal(r.run(r.work, 'rev-parse', 'HEAD'), head);
    assert.equal(r.run(r.work, 'status', '--porcelain'), '');
    assert.equal(r.run(r.work, 'branch', '--show-current'), 'feat');
  });
}

test('the local gate requires the PR checkout, a clean tree and a tested pushed head', (t) => {
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  const head = r.run(r.work, 'rev-parse', 'HEAD');
  const s = { branch: 'feat', head };
  assert.match(localGate(s, r.work).join(), /not marked tested/);
  markTested(head, r.work);
  assert.deepEqual(localGate(s, r.work), []);
  writeFileSync(join(r.work, 'app.txt'), 'dirty\n');
  assert.match(localGate(s, r.work).join(), /not clean/);
  r.run(r.work, 'checkout', '--', 'app.txt');
  r.run(r.work, 'switch', '-q', 'main');
  assert.match(localGate(s, r.work).join(), /not in a checkout of feat/); // the marker is shared across worktrees
});

test('dirty checks ignore config that hides untracked files', (t) => {
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  const head = r.run(r.work, 'rev-parse', 'HEAD');
  markTested(head, r.work);
  r.run(r.work, 'config', 'status.showUntrackedFiles', 'no');
  writeFileSync(join(r.work, 'new.txt'), 'untracked\n');
  assert.match(localGate({ branch: 'feat', head }, r.work).join(), /not clean/);
});

test('a local review fails closed when the base cannot be fetched', (t) => {
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  const head = r.run(r.work, 'rev-parse', 'HEAD');
  markTested(head, r.work);
  const s = { pr: 7, head, branch: 'feat', base: 'no-such-base', unresolvedThreads: [] };
  const v = localReview('example-org/example-repo', s, cfg, r.work); // never reaches the reviewer agent
  assert.equal(v.verdict, 'blocked');
  assert.match(v.reason, /could not fetch base/);
});
