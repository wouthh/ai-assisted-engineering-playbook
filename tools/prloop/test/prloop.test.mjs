import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  classify, config, globToRegex, parseDuration, recordFindings, syncBranch, unionLines, waitFor,
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
  pr.reviewThreads.nodes.push(thread('T1', '2026-01-01T10:20:00Z'));
  const v = await waitFor('example-org/example-repo', 7, cfg, { interval: 1, fetch: () => pr, now: () => NOW });
  assert.equal(v.verdict, 'findings');
  assert.equal(v.findings[0].path, 'src/retry.js');
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
