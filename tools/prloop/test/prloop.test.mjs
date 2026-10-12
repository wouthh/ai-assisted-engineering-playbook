import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  EXIT, OUTPUT_TAIL, main, disambiguate, acquireSlots, gateCost, machineConfig, repoConfig, markQueued, slotDir, agentFailure, saveAgentLog, pruneAgentLogs, takeLock, procStart, lockHolder, acquireSlot, admit, admitStep, machineLine, parseSize, runGate, selfCheck, slotsInUse, buildPrompt, patchId, recordCarry, resetRounds, checkWorktree, classify, headSeenAt, localReviewPrompt, plain, config, globToRegex, isTested, parseAgentResult, readyGate, gatePassed, recordGatePass, unmarkTested, editLines, agentEnv, agentUsage, addUsage, runStatus, localCleanBody, localGate, localReview, markTested, localReviewPayload, parseArgs, parseReview, reviewPlan, runExitCode, parseDuration, recordFindings, runAll, syncBranch, unionLines, waitFor,
} from '../prloop.mjs';

const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
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
  request(pr).reactions.nodes.push({ content: 'EYES', createdAt: at('10:06'), user: BOT });
  pr.comments.nodes.push({ id: 'IC_bot', databaseId: 102, body: "Codex Review: Didn't find any major issues. Nice work.",
    createdAt: '2026-01-01T10:20:00Z', author: BOT, reactions: { nodes: [] } });
  assert.equal(classify(pr, cfg, NOW).verdict, 'clean');
});

test('a delayed clean comment after a new request but before its acknowledgement does not count', () => {
  const pr = fixture();
  pr.comments.nodes.push({ id: 'IC_bot', databaseId: 102, body: "Codex Review: Didn't find any major issues. Nice work.",
    createdAt: at('10:07'), author: BOT, reactions: { nodes: [] } }); // the previous head's review finishing late
  assert.equal(classify(pr, cfg, NOW).verdict, 'pending');
  request(pr).reactions.nodes.push({ content: 'EYES', createdAt: at('10:08'), user: BOT });
  assert.equal(classify(pr, cfg, NOW).verdict, 'pending'); // the acknowledgement came after that comment
});

// A current request answered with a clean summary comment and a 👍 on the PR body, with no 👀 anywhere.
function cleanWithoutAck(named) {
  const pr = fixture();
  pr.headRefOid = pr.commits.nodes[0].commit.oid = '2603924'.padEnd(40, 'a');
  pr.commits.nodes[0].commit.committedDate = '2026-01-01T21:50:00Z';
  Object.assign(request(pr), { createdAt: '2026-01-01T22:03:48Z' });
  pr.comments.nodes.push({ id: 'IC_bot', databaseId: 102, author: BOT, reactions: { nodes: [] }, createdAt: '2026-01-01T22:06:06Z',
    body: `### Codex Review\n\nDidn't find any major issues. Keep it up!\n\nReviewed commit: \`${named}\`` });
  return pr;
}
const AFTER = Date.parse('2026-01-01T22:07:00Z');

test('without eyes, a clean comment naming the head clears it but a PR-body thumbs-up alone does not', () => {
  const both = cleanWithoutAck('2603924');
  const cfg = { ...config({}, {}), disambiguate: (p) => (p === '2603924' ? [both.headRefOid] : []) }; // the abbreviation resolves to the head only
  both.reactions.nodes.push({ content: 'THUMBS_UP', createdAt: '2026-01-01T22:06:11Z', user: BOT });
  assert.deepEqual([classify(both, cfg, AFTER).reviewerState.state, classify(both, cfg, AFTER).verdict], ['clean', 'clean']);
  const thumbOnly = cleanWithoutAck('2603924');
  thumbOnly.comments.nodes.pop();
  thumbOnly.reactions.nodes.push({ content: 'THUMBS_UP', createdAt: '2026-01-01T22:06:11Z', user: BOT });
  thumbOnly.comments.nodes.shift(); // no earlier request visible
  // No visible earlier cycle proves nothing: this 👍 may be a previous head's automatic review's first signal.
  assert.equal(classify(thumbOnly, cfg, AFTER).reviewerState.state, 'none');
  assert.equal(classify(cleanWithoutAck('2603924'), cfg, AFTER).verdict, 'clean'); // the comment names this head
});

test('a named commit clears the head only as its full OID or an abbreviation that resolves to it alone', (t) => {
  const head = cleanWithoutAck('x').headRefOid;
  assert.equal(classify(cleanWithoutAck(head), cfg, AFTER).verdict, 'clean'); // the full OID needs no repository
  assert.notEqual(classify(cleanWithoutAck('2603924'), cfg, AFTER).reviewerState.state, 'clean'); // unknown here: a prefix match is not enough
  const twins = { ...cfg, disambiguate: () => [head, '2603924'.padEnd(40, 'b')] };
  assert.notEqual(classify(cleanWithoutAck('2603924'), twins, AFTER).reviewerState.state, 'clean'); // ambiguous abbreviation
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  const sha = r.run(r.work, 'rev-parse', 'HEAD');
  assert.deepEqual(disambiguate(sha.slice(0, 9), r.work), [sha]);
  assert.deepEqual(disambiguate('0000000', r.work), []);  // The abbreviation resolves in the PR's worktree (`cfg.cwd`), not wherever prloop was launched.
  const inWorktree = cleanWithoutAck(sha.slice(0, 9));
  inWorktree.headRefOid = inWorktree.commits.nodes[0].commit.oid = sha;
  assert.notEqual(classify(inWorktree, cfg, AFTER).verdict, 'clean');
  assert.equal(classify(inWorktree, { ...cfg, cwd: r.work }, AFTER).verdict, 'clean');
});

test('a PR-body thumbs-up after a new request never clears it, even after this cycle\'s eyes', () => {
  const pr = cleanWithoutAck('2603924');
  pr.comments.nodes.pop(); // only the PR-body reaction answers; IC_old's review could still finish late
  pr.reactions.nodes.push({ content: 'THUMBS_UP', createdAt: '2026-01-01T22:06:11Z', user: BOT });
  assert.equal(classify(pr, cfg, AFTER).reviewerState.state, 'none'); // a late 👍 from the earlier cycle must not clear this head
  request(pr).reactions.nodes.push({ content: 'EYES', createdAt: '2026-01-01T22:04:00Z', user: BOT });
  // Acknowledging this request does not bind a later PR-body 👍 to it: the earlier review may still post it.
  assert.equal(classify(pr, cfg, AFTER).reviewerState.state, 'reviewing');
});

test('a PR-body eyes from before the current request does not let a late thumbs-up clear the new head', () => {
  const pr = fixture(); // IC_old at 09:00, head at 10:00, IC_req at 10:05
  pr.reactions = { nodes: [{ content: 'EYES', createdAt: at('10:02'), user: BOT }, { content: 'THUMBS_UP', createdAt: at('10:06'), user: BOT }] };
  assert.equal(classify(pr, cfg, NOW).reviewerState.state, 'none'); // both belong to IC_old's review
  pr.reactions.nodes.push({ content: 'EYES', createdAt: at('10:05'), user: BOT }, { content: 'THUMBS_UP', createdAt: at('10:07'), user: BOT });
  assert.equal(classify(pr, cfg, Date.parse(at('10:08'))).reviewerState.state, 'reviewing'); // a body 👍 never clears a request
});

test('a PR-body eyes after the head but before the request marks an earlier cycle even without an older request', () => {
  const pr = fixture();
  pr.comments.nodes = pr.comments.nodes.filter((c) => c.createdAt >= at('10:00')); // an automatic review: no older request
  pr.reactions = { nodes: [{ content: 'EYES', createdAt: at('10:02'), user: BOT }, { content: 'THUMBS_UP', createdAt: at('10:06'), user: BOT }] };
  assert.equal(classify(pr, cfg, NOW).reviewerState.state, 'none'); // the 👍 may finish the earlier automatic review
});

test('a PR-body thumbs-up without eyes does not count when older PR-body reactions were truncated', () => {
  const pr = cleanWithoutAck('2603924');
  pr.comments.nodes.pop();
  pr.comments.nodes.shift(); // no earlier request visible
  pr.reactions.nodes.push({ content: 'THUMBS_UP', createdAt: '2026-01-01T22:06:11Z', user: BOT });
  pr.reactions.pageInfo = { hasPreviousPage: true }; // an older cycle's reaction may be cut off
  assert.equal(classify(pr, cfg, AFTER).reviewerState.state, 'none');
});

test('an unacknowledged clean comment naming an older commit does not clear the head', () => {
  const pr = cleanWithoutAck('1111111');
  assert.equal(classify(pr, cfg, AFTER).reviewerState.state, 'none'); // no clean signal: after the ack timeout it times out
  request(pr).reactions.nodes.push({ content: 'EYES', createdAt: '2026-01-01T22:04:00Z', user: BOT });
  assert.equal(classify(pr, cfg, AFTER).verdict, 'pending'); // even after an acknowledgement
  const before = cleanWithoutAck('2603924');
  before.reactions.nodes.push({ content: 'THUMBS_UP', createdAt: '2026-01-01T22:03:00Z', user: BOT }); // before the request
  before.comments.nodes.pop();
  assert.equal(classify(before, cfg, AFTER).reviewerState.state, 'none');
});

test('an unacknowledged clean comment naming no commit never clears the head', () => {
  const pr = fixture();
  pr.comments.nodes.push({ id: 'IC_bot', databaseId: 102, body: "Codex Review: Didn't find any major issues.", createdAt: at('10:07'), author: BOT, reactions: { nodes: [] } });
  assert.equal(classify(pr, cfg, NOW).verdict, 'pending'); // the older request IC_old could still finish late
  pr.comments.nodes.shift();
  assert.equal(classify(pr, cfg, NOW).verdict, 'pending'); // a previous head's automatic review may finish late too
  request(pr).reactions.nodes.push({ content: 'EYES', createdAt: at('10:06'), user: BOT });
  assert.equal(classify(pr, cfg, NOW).verdict, 'clean');
});

test('a clean bot comment without a request or eyes on this head does not count', () => {
  const pr = fixture();
  pr.comments.nodes.pop(); // automatic review: no request after the head
  pr.comments.nodes.push({ id: 'IC_bot', databaseId: 102, body: "Codex Review: Didn't find any major issues. Nice work.",
    createdAt: at('10:20'), author: BOT, reactions: { nodes: [] } });
  assert.equal(classify(pr, cfg, NOW).verdict, 'not_requested');
  pr.reactions.nodes.push({ content: 'EYES', createdAt: at('10:01'), user: BOT });
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

test('a head first seen after a request does not inherit that request (fast-forward to an older commit)', () => {
  const pr = fixture();
  request(pr).reactions.nodes.push({ content: 'THUMBS_UP', createdAt: at('10:20'), user: BOT });
  pr.headSeenAt = at('10:30'); // the old-dated commit became the head after the clean signal
  const s = classify(pr, cfg, Date.parse(at('10:31')));
  assert.equal(s.trigger.afterHead, false);
  assert.equal(s.verdict, 'not_requested');
});

test('a lone PR-body thumbs-up after a head change does not clear the new head', () => {
  const pr = fixture();
  pr.comments.nodes.pop(); // no request for this head
  pr.reactions.nodes.push({ content: 'THUMBS_UP', createdAt: at('10:20'), user: BOT }); // late result of the previous head's review
  assert.equal(classify(pr, cfg, NOW).verdict, 'not_requested');
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
  assert.equal(runExitCode([{ verdict: 'clean' }, { verdict: 'merge_pending' }]), 50); // the PR is still open
});

test('the default reviewer login is anchored', () => {
  const pr = fixture();
  request(pr).reactions.nodes.push({ content: 'THUMBS_UP', createdAt: at('10:20'), user: { login: 'not-chatgpt-codex-connector-fan' } });
  assert.equal(classify(pr, cfg, NOW).verdict, 'pending');
});

test('a request hidden behind more than 100 newer comments fails closed', () => {
  const pr = fixture();
  pr.comments.pageInfo = { hasPreviousPage: true };
  pr.comments.nodes = [{ id: 'IC_n', databaseId: 1, body: 'thanks', createdAt: at('10:30'), author: { login: 'example-dev' }, reactions: { nodes: [] } }];
  assert.throws(() => classify(pr, cfg, NOW), /more than 100 comments since the head/);
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
    request(pr).reactions.nodes.push({ content: 'EYES', createdAt: at('10:05'), user: BOT });
    pr.comments.nodes.push(botComment('IC_q', body, '10:06'));
    const s = classify(pr, cfg, NOW);
    assert.equal(s.verdict, 'unavailable', body);
    assert.deepEqual(reviewPlan(s, cfg), { local: true });
    assert.deepEqual(reviewPlan(s, { ...cfg, mode: 'cloud' }), {});
  }
});

test('a failure reply before this cycle is acknowledged does not mark it unavailable', () => {
  const pr = fixture();
  pr.comments.nodes.push(botComment('IC_q', "Codex couldn't complete this request. Try again later.", '10:06'));
  const s = classify(pr, cfg, NOW);
  assert.equal(s.verdict, 'pending');
  assert.deepEqual(reviewPlan(s, cfg), {});
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
  request(pr).reactions.nodes.push({ content: 'EYES', createdAt: at('10:05'), user: BOT });
  pr.comments.nodes.push(botComment('IC_q', QUOTA, '10:06'));
  let calls = 0;
  const v = await waitFor('example-org/example-repo', 7, cfg, {
    interval: 1, now: () => NOW, pause: async () => {}, fetch: () => pr, metrics: idle().metrics,
    runLocal: (repo, s, c, cwd, onLog) => {
      calls++;
      onLog('/state/agents/review.log');
      pr.comments.nodes.push({ id: 'IC_l', databaseId: 951, body: localCleanBody(s.head), createdAt: at('10:07'), author: { login: 'example-dev' }, reactions: { nodes: [] } });
      return null;
    },
  });
  assert.equal(calls, 1);
  assert.equal(v.verdict, 'clean');
  assert.equal(v.agentLog, '/state/agents/review.log');
});

test('wait drops the local reviewer log when the head moved after that review posted', async () => {
  const pr = fixture();
  request(pr).reactions.nodes.push({ content: 'EYES', createdAt: at('10:05'), user: BOT });
  pr.comments.nodes.push(botComment('IC_q', QUOTA, '10:06'));
  const moved = { ...fixture(), headRefOid: 'f'.repeat(40) };
  moved.comments.nodes.pop(); // no request on the new head
  let current = pr;
  const v = await waitFor('example-org/example-repo', 7, { ...cfg, mode: 'auto' }, {
    interval: 1, now: () => NOW, pause: async () => {}, fetch: () => current, metrics: idle().metrics,
    runLocal: (repo, s, c, cwd, onLog) => { onLog('/state/agents/review.log'); current = moved; return null; },
  });
  assert.equal(v.head, 'f'.repeat(40));
  assert.equal(v.agentLog, undefined);
});

test('wait reports the local reviewer log when the review fails after saving it', async () => {
  const pr = fixture();
  request(pr).reactions.nodes.push({ content: 'EYES', createdAt: at('10:05'), user: BOT });
  pr.comments.nodes.push(botComment('IC_q', QUOTA, '10:06'));
  const v = await waitFor('example-org/example-repo', 7, cfg, {
    interval: 1, now: () => NOW, pause: async () => {}, fetch: () => pr, metrics: idle().metrics,
    runLocal: (repo, s, c, cwd, onLog) => { onLog('/state/agents/review.log'); return { verdict: 'blocked', pr: 7, head: s.head, reason: 'posting the review failed' }; },
  });
  assert.equal(v.verdict, 'blocked');
  assert.equal(v.agentLog, '/state/agents/review.log');
});

test('wait admits a local review only when load and memory allow', async () => {
  const pr = fixture();
  request(pr).reactions.nodes.push({ content: 'EYES', createdAt: at('10:05'), user: BOT });
  pr.comments.nodes.push(botComment('IC_q', QUOTA, '10:06'));
  const x = idle({ load: 7 }); // above 0.75 x 8 cores
  const c = { ...cfg, interval: 1000, resourceWait: 60e3, timeout: 24 * 3600e3, ackTimeout: 24 * 3600e3 };
  let startedAt;
  const v = await waitFor('example-org/example-repo', 7, c, {
    interval: c.interval, fetch: () => pr, metrics: x.metrics, log: x.log,
    now: () => NOW + x.clock.t, pause: async (ms) => { x.clock.t += ms; if (x.clock.t >= 5000) x.m.load = 2; },
    runLocal: (repo, s) => { startedAt = x.clock.t; return { verdict: 'error', error: 'stop' }; },
  });
  assert.equal(v.error, 'stop');
  assert.equal(startedAt, 5000);
  assert.deepEqual(x.events.map((e) => e.event), ['waiting_for_resources']);
});

test('wait re-fetches the PR after resource admission and reviews the current head', async () => {
  const pr = fixture();
  request(pr).reactions.nodes.push({ content: 'EYES', createdAt: at('10:05'), user: BOT });
  pr.comments.nodes.push(botComment('IC_q', QUOTA, '10:06'));
  const x = idle({ load: 7 });
  const c = { ...cfg, mode: 'local', interval: 1000, resourceWait: 60e3, timeout: 24 * 3600e3, ackTimeout: 24 * 3600e3 };
  let current = pr;
  const v = await waitFor('example-org/example-repo', 7, c, {
    interval: c.interval, fetch: () => current, metrics: x.metrics, log: x.log, now: () => NOW + x.clock.t,
    pause: async (ms) => { x.clock.t += ms; if (x.clock.t >= 5000) { x.m.load = 2; current = { ...pr, headRefOid: 'f'.repeat(40) }; } },
    runLocal: (repo, s) => ({ verdict: 'error', error: s.head }),
  });
  assert.equal(v.error, 'f'.repeat(40));
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

test('sync refuses to resolve a union file that is a symlink', (t) => {
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  const link = (target, msg) => {
    rmSync(join(r.work, 'log.csv'), { force: true });
    symlinkSync(join(r.dir, target), join(r.work, 'log.csv'));
    r.run(r.work, 'add', '-A');
    r.run(r.work, 'commit', '-qm', msg);
  };
  for (const f of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(r.dir, f), 'keep\n');
  r.run(r.work, 'switch', '-q', 'main');
  link('a.txt', 'link');
  r.run(r.work, 'push', '-q', 'origin', 'main');
  r.run(r.work, 'switch', '-q', 'feat');
  r.run(r.work, 'reset', '-q', '--hard', 'main');
  link('b.txt', 'feature');
  r.run(r.work, 'push', '-q', 'origin', 'feat');
  r.run(r.work, 'switch', '-q', 'main');
  link('c.txt', 'retarget');
  r.run(r.work, 'push', '-q', 'origin', 'main');
  r.run(r.work, 'switch', '-q', 'feat');
  const head = r.run(r.work, 'rev-parse', 'HEAD');
  const v = syncBranch({ cwd: r.work, branch: 'feat', base: 'main', head, settings: { merge: true }, union: ['*.csv'] });
  assert.equal(v.verdict, 'conflict', JSON.stringify(v));
  assert.deepEqual(v.conflicts, ['log.csv']);
  for (const f of ['a.txt', 'b.txt', 'c.txt']) assert.equal(readFileSync(join(r.dir, f), 'utf8'), 'keep\n');
  assert.equal(r.run(r.work, 'rev-parse', 'HEAD'), head);
});

test('the local gate requires the PR checkout, a clean tree and a tested pushed head', (t) => {
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  const head = r.run(r.work, 'rev-parse', 'HEAD');
  const s = { branch: 'feat', head };
  assert.match(localGate(s, r.work).join(), /not marked tested.*then `prloop mark-tested`\)/);
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

test('a local review fails closed when the base cannot be fetched', async (t) => {
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  const head = r.run(r.work, 'rev-parse', 'HEAD');
  markTested(head, r.work);
  const s = { pr: 7, head, branch: 'feat', base: 'no-such-base', unresolvedThreads: [] };
  const v = await localReview('example-org/example-repo', s, cfg, r.work); // never reaches the reviewer agent
  assert.equal(v.verdict, 'blocked');
  assert.match(v.reason, /could not fetch origin\/no-such-base/);
});

test('a local reviewer\'s raw output is kept and named when its result is malformed', async (t) => {
  const state = tempState(t);
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  r.run(r.work, 'push', '-q', 'origin', 'feat');
  const head = r.run(r.work, 'rev-parse', 'HEAD');
  markTested(head, r.work);
  const old = process.env.PATH;
  t.after(() => { process.env.PATH = old; });
  mkdirSync(join(r.dir, 'bin'));
  writeFileSync(join(r.dir, 'bin', 'claude'), '#!/bin/sh\necho \'{"type":"result","subtype":"success","result":"Looks fine to me."}\'\necho warn >&2\n', { mode: 0o755 });
  process.env.PATH = `${join(r.dir, 'bin')}:${old}`;
  const s = { pr: 7, head, branch: 'feat', base: 'main', baseOid: head, unresolvedThreads: [] };
  let seen;
  const v = await localReview('example-org/example-repo', s, cfg, r.work, (p) => { seen = p; });
  assert.equal(v.verdict, 'blocked');
  assert.equal(v.agentLog, seen);
  assert.ok(v.agentLog.startsWith(join(state, 'agents', 'example-org__example-repo__7__')));
  assert.match(readFileSync(v.agentLog, 'utf8'), /Looks fine to me[\s\S]*## stderr\nwarn/);
});

test('a local review diffs from the fetched base when the PR already merged a base newer than baseRefOid', async (t) => {
  tempState(t);
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  const stale = r.run(r.work, 'rev-parse', 'main');
  r.commit('feature', { 'app.txt': 'two\n' });
  divergeOnMain(r, { 'log.csv': 'id\na\nb\n' });
  r.run(r.work, 'merge', '-q', '--no-edit', 'origin/main');
  r.run(r.work, 'push', '-q', 'origin', 'feat');
  const head = r.run(r.work, 'rev-parse', 'HEAD');
  markTested(head, r.work);
  const old = process.env.PATH;
  t.after(() => { process.env.PATH = old; });
  mkdirSync(join(r.dir, 'bin'));
  writeFileSync(join(r.dir, 'bin', 'claude'), `#!/bin/sh\nprintf '%s' "$2" > "${join(r.dir, 'prompt')}"\nexit 1\n`, { mode: 0o755 });
  process.env.PATH = `${join(r.dir, 'bin')}:${old}`;
  await localReview('example-org/example-repo', { pr: 7, head, branch: 'feat', base: 'main', baseOid: stale, unresolvedThreads: [] }, cfg, r.work);
  const newBase = r.run(r.work, 'rev-parse', 'origin/main');
  assert.match(readFileSync(join(r.dir, 'prompt'), 'utf8'), new RegExp(`git diff ${newBase}\\.\\.\\.HEAD`));
});

const PRLOOP = join(import.meta.dirname, '..', 'prloop.mjs');

test('a held worktree lock refuses ready, sync and mark-tested unless the caller carries its token', (t) => {
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  const lock = takeLock(r.work, 'fix agent for PR #7'); // held by this live test process
  t.after(() => lock.release());
  const cli = (args, env = {}) => spawnSync(process.execPath, [PRLOOP, ...args], { cwd: r.work, encoding: 'utf8', env: { ...process.env, PRLOOP_LOCK_TOKEN: '', ...env } });
  for (const args of [['mark-tested'], ['ready', '7'], ['sync', '7']]) {
    const res = cli(args);
    assert.equal(res.status, 40, args.join(' '));
    assert.match(JSON.parse(res.stdout).error, new RegExp(`locked by prloop process ${process.pid} \\(fix agent for PR #7, since `));
  }
  assert.equal(cli(['mark-tested'], { PRLOOP_LOCK_TOKEN: 'wrong' }).status, 40);
  assert.equal(cli(['mark-tested'], { PRLOOP_LOCK_TOKEN: lock.token }).status, 0);
  assert.equal(takeLock(r.work, 'another run').holder.pid, process.pid);
  const st = spawnSync(process.execPath, [PRLOOP, 'lock-status', r.work], { encoding: 'utf8' });
  assert.equal(st.status, 50);
  assert.deepEqual(pick(JSON.parse(st.stdout), ['locked']), { locked: true });
  assert.deepEqual(pick(JSON.parse(st.stdout).holder, ['pid', 'purpose']), { pid: process.pid, purpose: 'fix agent for PR #7' });
  lock.release();
  assert.equal(spawnSync(process.execPath, [PRLOOP, 'lock-status', r.work]).status, 0);
  assert.equal(lockHolder(r.work, null), null);
  assert.equal(cli(['mark-tested']).status, 0);
});

test('a worktree lock held by a dead process is reclaimed', (t) => {
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const stale = takeLock(r.work, 'crashed run', dead);
  assert.ok(stale.token);
  assert.equal(lockHolder(r.work, null), null);
  const lock = takeLock(r.work, 'fix agent for PR #7');
  assert.ok(lock.token && !lock.holder);
  lock.release();
});

test('sync refuses a base ref that lacks the PR base commit', (t) => {
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  r.commit('feature', { 'app.txt': 'feature\n' });
  r.run(r.work, 'push', '-q', 'origin', 'feat');
  const head = r.run(r.work, 'rev-parse', 'HEAD');
  const v = syncBranch({ cwd: r.work, branch: 'feat', base: 'main', baseOid: head, head, settings: { merge: true } });
  assert.equal(v.verdict, 'error');
  assert.match(v.error, /does not contain the PR base commit/);
});

test('sync fetches the base into its remote-tracking ref in a single-branch clone', (t) => {
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  r.commit('feature', { 'app.txt': 'feature\n' });
  r.run(r.work, 'push', '-q', 'origin', 'feat');
  const head = r.run(r.work, 'rev-parse', 'HEAD');
  r.run(r.work, 'config', 'remote.origin.fetch', '+refs/heads/feat:refs/remotes/origin/feat');
  divergeOnMain(r, { 'other.txt': 'main\n' });
  const main = r.run(r.work, 'rev-parse', 'main');
  r.run(r.work, 'update-ref', 'refs/remotes/origin/main', `${main}~1`); // a stale tracking ref
  const v = syncBranch({ cwd: r.work, branch: 'feat', base: 'main', baseOid: main, head, settings: { merge: true } });
  assert.notEqual(v.verdict, 'error', JSON.stringify(v));
  assert.equal(r.run(r.work, 'rev-parse', 'origin/main'), main);
});

test('ready runs the gate: a failure returns the tail, a pass marks the head tested', async (t) => {
  tempState(t);
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  const head = r.run(r.work, 'rev-parse', 'HEAD');
  const s = { branch: 'feat', head };
  const deps = { ...idle(), dir: join(r.dir, 'slots') };
  const failed = await readyGate(s, { ...cfg, gate: 'echo step one; echo "FAIL tests/a.test.js"; exit 3' }, r.work, deps);
  assert.deepEqual([failed.ok, failed.status], [false, 3]);
  assert.match(failed.tail, /FAIL tests\/a\.test\.js$/);
  assert.equal(isTested(head, r.work), false);
  assert.deepEqual(await readyGate(s, { ...cfg, gate: 'true' }, r.work, deps), { ok: true });
  assert.equal(isTested(head, r.work), true);
  assert.deepEqual(await readyGate(s, { ...cfg, gate: 'true' }, r.work, deps), { ok: true, cached: head }); // the same gate does not rerun
  assert.deepEqual(readdirSync(deps.dir), []); // the gate slot was released
});

// Machine metrics, clock and pause for the resource tests: no real sleeps, no real load.
const GiB = 2 ** 30;
function idle(over = {}) {
  const clock = { t: 0 }, events = [];
  const m = { load: 1, cores: 8, freeMem: 16 * GiB, totalMem: 32 * GiB, ...over };
  return { m, clock, events, metrics: () => ({ ...m }), now: () => clock.t, pause: async (ms) => { clock.t += ms; }, log: (e) => events.push(e) };
}
const deadPid = () => spawnSync('true').pid; // exited, so the PID names no process

test('gate slots: exclusive up to N, released, and a dead owner\'s slot is reclaimed', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'prloop-slots-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const a = acquireSlot(dir, 2), b = acquireSlot(dir, 2);
  assert.ok(a && b);
  assert.equal(acquireSlot(dir, 2), null);
  assert.equal(slotsInUse(dir), 2);
  a();
  const c = acquireSlot(dir, 2);
  assert.ok(c);
  b(); c();
  assert.equal(slotsInUse(dir), 0);
  assert.deepEqual(readdirSync(dir), []);
  const dead = `slot-0.${deadPid()}.0`;
  writeFileSync(join(dir, dead), ''); // a prloop that was killed while holding the slot
  assert.equal(slotsInUse(dir), 0);
  const d = acquireSlot(dir, 1);
  assert.ok(d);
  assert.deepEqual(readdirSync(dir).map((f) => f.split('.').slice(0, 2).join('.')), [`slot-0.${process.pid}`]); // the dead claim is gone
  // A racing claim that appeared first wins: this process backs off instead of sharing the slot.
  d();
  writeFileSync(join(dir, `slot-0.${process.ppid}.0`), '');
  assert.equal(acquireSlot(dir, 1), null);
});

test('a slot or lock claim whose PID now names another process is reclaimed', { skip: !existsSync('/proc/self/stat') }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'prloop-slots-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, `slot-0.${process.pid}.99`), '1'); // this PID, but a process that started at tick 1
  assert.equal(slotsInUse(dir), 0);
  const release = acquireSlot(dir, 1);
  assert.ok(release);
  assert.equal(slotsInUse(dir), 1); // the real owner's start time matches
  release();
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  const lockDir = join(r.run(r.work, 'rev-parse', '--absolute-git-dir'), 'prloop-lock');
  mkdirSync(lockDir);
  writeFileSync(join(lockDir, `${process.pid}.99`), JSON.stringify({ pid: process.pid, start: '1', purpose: 'crashed run', token: 'x' }));
  assert.equal(lockHolder(r.work, null), null);
  const lock = takeLock(r.work, 'fix agent');
  assert.ok(lock.token);
  assert.equal(lockHolder(r.work, null).pid, process.pid);
  lock.release();
});

test('a slot or lock claim stays live while a child outlives its killed owner', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'prloop-slots-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const kid = spawn('sleep', ['30']);
  t.after(() => kid.kill());
  const release = acquireSlot(dir, 1, deadPid()); // the owner was killed while its gate still runs
  release.adopt(kid.pid);
  assert.equal(slotsInUse(dir), 1);
  assert.equal(acquireSlot(dir, 1), null);
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  const lock = takeLock(r.work, 'fix agent for PR #7', deadPid());
  lock.adopt(kid.pid);
  assert.equal(takeLock(r.work, 'another run').holder.purpose, 'fix agent for PR #7');
  kid.kill();
  await new Promise((done) => kid.on('exit', done));
  assert.equal(slotsInUse(dir), 0);
  assert.equal(lockHolder(r.work, null), null);
  // runGate records the gate shell in its slot claim.
  const ran = await runGate(`cat "${dir}"/slot-0.*; echo; echo $$`, dir, { ...cfg, gateSlots: 1 }, { ...idle(), dir });
  const lines = ran.stdout.trim().split('\n');
  assert.equal(lines[1].split(' ')[0], lines.at(-1));
  assert.deepEqual(readdirSync(dir), []);
});

test('the slot directory is one per user in every session and must not be writable by others', (t) => {
  const old = process.env.XDG_RUNTIME_DIR;
  t.after(() => { if (old === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = old; });
  delete process.env.XDG_RUNTIME_DIR;
  assert.equal(slotDir(), `/tmp/prloop-slots-${process.getuid()}`);
  process.env.XDG_RUNTIME_DIR = '/run/user/example'; // an interactive session shares the pool of cron or sudo
  assert.equal(slotDir(), `/tmp/prloop-slots-${process.getuid()}`);
  const dir = mkdtempSync(join(tmpdir(), 'prloop-slots-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('chmod', ['0777', dir]);
  assert.throws(() => acquireSlot(dir, 1), /writable only by you/);
});

test('a gate that waited for a slot rechecks resources before it starts', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'prloop-slots-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const busy = join(dir, `slot-0.${process.pid}.900`);
  writeFileSync(busy, '');
  const x = idle();
  const c = { ...cfg, interval: 1000, resourceWait: 60 * 60e3, gateSlots: 1 };
  const pause = async (ms) => {
    x.clock.t += ms;
    if (x.clock.t === 5000) { rmSync(busy); x.m.load = 7; } // the slot frees up just as the machine gets busy
    if (x.clock.t >= 20e3) x.m.load = 1;
  };
  const r = await runGate('echo ran', dir, c, { ...x, pause, dir, log: (e) => { x.events.push(e); } });
  const ranAt = x.clock.t;
  assert.equal(r.stdout.trim(), 'ran');
  assert.ok(ranAt >= 20e3, `started at ${ranAt}`);
  assert.deepEqual(x.events.map((e) => e.event), ['waiting_for_gate_slot', 'waiting_for_resources']);
});

test('admission waits while load or memory is short, logs once, then proceeds', async () => {
  const x = idle({ load: 7 }); // above 0.75 x 8 cores
  const c = { ...cfg, interval: 1000, resourceWait: 60e3 };
  const p = admit(c, { ...x, pause: async (ms) => { x.clock.t += ms; if (x.clock.t >= 5000) x.m.load = 2; } });
  assert.equal(await p, 'ok');
  assert.equal(x.clock.t, 5000);
  assert.deepEqual(x.events.map((e) => [e.event, e.load, e.maxLoad]), [['waiting_for_resources', 7, 6]]);
  const w = {}; // memory below the larger of 4 GiB and 10% of RAM
  assert.equal(admitStep(w, c, { ...x.m, freeMem: 3 * GiB }, 0, () => {}), 'wait');
  assert.equal(admitStep(w, { ...c, minFreeMem: 2 * GiB }, { ...x.m, freeMem: 3 * GiB }, 1, () => {}), 'ok');
});

test('admission never deadlocks: after --resource-wait the gate runs with one slot only', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'prloop-slots-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const x = idle({ freeMem: GiB });
  const c = { ...cfg, interval: 60e3, resourceWait: 30 * 60e3, gateSlots: 2 };
  writeFileSync(join(dir, `slot-1.${process.pid}.901`), ''); // slot 1 busy: the starved gate still takes slot 0
  const r = await runGate('echo ran', dir, c, { ...x, dir });
  assert.equal(r.stdout.trim(), 'ran');
  assert.equal(x.clock.t, 30 * 60e3);
  assert.deepEqual(x.events.map((e) => e.event), ['waiting_for_resources', 'resource_wait_expired']);
  assert.deepEqual(readdirSync(dir), [`slot-1.${process.pid}.901`]); // slot 0 was released
  // With slot 0 taken as well, the starved gate waits for it instead of using slot 1.
  writeFileSync(join(dir, `slot-0.${process.pid}.902`), '');
  rmSync(join(dir, `slot-1.${process.pid}.901`));
  const y = idle({ freeMem: GiB });
  const pause = async (ms) => { y.clock.t += ms; if (y.clock.t > c.resourceWait + 10e3) rmSync(join(dir, `slot-0.${process.pid}.902`), { force: true }); };
  await runGate('true', dir, c, { ...y, pause, dir });
  assert.deepEqual(y.events.map((e) => e.event), ['waiting_for_resources', 'resource_wait_expired', 'waiting_for_gate_slot']);
});

test('--gate-tmpdir gives each gate a private TMPDIR and removes it afterwards', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'prloop-gatetmp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const c = { ...cfg, gateTmpdir: join(dir, 'tmp') };
  const deps = { ...idle(), dir: join(dir, 'slots') };
  const ok = await runGate('echo "$TMPDIR"; touch "$TMPDIR/scratch"', dir, c, deps);
  assert.match(ok.stdout.trim(), new RegExp(`^${join(dir, 'tmp')}/prloop-gate-`));
  const failed = await runGate('touch "$TMPDIR/scratch"; exit 2', dir, c, deps);
  assert.equal(failed.status, 2);
  assert.deepEqual(readdirSync(join(dir, 'tmp')), []);
});

test('runGate keeps only a bounded tail of verbose gate output', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'prloop-gateout-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = await runGate(`head -c ${3 * OUTPUT_TAIL} /dev/zero | tr '\\0' x; echo; echo END; exit 3`, dir, cfg, { ...idle(), dir });
  assert.equal(r.status, 3);
  assert.equal(r.stdout.length, OUTPUT_TAIL);
  assert.match(r.stdout, /x\nEND\n$/);
});

test('machine options: defaults, validation, and the status line', (t) => {
  const d = config({}, {});
  assert.deepEqual(pick(d, ['gateSlots', 'maxLoad', 'minFreeMem', 'resourceWait', 'gateTmpdir']),
    { gateSlots: 2, maxLoad: undefined, minFreeMem: undefined, resourceWait: 30 * 60e3, gateTmpdir: undefined });
  const e = config({}, { PRLOOP_GATE_SLOTS: '3', PRLOOP_MAX_LOAD: '4.5', PRLOOP_MIN_FREE_MEM: '512M', PRLOOP_RESOURCE_WAIT: '5m' });
  assert.deepEqual(pick(e, ['gateSlots', 'maxLoad', 'minFreeMem', 'resourceWait']), { gateSlots: 3, maxLoad: 4.5, minFreeMem: 512 * 2 ** 20, resourceWait: 5 * 60e3 });
  assert.equal(parseSize('4GiB'), 4 * GiB);
  assert.equal(parseSize('1000'), 1000);
  for (const [k, v] of [['gateSlots', '0'], ['maxLoad', '-1'], ['maxLoad', 'high'], ['maxLoad', '9'.repeat(400)], ['minFreeMem', '4X'], ['minFreeMem', '0'], ['resourceWait', '0']]) {
    assert.throws(() => config({ [k]: v }, {}), /must be a positive/, `${k}=${v}`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'prloop-slots-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, `slot-0.${process.pid}.0`), '');
  writeFileSync(join(dir, `slot-1.${deadPid()}.0`), '');
  assert.equal(machineLine(d, { metrics: idle({ load: 2.5 }).metrics, dir }),
    'load 2.50 (max 6.00, 8 cores), free memory 16.0 GiB (min 4.0 GiB), gate slots 1/2 in use');
});

test('self-check warns about a dirty, off-branch or behind prloop checkout, and skips outside Git', (t) => {
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  assert.match(selfCheck(r.work).warning, /is on feat, not main: update it with `git -C .* pull --ff-only`/);
  r.run(r.work, 'switch', '-q', 'main');
  assert.equal(selfCheck(r.work), null);
  const index = join(r.work, '.git', 'index'), before = readFileSync(index);
  utimesSync(join(r.work, 'app.txt'), new Date(), new Date(Date.now() + 60e3)); // stale stat info: plain status would rewrite the index
  assert.equal(selfCheck(r.work), null);
  assert.deepEqual(readFileSync(index), before);
  writeFileSync(join(r.work, 'stray.txt'), 'local\n');
  assert.match(selfCheck(r.work).warning, /has uncommitted changes/);
  rmSync(join(r.work, 'stray.txt'));
  const other = join(r.dir, 'other');
  r.run(r.dir, 'clone', '-q', join(r.dir, 'remote.git'), other);
  writeFileSync(join(other, 'app.txt'), 'two\n');
  r.run(other, 'commit', '-qam', 'newer');
  r.run(other, 'push', '-q', 'origin', 'main');
  assert.match(selfCheck(r.work).warning, /is behind origin\/main/);
  r.run(r.work, 'pull', '-q', '--ff-only');
  assert.equal(selfCheck(r.work), null);
  rmSync(join(r.dir, 'remote.git'), { recursive: true, force: true }); // fetch fails: note, no warning
  assert.deepEqual(Object.keys(selfCheck(r.work)), ['note']);
  const plainDir = mkdtempSync(join(tmpdir(), 'prloop-nogit-'));
  t.after(() => rmSync(plainDir, { recursive: true, force: true }));
  assert.equal(selfCheck(plainDir), null);
});

test('agent result: the last JSON line, also inside a JSON wrapper', () => {
  const line = '{"status":"requested","head":"abc","fixed":["T1"],"disputed":[],"reason":"fixed"}';
  assert.equal(parseAgentResult(`work done\n${line}`).status, 'requested');
  assert.deepEqual(parseAgentResult(JSON.stringify({ type: 'result', result: `Summary.\n${line}` })).fixed, ['T1']);
  assert.equal(parseAgentResult('{"status":"maybe"}'), null);
  assert.equal(parseAgentResult(''), null);
});

test('agent result: inside a json fence, pretty-printed or inline, and in the CLI wrapper result', () => {
  const fenced = 'Done.\n\n```json\n{\n  "status": "requested",\n  "head": "abc",\n  "fixed": ["T1"],\n  "disputed": []\n}\n```\nThanks.';
  assert.deepEqual(parseAgentResult(fenced).fixed, ['T1']);
  assert.equal(parseAgentResult(JSON.stringify({ type: 'result', subtype: 'success', result: fenced })).status, 'requested');
  assert.equal(parseAgentResult('Result: {"status":"nothing_to_do","head":"abc"} as asked.').status, 'nothing_to_do');
});

test('agent failure: the CLI wrapper names why the session ended without a result', () => {
  const w = (o) => JSON.stringify({ type: 'result', result: '', ...o });
  assert.equal(agentFailure(w({ subtype: 'error_max_turns', is_error: true })), 'the agent session ended at its max-turns limit');
  assert.equal(agentFailure(w({ subtype: 'error_during_execution', is_error: true })), 'the agent session ended with error_during_execution');
  assert.equal(agentFailure(w({ subtype: 'success', terminal_reason: 'completed', permission_denials: [
    { tool_name: 'Bash', tool_input: { command: 'git push origin feat' } }, { tool_name: 'Write', tool_input: { file_path: '/etc/x' } }] })),
  'permission denied for Bash (git push origin feat), Write (/etc/x)');
  assert.equal(agentFailure(w({ subtype: 'success', is_error: true, api_error_status: 529, result: 'Overloaded' })),
    'the agent session ended on an error: Overloaded; API error status 529');
  assert.equal(agentFailure(w({ subtype: 'success', terminal_reason: 'aborted' })), 'terminal reason aborted');
  // Nothing specific: the tail of the final message, so prose is visible in the reason.
  assert.equal(agentFailure(w({ subtype: 'success', terminal_reason: 'completed', result: `${'x'.repeat(400)}I fixed it.` })),
    `the agent output had no parseable result line; it ended: ${'x'.repeat(289)}I fixed it.`);
  assert.equal(agentFailure('plain text'), 'the agent output had no parseable result line; it ended: plain text');
});

test('agent logs keep raw output owner-only and prune logs older than 14 days', (t) => {
  const dir = tempState(t);
  const now = Date.parse('2026-02-01T00:00:00Z');
  const old = saveAgentLog('example-org/example-repo', 7, { status: 0, stdout: 'old', stderr: '', final: 'old' }, now - 15 * 864e5);
  execFileSync('touch', ['-d', '2026-01-10', old]);
  const recent = saveAgentLog('example-org/example-repo', 7, { status: 0, stdout: 'recent', stderr: '', final: 'recent' }, now - 864e5);
  execFileSync('touch', ['-d', '2026-01-31', recent]);
  pruneAgentLogs(now);
  assert.ok(existsSync(recent));
  const f = saveAgentLog('example-org/example-repo', 7, { status: 1, stdout: 'out', stderr: 'err', final: 'last' }, now);
  assert.equal(f, join(dir, 'agents', 'example-org__example-repo__7__2026-02-01T00-00-00-000Z.log'));
  assert.equal(readFileSync(f, 'utf8'), '# exit status 1\n## stdout\nout\n## stderr\nerr\n## final message\nlast\n');
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.ok(!existsSync(old));
});

test('the fix prompt carries only the trigger data and the contract', () => {
  const p = buildPrompt({ repo: 'example-org/example-repo', pr: 7, branch: 'feat/x', head: 'abc123', cwd: '/work/x', trigger: 'findings',
    findings: [{ id: 'T1', path: 'src/a.js', line: 3, body: '**<sub>![P1 Badge](https://img.shields.io/badge/P1-orange)</sub> P1 Off by one**\n\nUseful? React with a thumb.' }], gate: 'npm test', requestBody: '@codex review' });
  for (const part of ['PR #7 in example-org/example-repo', 'branch feat/x', 'head abc123', 'worktree /work/x', 'Trigger: findings',
    '- T1 src/a.js:3 P1 Off by one', 'runs the gate (npm test)', 'reusing exactly:\n@codex review', '"status":"requested|blocked|nothing_to_do"',
    'Never wait for or poll reviews', 'on its own last line, always, also when you stop early or are blocked',
    'report "blocked" with the denied command or missing tool named', 'never run the full project gate yourself',
    'in the foreground with a timeout of at least 90 minutes', 'Never background a command']) assert.ok(p.includes(part), part);
  assert.match(buildPrompt({ repo: 'o/n', pr: 1, trigger: 'local_review', findings: [], summaries: ['[local review] 1 finding(s) on x.\n- README.md [P3] Stale flag'] }),
    /Reviewer summary[\s\S]*README\.md \[P3\] Stale flag/);
  assert.match(buildPrompt({ repo: 'o/n', pr: 1, trigger: 'conflict', conflicts: ['a.txt'], localReview: true }), /Conflicted files: a\.txt[\s\S]*Do not post a review request/);
});

test('a passed gate is cached by exact clean head, repository and command: no second run, until one changes or --force-gate', async (t) => {
  tempState(t);
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  const runs = join(r.dir, 'runs');
  const count = () => (existsSync(runs) ? readFileSync(runs, 'utf8').split('\n').filter(Boolean).length : 0);
  const gate = `echo a >> "${runs}"`;
  const deps = { ...idle(), dir: join(r.dir, 'slots') };
  let head = r.run(r.work, 'rev-parse', 'HEAD');
  assert.deepEqual(await readyGate({ branch: 'feat', head }, { ...cfg, gate }, r.work, deps), { ok: true });
  assert.equal(count(), 1);
  unmarkTested(head, r.work);
  assert.deepEqual(await readyGate({ branch: 'feat', head }, { ...cfg, gate }, r.work, deps), { ok: true, cached: head }); // hit
  assert.equal(count(), 1);
  assert.equal(isTested(head, r.work), true);
  unmarkTested(head, r.work);
  await readyGate({ branch: 'feat', head }, { ...cfg, gate: `${gate}; true` }, r.work, deps); // another command misses
  assert.equal(count(), 2);
  assert.equal(isTested(head, r.work), true);
  await readyGate({ branch: 'feat', head }, { ...cfg, gate, forceGate: true }, r.work, deps); // runs on a tested head too
  assert.equal(count(), 3);
  assert.equal((await readyGate({ branch: 'feat', head }, { ...cfg, gate: 'false', forceGate: true }, r.work, deps)).ok, false);
  assert.equal(isTested(head, r.work), false); // a failed forced rerun withdraws the mark
  const flaky = `${gate}; test ! -e "${join(r.dir, 'fail')}"`; // one command that passes, then fails
  await readyGate({ branch: 'feat', head }, { ...cfg, gate: flaky }, r.work, deps);
  assert.equal(gatePassed(flaky, r.work), head);
  writeFileSync(join(r.dir, 'fail'), '');
  assert.equal((await readyGate({ branch: 'feat', head }, { ...cfg, gate: flaky, forceGate: true }, r.work, deps)).ok, false);
  assert.equal(gatePassed(flaky, r.work), null); // ...and its cached pass, so a plain ready reruns it
  assert.equal((await readyGate({ branch: 'feat', head }, { ...cfg, gate: flaky }, r.work, deps)).ok, false);
  assert.equal(count(), 6);
  writeFileSync(join(r.work, 'scratch.txt'), 'x\n');
  assert.equal(gatePassed(gate, r.work), null); // a dirty tree never hits
  rmSync(join(r.work, 'scratch.txt'));
  assert.equal(gatePassed(gate, r.work), head);
  const twin = gitRepo(); // another repository whose HEAD tree is identical
  t.after(() => rmSync(twin.dir, { recursive: true, force: true }));
  assert.equal(twin.run(twin.work, 'rev-parse', 'HEAD^{tree}'), r.run(r.work, 'rev-parse', 'HEAD^{tree}'));
  assert.equal(gatePassed(gate, twin.work), null);
  r.run(r.work, 'commit', '-q', '--allow-empty', '-m', 'metadata only'); // same tree, new head
  assert.equal(gatePassed(gate, r.work), null);
  r.commit('change', { 'app.txt': 'changed\n' });
  head = r.run(r.work, 'rev-parse', 'HEAD');
  assert.equal(gatePassed(gate, r.work), null); // the head changed
  await readyGate({ branch: 'feat', head }, { ...cfg, gate }, r.work, deps);
  assert.equal(count(), 7);
  // A gate the caller ran itself is recorded by mark-tested --gate, so ready does not rerun it.
  const other = 'npm test';
  const res = spawnSync(process.execPath, [PRLOOP, 'mark-tested', '--gate', other], { cwd: r.work, encoding: 'utf8', env: { ...process.env, PRLOOP_LOCK_TOKEN: '' } });
  assert.equal(JSON.parse(res.stdout).gatePassedHead, head, res.stderr);
  assert.equal(gatePassed(other, r.work), head);
});

test('a head tested by gate A is not tested for gate B: ready --gate B runs B', async (t) => {
  tempState(t);
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  const runs = join(r.dir, 'runs');
  const s = { branch: 'feat', head: r.run(r.work, 'rev-parse', 'HEAD') };
  const deps = { ...idle(), dir: join(r.dir, 'slots') };
  const a = `echo A >> "${runs}"`, b = `echo B >> "${runs}"`;
  assert.deepEqual(await readyGate(s, { ...cfg, gate: a }, r.work, deps), { ok: true });
  assert.deepEqual(localGate(s, r.work, a), []);
  assert.match(localGate(s, r.work, b).join(), /not marked tested.*then `prloop mark-tested --gate "<cmd>"`/); // A's marker is no evidence for B
  assert.deepEqual(await readyGate(s, { ...cfg, gate: b }, r.work, deps), { ok: true });
  assert.equal(readFileSync(runs, 'utf8'), 'A\nB\n');
  assert.deepEqual(localGate(s, r.work, b), []);
  assert.equal((await readyGate(s, { ...cfg, gate: 'false' }, r.work, deps)).ok, false); // a failing gate C is never skipped
});

test('concurrent ready runs for the same head and gate run the gate once', async (t) => {
  const state = tempState(t);
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  const runs = join(r.dir, 'runs');
  const s = { branch: 'feat', head: r.run(r.work, 'rev-parse', 'HEAD') };
  const deps = { ...idle(), dir: join(r.dir, 'slots'), pause: () => new Promise((res) => setImmediate(res)) };
  const c = { ...cfg, gate: `echo run >> "${runs}"` };
  const results = await Promise.all([readyGate(s, c, r.work, deps), readyGate(s, c, r.work, deps), readyGate(s, c, r.work, deps)]);
  assert.equal(readFileSync(runs, 'utf8'), 'run\n');
  assert.deepEqual(results, [{ ok: true }, { ok: true, cached: s.head }, { ok: true, cached: s.head }]);
  assert.deepEqual(readdirSync(join(state, 'gate-locks')), []); // the per-key lock is removed when free
});

test('the per-key gate lock records the gate shell, so it outlives a killed ready', async (t) => {
  const state = tempState(t);
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  const out = join(r.dir, 'claim');
  const s = { branch: 'feat', head: r.run(r.work, 'rev-parse', 'HEAD') };
  const c = { ...cfg, gate: `sleep 0.3; cat "${state}"/gate-locks/*/* > "${out}"; { echo; echo $$; } >> "${out}"` };
  assert.deepEqual(await readyGate(s, c, r.work, { ...idle(), dir: join(r.dir, 'slots') }), { ok: true });
  const lines = readFileSync(out, 'utf8').trim().split('\n');
  assert.equal(lines.at(-2).split(' ')[0], lines.at(-1)); // the claim lists the gate shell's pid
});

test('sync linearizes a branch with merge commits on a rebase-only repository and reports the tree', (t) => {
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  r.commit('feature', { 'app.txt': 'feature\n' });
  divergeOnMain(r, { 'log.csv': 'id\na\nbase\n' });
  r.run(r.work, 'merge', '-q', '--no-edit', 'main'); // contains the base, but through a merge commit
  r.run(r.work, 'push', '-q', 'origin', 'feat');
  const head = r.run(r.work, 'rev-parse', 'HEAD');
  assert.equal(syncBranch({ cwd: r.work, branch: 'feat', base: 'main', head, settings: { merge: true } }).verdict, 'up_to_date');
  const v = syncBranch({ cwd: r.work, branch: 'feat', base: 'main', head, settings: { merge: false, squash: false } });
  assert.deepEqual(pick(v, ['verdict', 'method', 'linearized', 'treeUnchanged', 'unchanged']),
    { verdict: 'synced', method: 'rebase', linearized: true, treeUnchanged: true, unchanged: true });
  assert.equal(r.run(r.work, 'rev-list', '--merges', 'origin/main..origin/feat'), '');
  assert.equal(r.run(r.work, 'rev-parse', 'origin/feat'), v.head);
  assert.equal(syncBranch({ cwd: r.work, branch: 'feat', base: 'main', head: v.head, settings: { merge: false, squash: false } }).verdict, 'up_to_date');
});

test('sync linearizes a branch with merge commits when the new base conflicts only in a union file', (t) => {
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  r.commit('feature', { 'log.csv': 'id\na\nfeature\n' });
  divergeOnMain(r, { 'app.txt': 'two\n' });
  r.run(r.work, 'merge', '-q', '--no-edit', 'main');
  r.run(r.work, 'push', '-q', 'origin', 'feat');
  divergeOnMain(r, { 'log.csv': 'id\na\nbase\n' }); // conflicts with the feature only in the union file
  const head = r.run(r.work, 'rev-parse', 'HEAD');
  const v = syncBranch({ cwd: r.work, branch: 'feat', base: 'main', head, settings: { merge: false, squash: false }, union: ['*.csv'] });
  assert.equal(v.verdict, 'synced', JSON.stringify(v));
  assert.equal(v.linearized, true);
  assert.equal(readFileSync(join(r.work, 'log.csv'), 'utf8'), 'id\na\nbase\nfeature\n');
  assert.equal(r.run(r.work, 'rev-list', '--merges', 'origin/main..origin/feat'), '');
});

test('sync refuses to linearize when a merge commit adds lines to a union file that later conflicts', (t) => {
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  r.commit('feature', { 'log.csv': 'id\na\nfeature\n' });
  divergeOnMain(r, { 'app.txt': 'two\n' });
  r.run(r.work, 'merge', '-q', '--no-commit', 'main');
  writeFileSync(join(r.work, 'log.csv'), 'id\na\nfeature\nmergeonly\n'); // a line that exists only in the merge commit
  r.run(r.work, 'add', '.');
  r.run(r.work, 'commit', '-qm', 'merge main');
  r.run(r.work, 'push', '-q', 'origin', 'feat');
  divergeOnMain(r, { 'log.csv': 'id\na\nbase\n' });
  const head = r.run(r.work, 'rev-parse', 'HEAD');
  const v = syncBranch({ cwd: r.work, branch: 'feat', base: 'main', head, settings: { merge: false, squash: false }, union: ['*.csv'] });
  assert.equal(v.verdict, 'error', JSON.stringify(v));
  assert.match(v.error, /drop changes made in merge commits/);
  assert.deepEqual([r.run(r.work, 'rev-parse', 'HEAD'), r.run(r.work, 'rev-parse', 'origin/feat')], [head, head]);
});

test('sync refuses to linearize when a merge commit changes the mode of a union file that later conflicts', (t) => {
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  r.commit('feature', { 'log.csv': 'id\na\nfeature\n' });
  divergeOnMain(r, { 'app.txt': 'two\n' });
  r.run(r.work, 'merge', '-q', '--no-commit', 'main');
  chmodSync(join(r.work, 'log.csv'), 0o755); // a mode change that exists only in the merge commit
  r.run(r.work, 'add', '.');
  r.run(r.work, 'commit', '-qm', 'merge main');
  r.run(r.work, 'push', '-q', 'origin', 'feat');
  divergeOnMain(r, { 'log.csv': 'id\na\nbase\n' });
  const head = r.run(r.work, 'rev-parse', 'HEAD');
  const v = syncBranch({ cwd: r.work, branch: 'feat', base: 'main', head, settings: { merge: false, squash: false }, union: ['*.csv'] });
  assert.equal(v.verdict, 'error', JSON.stringify(v));
  assert.match(v.error, /drop changes made in merge commits/);
  assert.deepEqual([r.run(r.work, 'rev-parse', 'HEAD'), r.run(r.work, 'rev-parse', 'origin/feat')], [head, head]);
});

test('sync refuses to linearize when a merge commit carries its own edits', (t) => {
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  r.commit('feature', { 'app.txt': 'feature\n' });
  divergeOnMain(r, { 'log.csv': 'id\na\nbase\n' });
  r.run(r.work, 'merge', '-q', '--no-commit', 'main');
  writeFileSync(join(r.work, 'merge-only.txt'), 'x\n'); // an edit that exists only in the merge commit
  r.run(r.work, 'add', '.');
  r.run(r.work, 'commit', '-qm', 'merge main');
  r.run(r.work, 'push', '-q', 'origin', 'feat');
  const head = r.run(r.work, 'rev-parse', 'HEAD');
  const v = syncBranch({ cwd: r.work, branch: 'feat', base: 'main', head, settings: { merge: false, squash: false } });
  assert.equal(v.verdict, 'error', JSON.stringify(v));
  assert.match(v.error, /drop changes made in merge commits/);
  assert.deepEqual([r.run(r.work, 'rev-parse', 'HEAD'), r.run(r.work, 'rev-parse', 'origin/feat')], [head, head]);
  assert.equal(r.run(r.work, 'status', '--porcelain'), '');
});

test('status and a local review count only the configured gate\'s pass as tested', async (t) => {
  tempState(t);
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  r.run(r.work, 'push', '-q', 'origin', 'feat');
  const head = r.run(r.work, 'rev-parse', 'HEAD');
  markTested(head, r.work); // a generic marker, not a pass of the configured gate
  const s = { pr: 7, branch: 'feat', head, base: 'main', unresolvedThreads: [] };
  const v = await localReview('example-org/example-repo', s, { ...cfg, gate: 'npm test' }, r.work);
  assert.equal(v.verdict, 'not_requested');
  assert.match(v.missing.join(), /not marked tested/);
});

test('validation state edits are serialized: a writer waits for a live lock and takes over a dead one', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'prloop-edit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = join(dir, 'prloop-tested'), lock = `${f}.lock.d`;
  writeFileSync(f, 'X\n');
  const holder = spawn('sleep', ['30']);
  t.after(() => holder.kill());
  mkdirSync(lock, { mode: 0o700 });
  writeFileSync(join(lock, `slot-0.${holder.pid}.0`), procStart(holder.pid) ?? ''); // another ready process is mid-update
  const writer = (v) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e',
      `import { editLines } from ${JSON.stringify(new URL('../prloop.mjs', import.meta.url).href)}; editLines(${JSON.stringify(f)}, (l) => [...l, '${v}']);`]);
    return new Promise((r) => c.on('exit', r));
  };
  const done = [1, 2, 3, 4, 5, 6].map((i) => writer(`Y${i}`));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(readFileSync(f, 'utf8'), 'X\n'); // no read-modify-write while the lock is held
  writeFileSync(f, ''); // the holder withdraws X, then dies without removing its lock
  holder.kill();
  assert.deepEqual(await Promise.all(done), [0, 0, 0, 0, 0, 0]);
  // Writers racing to take over the dead lock never remove each other's live claim, so no update is lost,
  // and each read happened after the holder's update, so X stays withdrawn.
  assert.deepEqual(readFileSync(f, 'utf8').split('\n').filter(Boolean).sort(), ['Y1', 'Y2', 'Y3', 'Y4', 'Y5', 'Y6']);
  assert.deepEqual(readdirSync(lock), []);
});

// Points the state directory at a temporary one for the duration of a test.
function tempState(t) {
  const dir = mkdtempSync(join(tmpdir(), 'prloop-state-'));
  const old = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = dir;
  t.after(() => { rmSync(dir, { recursive: true, force: true }); if (old === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = old; });
  mkdirSync(join(dir, 'prloop'));
  return join(dir, 'prloop');
}

test('run --status shows each PR\'s last events from its run log, also legacy lines without a repo', (t) => {
  const dir = tempState(t);
  const log = join(dir, 'run-2026-01-01T10-00-00-000Z.jsonl');
  writeFileSync(join(dir, 'example-org__example-repo__7.json'), JSON.stringify({ repo: 'example-org/example-repo', pr: 7, phase: 'waiting', head: 'abcdef1234', rounds: 2, log }));
  writeFileSync(join(dir, 'heads.json'), '{}'); // metadata, not a PR
  const lines = [{ pr: 7, phase: 'agent' }, { pr: 8, phase: 'agent' }, ...Array.from({ length: 6 }, (_, i) => ({ pr: 7, phase: `p${i}` }))];
  writeFileSync(log, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`); // written before events carried a repo
  writeFileSync(join(dir, 'run-2026-01-02T10-00-00-000Z.jsonl'), '{"repo":"example-org/other-repo","pr":7,"phase":"blocked"}\n');
  const st = runStatus('example-org/example-repo');
  assert.deepEqual(st.prs.map((p) => [p.pr, p.phase, p.head, p.rounds]), [[7, 'waiting', 'abcdef1', 2]]);
  assert.deepEqual(st.prs[0].events.map((e) => e.phase), ['p1', 'p2', 'p3', 'p4', 'p5']); // not PR 8, not the other repo
});

test('run --status ignores repo-less lines in logs the state does not name', (t) => {
  const dir = tempState(t);
  writeFileSync(join(dir, 'example-org__example-repo__7.json'), JSON.stringify({ repo: 'example-org/example-repo', pr: 7, phase: 'waiting' })); // legacy: no log
  writeFileSync(join(dir, 'run-2026-01-02T10-00-00-000Z.jsonl'), '{"pr":7,"phase":"other"}\n'); // could be any repo's PR 7
  writeFileSync(join(dir, 'run-2026-01-01T10-00-00-000Z.jsonl'), '{"repo":"example-org/example-repo","pr":7,"phase":"mine"}\n');
  assert.deepEqual(runStatus('example-org/example-repo').prs[0].events.map((e) => e.phase), ['mine']);
});

test('reset-rounds resets the counter once, logs it, and refuses a second reset', (t) => {
  const dir = tempState(t);
  writeFileSync(join(dir, 'example-org__example-repo__7.json'), JSON.stringify({ repo: 'example-org/example-repo', pr: 7, phase: 'blocked', rounds: 7, seen: { a: ['T1'] } }));
  assert.deepEqual(pick(resetRounds('example-org/example-repo', 7), ['previousRounds', 'rounds']), { previousRounds: 7, rounds: 0 });
  const [pr] = runStatus('example-org/example-repo').prs;
  assert.deepEqual([pr.rounds, pr.roundResets, pr.events.at(-1).phase], [0, 1, 'rounds_reset']);
  assert.throws(() => resetRounds('example-org/example-repo', 7), /already reset once/);
});

test('configuration errors are JSON errors, and an unknown --agent is rejected', async (t) => {
  assert.throws(() => config({ agent: 'nonee' }, {}), /--agent must be claude, codex or none/);
  assert.throws(() => config({}, { PRLOOP_AGENT: 'Claude' }), /--agent must be/);
  assert.throws(() => config({ maxLocalReviews: 'three' }, {}), /--max-local-reviews must be/);
  assert.throws(() => config({ maxRounds: '9'.repeat(400) }, {}), /--max-rounds must be a positive integer/); // Infinity
  assert.throws(() => config({}, { PRLOOP_MAX_LOCAL_REVIEWS: '-1' }), /--max-local-reviews must be/);
  assert.equal(config({ maxLocalReviews: '0' }, {}).maxLocal, 0);
  for (const [k, v] of [['maxRounds', 'eight'], ['maxRounds', 'Infinity'], ['maxRounds', '0'], ['maxAgents', '0'], ['maxAgents', '1.5'],
    ['deadline', '0'], ['deadline', 'soon'], ['interval', '0s'], ['timeout', '-5m'], ['ackTimeout', 'NaN']]) {
    assert.throws(() => config({ [k]: v }, {}), /must be a positive/, `${k}=${v}`);
  }
  assert.deepEqual(pick(config({}, {}), ['maxRounds', 'maxAgents', 'deadline']), { maxRounds: 6, maxAgents: 2, deadline: 6 * 36e5 });
  const logs = [];
  t.mock.method(console, 'log', (l) => logs.push(JSON.parse(l)));
  assert.equal(await main(['status', '7', '--repo', 'example-org/example-repo', '--timeout', 'bad']), EXIT.error);
  assert.equal(await main(['run', '--repo', 'example-org/example-repo', '--pr', '7', '--agent', 'nonee']), EXIT.error);
  assert.equal(await main(['run', '--repo', 'example-org/example-repo', '--pr', '7', '--max-rounds', 'x']), EXIT.error);
  assert.deepEqual(logs.map((l) => l.verdict), ['error', 'error', 'error']);
  assert.match(logs[1].error, /--agent must be/);
});

test('plain strips badges, markup and the reviewer footer', () => {
  assert.equal(plain('**<sub>![P2 Badge](https://example.invalid/b.svg)</sub>  Fix `x`**\n\nDetails here.\n\nAGENTS.md reference: [x](y)\n\nUseful? React'), 'Fix x Details here.');
  assert.equal(plain('Review.\n\n<details> <summary>About</summary>\ntruncated befo'), 'Review.');
  assert.equal(plain('### Review\n\nSuggestions below.\n\n<details> <summary>About</summary>\nboilerplate\n</details>\n'), 'Review Suggestions below.');
});

test('sync pushes a fork branch to its own remote, not to origin', (t) => {
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  const fork = join(r.dir, 'fork.git');
  r.run(r.dir, 'init', '-q', '--bare', fork);
  r.run(r.work, 'remote', 'add', 'fork', fork);
  r.commit('feature', { 'app.txt': 'feature\n' });
  r.run(r.work, 'push', '-q', '-u', 'fork', 'feat');
  divergeOnMain(r, { 'log.csv': 'id\na\nbase\n' });
  const head = r.run(r.work, 'rev-parse', 'HEAD');
  const v = syncBranch({ cwd: r.work, branch: 'feat', base: 'main', head, settings: { merge: true } });
  assert.equal(v.verdict, 'synced', JSON.stringify(v));
  assert.equal(r.run(fork, 'rev-parse', 'feat'), v.head);
  assert.equal(r.run(r.work, 'ls-remote', 'origin', 'feat'), '');
});

test('a SHA that returns as the head gets a fresh observation time', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'prloop-state-'));
  const old = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = dir;
  t.after(() => { rmSync(dir, { recursive: true, force: true }); if (old === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = old; });
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const first = headSeenAt('o/n#7', 'S');
  await tick();
  assert.equal(headSeenAt('o/n#7', 'S'), first); // unchanged head keeps its time
  headSeenAt('o/n#7', 'X');
  await tick();
  assert.ok(headSeenAt('o/n#7', 'S') > first); // rewound and fast-forwarded back
});

test('sync compares and merges against the fetched base, not a stale reported base commit', (t) => {
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  r.commit('feature', { 'app.txt': 'feature\n' });
  r.run(r.work, 'push', '-q', 'origin', 'feat');
  divergeOnMain(r, { 'log.csv': 'id\na\nbase\n' });
  const baseOid = r.run(r.work, 'rev-parse', 'main'); // what GitHub still reports
  divergeOnMain(r, { 'extra.txt': 'newer base\n' });
  const head = r.run(r.work, 'rev-parse', 'HEAD');
  const v = syncBranch({ cwd: r.work, branch: 'feat', base: 'main', baseOid, head, settings: { merge: true } });
  assert.equal(v.verdict, 'synced', JSON.stringify(v));
  assert.equal(r.run(r.work, 'cat-file', '-p', 'HEAD:extra.txt'), 'newer base');
});

test('sync reports a conflict with the fetched base even when the branch contains the reported base, naming generated files', (t) => {
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  r.commit('feature', { 'gen.txt': 'feature build\n', 'app.txt': 'feature\n' }); // only the base marks gen.txt generated
  r.run(r.work, 'push', '-q', 'origin', 'feat');
  const baseOid = r.run(r.work, 'rev-parse', 'main'); // the branch already contains it: up to date by GitHub's stale view
  divergeOnMain(r, { '.gitattributes': 'gen.txt linguist-generated\n', 'gen.txt': 'base build\n', 'app.txt': 'base\n' });
  const head = r.run(r.work, 'rev-parse', 'HEAD');
  const v = syncBranch({ cwd: r.work, branch: 'feat', base: 'main', baseOid, head, settings: { merge: true } });
  assert.equal(v.verdict, 'conflict', JSON.stringify(v));
  assert.deepEqual(v.conflicts.sort(), ['app.txt', 'gen.txt']);
  assert.deepEqual(v.generated, ['gen.txt']);
  assert.match(v.next, /regenerate gen\.txt/);
  assert.match(buildPrompt({ trigger: 'conflict', conflicts: v.conflicts, generated: v.generated, pr: 7, repo: 'o/r', gate: 'make test' }), /Generated files among them .*: gen\.txt/);
});

test('the local review diffs from the reported base commit', () => {
  assert.match(localReviewPrompt({ pr: 7, base: 'main', baseOid: 'b0b0', head: 'abc' }, 'm3b4'), /git diff m3b4\.\.\.HEAD/);
  assert.match(localReviewPrompt({ pr: 7, base: 'main', baseOid: 'b0b0', head: 'abc' }), /git diff origin\/main\.\.\.HEAD/);
});

test('worktree check: branch and PR head commit must match', (t) => {
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  const head = r.run(r.work, 'rev-parse', 'HEAD');
  assert.equal(checkWorktree(r.work, { branch: 'feat', head }), null);
  assert.match(checkWorktree(r.work, { branch: 'other', head }), /does not have other checked out/);
  assert.match(checkWorktree(r.work, { branch: 'feat', head: 'f'.repeat(40) }), /HEAD is not PR head/);
  r.commit('local only', { 'app.txt': 'two\n' }); // PR head still present, but HEAD is ahead of it
  assert.match(checkWorktree(r.work, { branch: 'feat', head }), /HEAD is not PR head/);
  const now = r.run(r.work, 'rev-parse', 'HEAD');
  writeFileSync(join(r.work, 'stray.txt'), 'local\n'); // untracked work a fix agent must not commit
  assert.match(checkWorktree(r.work, { branch: 'feat', head: now }), /uncommitted changes/);
});

test('run blocks after three GitHub read failures on fresh state', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'prloop-run-'));
  const old = { XDG_STATE_HOME: process.env.XDG_STATE_HOME, PATH: process.env.PATH };
  t.after(() => { rmSync(dir, { recursive: true, force: true }); for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'gh'), '#!/bin/sh\necho "{}"\n', { mode: 0o755 }); // malformed reply, no retry backoff
  process.env.XDG_STATE_HOME = dir;
  process.env.PATH = `${join(dir, 'bin')}:${old.PATH}`;
  const [r] = await runAll({ repo: 'example-org/example-repo', pr: '7', deadline: '20s' }, { ...cfg, interval: 1 });
  assert.equal(r.verdict, 'blocked');
  assert.match(r.reason, /GitHub read failed/);
});

test('value options need a value; only --help and --status are flags', () => {
  assert.throws(() => parseArgs(['ready', '5', '--gate']), /--gate needs a value/);
  assert.throws(() => parseArgs(['ready', '5', '--gate', '--repo', 'o/r']), /--gate needs a value/);
  assert.deepEqual(parseArgs(['run', '--status', '--repo', 'o/r', '--gate=make check']), { _: ['run'], union: [], status: true, repo: 'o/r', gate: 'make check' });
});

test('--agent none never runs a local reviewer', async () => {
  const v = await localReview('example-org/example-repo', { pr: 7, head: 'abc', unresolvedThreads: [] }, config({ agent: 'none' }, {}), '/nonexistent');
  assert.equal(v.verdict, 'blocked');
  assert.match(v.reason, /--agent none/);
});

test('sync clears only the old head marker, not other PR heads', (t) => {
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  const other = r.run(r.work, 'rev-parse', 'HEAD');
  markTested(other, r.work); // another PR's head in the same repository
  r.commit('feature', { 'app.txt': 'feature\n' });
  r.run(r.work, 'push', '-q', 'origin', 'feat');
  const head = r.run(r.work, 'rev-parse', 'HEAD');
  markTested(head, r.work);
  divergeOnMain(r, { 'log.csv': 'id\na\nbase\n' });
  const v = syncBranch({ cwd: r.work, branch: 'feat', base: 'main', head, settings: { merge: true } });
  assert.equal(v.verdict, 'synced', JSON.stringify(v));
  assert.equal(isTested(head, r.work), false);
  assert.equal(isTested(other, r.work), true);
});

test('a dismissed bot review is neither a clean nor a findings signal', () => {
  const pr = fixture();
  pr.reviews.nodes.push({ id: 'R1', body: "Didn't find any major issues.", state: 'DISMISSED', submittedAt: at('10:20'), author: BOT, commit: { oid: pr.headRefOid } });
  assert.equal(classify(pr, cfg, NOW).verdict, 'pending');
  pr.reviews.nodes[0].state = 'COMMENTED';
  assert.equal(classify(pr, cfg, NOW).verdict, 'clean');
});

test('threads from a dismissed bot review are not findings', () => {
  const pr = fixture();
  const t = thread('T1', at('10:20'));
  t.comments.nodes[0].pullRequestReview = { state: 'DISMISSED' };
  pr.reviewThreads.nodes.push(t);
  const s = classify(pr, cfg, NOW);
  assert.equal(s.verdict, 'pending');
  assert.equal(s.unresolvedThreads.length, 0);
  t.comments.nodes[0].pullRequestReview.state = 'COMMENTED';
  assert.equal(classify(pr, cfg, NOW).verdict, 'findings');
});

test('a dismissed bot review thread with a human reply stays unresolved and blocks a clean verdict', () => {
  const pr = fixture();
  const t = thread('T1', at('10:20'));
  t.comments.nodes[0].pullRequestReview = { state: 'DISMISSED' };
  t.comments.nodes.push({ body: 'This still matters', createdAt: at('10:25'), author: { login: 'example-dev' } });
  pr.reviewThreads.nodes.push(t);
  request(pr).reactions.nodes.push({ content: 'THUMBS_UP', createdAt: at('10:30'), user: BOT });
  const s = classify(pr, cfg, NOW);
  assert.equal(s.unresolvedThreads.length, 1);
  assert.notEqual(s.verdict, 'clean');
  t.comments.nodes.pop();
  assert.equal(classify(pr, cfg, NOW).unresolvedThreads.length, 0);
  assert.equal(classify(pr, cfg, NOW).verdict, 'clean');
});

test('threads from a dismissed human review stay unresolved and block a clean verdict', () => {
  const pr = fixture();
  const t = thread('T1', at('10:20'), 'Please rename this', { login: 'example-dev' });
  t.comments.nodes[0].pullRequestReview = { state: 'DISMISSED' };
  pr.reviewThreads.nodes.push(t);
  request(pr).reactions.nodes.push({ content: 'THUMBS_UP', createdAt: at('10:30'), user: BOT });
  const s = classify(pr, cfg, NOW);
  assert.equal(s.unresolvedThreads.length, 1);
  assert.equal(s.verdict, 'findings');
});

// ---------- saving cloud reviews ----------

test('a carried clean verdict counts on the synced head only, and a real finding overrides it', () => {
  const pr = fixture();
  pr.comments.nodes.pop(); // no request on the synced head
  pr.carry = { from: '0'.repeat(40), to: pr.headRefOid, patchId: 'p' };
  const s = classify(pr, cfg, NOW);
  assert.equal(s.verdict, 'clean');
  assert.match(s.reasons.join(), /carried from 0000000/);
  assert.equal(classify({ ...pr, carry: { ...pr.carry, to: 'f'.repeat(40) } }, cfg, NOW).verdict, 'not_requested');
  pr.reviewThreads.nodes.push(thread('T1', at('10:20')));
  assert.equal(classify(pr, cfg, NOW).verdict, 'findings');
});

test('a new request on the synced head supersedes the carried clean verdict', () => {
  const pr = fixture(); // keeps the current request on the synced head
  pr.carry = { from: '0'.repeat(40), to: pr.headRefOid, patchId: 'p' };
  const s = classify(pr, cfg, NOW);
  assert.equal(s.verdict, 'pending');
  assert.equal(s.carry, null);
  request(pr).reactions.nodes.push({ content: 'THUMBS_UP', createdAt: at('10:20'), user: BOT });
  assert.equal(classify(pr, cfg, NOW).verdict, 'clean');
});

for (const settings of [{ merge: true, squash: true }, { merge: false, squash: false }]) {
  const method = settings.merge ? 'merge' : 'rebase';

  test(`sync (${method}) reports the PR's own change unchanged, including union-merged files`, (t) => {
    const r = gitRepo();
    t.after(() => rmSync(r.dir, { recursive: true, force: true }));
    r.commit('feature', { 'app.txt': 'feature\n', 'log.csv': 'id\na\nfeature\n' });
    r.run(r.work, 'push', '-q', 'origin', 'feat');
    divergeOnMain(r, { 'other.txt': 'base\n', 'log.csv': 'id\na\nbase\n' });
    const head = r.run(r.work, 'rev-parse', 'HEAD');
    const v = syncBranch({ cwd: r.work, branch: 'feat', base: 'main', head, settings, union: ['*.csv'] });
    assert.equal(v.verdict, 'synced', JSON.stringify(v));
    assert.deepEqual(v.unioned, ['log.csv']);
    assert.equal(v.unchanged, true);
    assert.equal(v.patchId, patchId(r.work, 'origin/main', head, ['log.csv']));
  });

  test(`sync (${method}) reports a changed patch-id when the base changes the PR's context`, (t) => {
    const r = gitRepo();
    t.after(() => rmSync(r.dir, { recursive: true, force: true }));
    const lines = (over) => `${Array.from({ length: 10 }, (_, i) => over[i] ?? `line ${i}`).join('\n')}\n`;
    divergeOnMain(r, { 'app.txt': lines({}) });
    r.run(r.work, 'merge', '-q', '--ff-only', 'main');
    r.commit('feature', { 'app.txt': lines({ 4: 'feature' }) });
    r.run(r.work, 'push', '-q', 'origin', 'feat');
    divergeOnMain(r, { 'app.txt': lines({ 6: 'base' }) }); // merges cleanly, but inside the PR hunk's context
    const head = r.run(r.work, 'rev-parse', 'HEAD');
    const v = syncBranch({ cwd: r.work, branch: 'feat', base: 'main', head, settings });
    assert.equal(v.verdict, 'synced', JSON.stringify(v));
    assert.equal(v.unchanged, false);
  });
}

test('a recorded carry-over lands in the state file and the event log', (t) => {
  const dir = tempState(t);
  const carry = recordCarry('example-org/example-repo', 7, 'a'.repeat(40), { head: 'b'.repeat(40), patchId: 'p1' });
  assert.deepEqual(pick(carry, ['from', 'to', 'patchId']), { from: 'a'.repeat(40), to: 'b'.repeat(40), patchId: 'p1' });
  const st = JSON.parse(readFileSync(join(dir, 'example-org__example-repo__7.json'), 'utf8'));
  assert.equal(st.carry.to, 'b'.repeat(40));
  const [pr] = runStatus('example-org/example-repo').prs;
  assert.deepEqual(pick(pr.events.at(-1), ['phase', 'from', 'to', 'patchId']), { phase: 'carried', from: 'aaaaaaa', to: 'bbbbbbb', patchId: 'p1' });
});

// A fake `gh` serving one PR snapshot from a file; `gh pr merge` marks it merged. Every call is logged.
function fakeGh(t, dir, pr) {
  const old = process.env.PATH;
  t.after(() => { process.env.PATH = old; });
  mkdirSync(join(dir, 'bin'));
  const reply = (p) => JSON.stringify({ data: { viewer: { login: 'example-dev' }, repository: { mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true, pullRequest: p } } });
  writeFileSync(join(dir, 'pr.json'), reply(pr));
  writeFileSync(join(dir, 'merged.json'), reply({ ...pr, state: 'MERGED', mergeCommit: { oid: 'c'.repeat(40) } }));
  writeFileSync(join(dir, 'bin', 'gh'), `#!/bin/sh
if [ "$1" = api ]; then echo "api $2"; else echo "$*"; fi >> "${dir}/calls.log"
case "$1 $2" in
  "pr merge") cp "${dir}/merged.json" "${dir}/pr.json" ;;
  *) cat "${dir}/pr.json" ;;
esac
`, { mode: 0o755 });
  process.env.PATH = `${join(dir, 'bin')}:${old}`;
  return () => readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n');
}

test('run syncs a behind but mergeable clean head and gates the combined state before merging', async (t) => {
  const state = tempState(t);
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  r.commit('feature', { 'app.txt': 'feature\n' });
  r.run(r.work, 'push', '-q', 'origin', 'feat');
  divergeOnMain(r, { 'other.txt': 'base\n' });
  const head = r.run(r.work, 'rev-parse', 'HEAD');
  markTested(head, r.work); // the gate ran on the branch head only, not on the newer base
  writeFileSync(join(state, 'heads.json'), JSON.stringify({ 'example-org/example-repo#7': { sha: head, at: at('09:00') } }));
  const pr = fixture();
  Object.assign(pr, { headRefName: 'feat', headRefOid: head, mergeStateStatus: 'BEHIND', mergeable: 'MERGEABLE' });
  request(pr).reactions.nodes.push({ content: 'THUMBS_UP', createdAt: at('10:20'), user: BOT });
  const calls = fakeGh(t, r.dir, pr);
  // The push hook records the worktree lock claims while the automatic sync runs.
  const lockDir = join(r.run(r.work, 'rev-parse', '--absolute-git-dir'), 'prloop-lock');
  writeFileSync(join(r.work, '.git', 'hooks', 'pre-push'), `#!/bin/sh\ncat "${lockDir}"/* > "${r.dir}/seen"\n`, { mode: 0o755 });
  const runP = runAll({ repo: 'example-org/example-repo', pr: '7', worktree: r.work, merge: 'squash', deadline: '1h' }, { ...cfg, agent: 'none', interval: 1 }, { metrics: idle().metrics });
  for (let i = 0; i < 200 && r.run(r.work, 'rev-parse', 'HEAD') === head; i++) await new Promise((d) => setTimeout(d, 5));
  const synced = r.run(r.work, 'rev-parse', 'HEAD');
  const after = { ...fixture(), headRefName: 'feat', headRefOid: synced, mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE' };
  after.comments.nodes.pop();
  writeFileSync(join(r.dir, 'pr.json'), JSON.stringify({ data: { viewer: { login: 'example-dev' }, repository: { mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true, pullRequest: after } } }));
  const [res] = await runP;
  assert.notEqual(synced, head);
  assert.match(readFileSync(join(r.dir, 'seen'), 'utf8'), /"purpose":"sync of PR #7"/); // locked while it pushed
  assert.equal(lockHolder(r.work, null), null); // and released afterwards
  assert.equal(res.verdict, 'not_tested', JSON.stringify(res)); // the synced head needs the gate first
  assert.equal(res.head, synced);
  assert.ok(calls().every((c) => c.startsWith('api graphql')), 'no merge of the ungated head and no review request');
});

test('run carries a clean verdict across a sync that leaves the PR unchanged', async (t) => {
  const state = tempState(t);
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  r.commit('feature', { 'app.txt': 'feature\n' });
  r.run(r.work, 'push', '-q', 'origin', 'feat');
  divergeOnMain(r, { 'other.txt': 'base\n' });
  const head = r.run(r.work, 'rev-parse', 'HEAD');
  writeFileSync(join(state, 'heads.json'), JSON.stringify({ 'example-org/example-repo#7': { sha: head, at: at('09:00') } }));
  const pr = fixture();
  Object.assign(pr, { headRefName: 'feat', headRefOid: head, mergeStateStatus: 'BEHIND', mergeable: 'CONFLICTING' }); // forces a sync
  request(pr).reactions.nodes.push({ content: 'THUMBS_UP', createdAt: at('10:20'), user: BOT });
  const calls = fakeGh(t, r.dir, pr);
  // After the sync GitHub reports the new head, with no review on it.
  const runP = runAll({ repo: 'example-org/example-repo', pr: '7', worktree: r.work, deadline: '1h' }, { ...cfg, interval: 1 }, { metrics: idle().metrics });
  for (let i = 0; i < 200 && r.run(r.work, 'rev-parse', 'HEAD') === head; i++) await new Promise((d) => setTimeout(d, 5));
  const synced = r.run(r.work, 'rev-parse', 'HEAD');
  const after = { ...fixture(), headRefName: 'feat', headRefOid: synced, mergeStateStatus: 'CLEAN' };
  after.comments.nodes.pop();
  writeFileSync(join(r.dir, 'pr.json'), JSON.stringify({ data: { viewer: { login: 'example-dev' }, repository: { mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true, pullRequest: after } } }));
  const [res] = await runP;
  assert.notEqual(synced, head);
  assert.equal(res.verdict, 'clean', JSON.stringify(res));
  assert.equal(res.head, synced);
  const st = JSON.parse(readFileSync(join(state, 'example-org__example-repo__7.json'), 'utf8'));
  assert.deepEqual([st.carry.from, st.carry.to], [head, synced]);
  assert.ok(calls().every((c) => c.startsWith('api graphql')), 'no review request or other write');
});

// A PR with one unresolved finding and a fake `claude` whose JSON wrapper reports error_max_turns and no result line.
// With `resolves`, the agent resolves the thread (real progress) before its session ends.
async function runNoResultAgent(t, resolves, { body, extra = {}, cmd = 'claude' } = {}) {
  const state = tempState(t);
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  r.run(r.work, 'push', '-q', 'origin', 'feat');
  const head = r.run(r.work, 'rev-parse', 'HEAD');
  writeFileSync(join(state, 'heads.json'), JSON.stringify({ 'example-org/example-repo#7': { sha: head, at: at('09:00') } }));
  const pr = fixture();
  Object.assign(pr, { headRefName: 'feat', headRefOid: head, mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE' });
  pr.reviewThreads.nodes.push(thread('T1', at('10:20')));
  fakeGh(t, r.dir, pr);
  const done = { ...pr, reviewThreads: { ...pr.reviewThreads, nodes: [{ ...thread('T1', at('10:20')), isResolved: true }] } };
  request(done).reactions.nodes.push({ content: 'THUMBS_UP', createdAt: at('10:30'), user: BOT });
  const reply = JSON.stringify({ data: { viewer: { login: 'example-dev' }, repository: { mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true, pullRequest: done } } });
  writeFileSync(join(r.dir, 'done.json'), reply);
  writeFileSync(join(r.dir, 'bin', cmd), `#!/bin/sh
echo "$PRLOOP_LOCK_TOKEN" > "${r.dir}/token"
echo "$BASH_DEFAULT_TIMEOUT_MS $BASH_MAX_TIMEOUT_MS" > "${r.dir}/bash-timeouts"
${resolves ? `cp "${r.dir}/done.json" "${r.dir}/pr.json"` : ''}
${body ?? `echo '{"type":"result","subtype":"error_max_turns","is_error":true,"result":"Ran out of turns."}'`}
`, { mode: 0o755 });
  const [res] = await runAll({ repo: 'example-org/example-repo', pr: '7', worktree: r.work, deadline: '1h' }, { ...cfg, interval: 1, ...extra }, { metrics: idle().metrics });
  return { res, r };
}

test('run blocks with the session error and keeps the agent log when an agent ends without a result line', async (t) => {
  const { res, r } = await runNoResultAgent(t, false);
  assert.equal(res.verdict, 'blocked', JSON.stringify(res));
  assert.match(readFileSync(join(r.dir, 'token'), 'utf8'), /^[0-9a-f-]{36}\n$/); // the agent inherited the lock token
  assert.equal(lockHolder(r.work, null), null); // and the lock was released when it ended
  assert.equal(res.reason, 'the agent session ended at its max-turns limit');
  assert.equal(readFileSync(join(r.dir, 'bash-timeouts'), 'utf8'), `${cfg.agentTimeout} ${cfg.agentTimeout}\n`); // foreground commands get the agent budget
  assert.match(readFileSync(res.agentLog, 'utf8'), /error_max_turns/);
  assert.ok(res.next.includes(res.agentLog));
});

test('agent usage: totals from a recorded claude wrapper, blank for output without usage', async (t) => {
  const wrapper = readFileSync(new URL('./claude-wrapper.json', import.meta.url), 'utf8');
  assert.deepEqual(agentUsage(wrapper), { turns: 14, costUsd: 0.4182, inputTokens: 159200, outputTokens: 3400 });
  assert.equal(agentUsage('codex final message without usage'), null);
  const st = {};
  addUsage(st, 'codex final message without usage');
  assert.deepEqual(st.usage, { agentRuns: 1, turns: null, costUsd: null, inputTokens: null, outputTokens: null });
  addUsage(st, wrapper);
  addUsage(st, wrapper);
  assert.deepEqual(st.usage, { agentRuns: 3, turns: 28, costUsd: 0.8364, inputTokens: 318400, outputTokens: 6800 });
  // A run records the agent's usage in the state file, `run --status` and the final summary.
  const { res } = await runNoResultAgent(t, false, { body: `cat "${fileURLToPath(new URL('./claude-wrapper.json', import.meta.url))}"` });
  const expected = { agentRuns: 1, turns: 14, costUsd: 0.4182, inputTokens: 159200, outputTokens: 3400 };
  assert.deepEqual(res.usage, expected);
  assert.deepEqual(runStatus('example-org/example-repo').prs[0].usage, expected);
});

test('with --gate-tmpdir an agent run gets a private TMPDIR there, removed when it ends', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'prloop-agent-tmp-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const seen = join(base, 'seen');
  const { res } = await runNoResultAgent(t, false, { body: `echo "$TMPDIR" > "${seen}"; touch "$TMPDIR/scratch"`, extra: { gateTmpdir: join(base, 'tmp') } });
  assert.equal(res.verdict, 'blocked', JSON.stringify(res));
  const dir = readFileSync(seen, 'utf8').trim();
  assert.ok(dir.startsWith(join(base, 'tmp', 'prloop-agent-')), dir);
  assert.equal(existsSync(dir), false); // removed after the run
  assert.deepEqual(readdirSync(join(base, 'tmp')), []);
  assert.notEqual(process.env.TMPDIR, dir); // prloop's own environment is untouched
});

test('run kills an agent that outlives --agent-timeout and blocks with "agent timed out"', async (t) => {
  const started = Date.now();
  const { res, r } = await runNoResultAgent(t, false, { body: 'sleep 30 & wait', extra: { agentTimeout: 300 } });
  assert.equal(res.verdict, 'blocked', JSON.stringify(res));
  assert.equal(res.reason, 'agent timed out after 1s of work with no output: it was killed before printing its result, so check its last command (time its gate spent queued is not counted)');
  assert.ok(Date.now() - started < 20e3);
  assert.equal(readFileSync(join(r.dir, 'bash-timeouts'), 'utf8'), '300 300\n');
  assert.equal(lockHolder(r.work, null), null);
});

test('time an agent\'s gate spends queued does not count against --agent-timeout', async (t) => {
  // The agent's `prloop ready` marks itself queued for 1.5s of a 0.6s budget, then works briefly and ends.
  const body = `echo $$ > "$PRLOOP_QUEUE_FILE"; sleep 1.5; rm "$PRLOOP_QUEUE_FILE"; sleep 0.2
echo '{"type":"result","subtype":"error_max_turns","is_error":true,"result":"Ran out of turns."}'`;
  const { res } = await runNoResultAgent(t, false, { body, extra: { agentTimeout: 600 } });
  assert.equal(res.reason, 'the agent session ended at its max-turns limit', JSON.stringify(res));
  // A marker whose process is gone does not pause the clock.
  const { res: stale } = await runNoResultAgent(t, false, { body: `echo ${deadPid()} > "$PRLOOP_QUEUE_FILE"; sleep 30`, extra: { agentTimeout: 600 } });
  assert.match(stale.reason, /^agent timed out/);
});

test('ready marks its agent queued until its gate is admitted', async (t) => {
  tempState(t);
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  r.run(r.work, 'push', '-q', 'origin', 'feat');
  const head = r.run(r.work, 'rev-parse', 'HEAD');
  const q = join(r.dir, 'queued');
  const old = process.env.PRLOOP_QUEUE_FILE;
  process.env.PRLOOP_QUEUE_FILE = q;
  t.after(() => { if (old === undefined) delete process.env.PRLOOP_QUEUE_FILE; else process.env.PRLOOP_QUEUE_FILE = old; });
  const dir = join(r.dir, 'slots');
  const hold = acquireSlot(dir, 1);
  const seen = [];
  const pause = async () => { seen.push(readFileSync(q, 'utf8')); hold(); };
  const g = await readyGate({ branch: 'feat', head, readyToRequest: false }, { ...cfg, gate: `test ! -e "${q}"`, gateSlots: 1 }, r.work, { ...idle(), pause, dir });
  assert.deepEqual([g.ok, seen], [true, [String(process.pid)]]); // queued while the slot was taken, unmarked before the gate ran
  assert.equal(existsSync(q), false);
});

test('codex agents and reviewers keep their scratch under --gate-tmpdir', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'prloop-codex-tmp-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const tmp = join(base, 'tmp'), seen = join(base, 'seen');
  // The fake codex records the scratch paths it was given (-o, and --output-schema for a reviewer).
  const body = `for a; do case "$a" in "${tmp}"/*) echo "$a" >> "${seen}";; esac; done`;
  const { res, r } = await runNoResultAgent(t, false, { body, cmd: 'codex', extra: { agent: 'codex', gateTmpdir: tmp } });
  assert.equal(res.verdict, 'blocked', JSON.stringify(res));
  const head = r.run(r.work, 'rev-parse', 'HEAD');
  markTested(head, r.work);
  const v = await localReview('example-org/example-repo', { pr: 7, head, branch: 'feat', base: 'main', baseOid: head, unresolvedThreads: [] }, { ...cfg, agent: 'codex', gateTmpdir: tmp }, r.work);
  assert.equal(v.verdict, 'blocked'); // no output file: the reviewer failed after being started
  const paths = readFileSync(seen, 'utf8').trim().split('\n');
  assert.ok(paths.some((p) => p.startsWith(join(tmp, 'prloop-agent-out-'))) && paths.some((p) => p.startsWith(join(tmp, 'prloop-review-'))), paths.join(' '));
  assert.deepEqual(readdirSync(tmp), []); // all removed afterwards
});

test('machine and repository config files: precedence flag, env, repository, machine, default', (t) => {
  const state = tempState(t);
  writeFileSync(join(state, 'config.json'), JSON.stringify({ gateSlots: 4, resourceWait: '5m', gateTmpdir: '/var/tmp/example' }));
  const machine = machineConfig();
  assert.deepEqual(pick(config({}, {}, { machine }), ['gateSlots', 'resourceWait', 'gateTmpdir']), { gateSlots: 4, resourceWait: 5 * 60e3, gateTmpdir: '/var/tmp/example' });
  assert.equal(config({}, { PRLOOP_GATE_SLOTS: '3' }, { machine }).gateSlots, 3);
  assert.equal(config({ gateSlots: '5' }, { PRLOOP_GATE_SLOTS: '3' }, { machine }).gateSlots, 5);
  writeFileSync(join(state, 'config.json'), JSON.stringify({ gateSlot: 4 }));
  assert.throws(() => machineConfig(), /unknown key gateSlot/);
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  assert.deepEqual(repoConfig(r.work), {});
  writeFileSync(join(r.work, '.prloop.json'), JSON.stringify({ gate: 'make check', gateWeight: 'heavy', union: ['CHANGELOG.md'], merge: 'squash' }));
  mkdirSync(join(r.work, 'sub'));
  const repo = repoConfig(join(r.work, 'sub')); // read from the repository root
  assert.equal(repo.gate, 'make check');
  const c = config({}, {}, { repo });
  assert.deepEqual(pick(c, ['gate', 'gateCost', 'reviewBeforeGate']), { gate: 'make check', gateCost: 1, reviewBeforeGate: true }); // heavy: pipelined by default
  assert.equal(config({ gate: 'make quick', reviewBeforeGate: 'false' }, {}, { repo }).gate, 'make quick');
  assert.equal(config({ reviewBeforeGate: 'false' }, {}, { repo }).reviewBeforeGate, false);
  assert.equal(config({ reviewer: 'local' }, {}, { repo }).reviewBeforeGate, false); // a local review needs the gate first
  assert.equal(config({}, {}, {}).reviewBeforeGate, false); // undeclared weight: gate before review, as before
  assert.deepEqual(['light', 'heavy', '0.5', 2, undefined].map(gateCost), [0, 1, 0, 2, 1]);
  for (const w of ['medium', '1.5', '0', -1]) assert.throws(() => gateCost(w), /gate-weight/);
  assert.throws(() => config({ gateWeight: '4' }, {}), /needs more slots than --gate-slots 2/);
  assert.equal(config({ gateWeight: '4', gateSlots: '4' }, {}).gateCost, 4);
  writeFileSync(join(r.work, '.prloop.json'), JSON.stringify({ union: 'CHANGELOG.md' }));
  assert.throws(() => repoConfig(r.work), /union must be array/);
});

test('run passes its effective gate and limits to spawned agents', () => {
  const c = config({ gate: 'make check', gateSlots: '4', gateWeight: 'light', maxLoad: '6', minFreeMem: '2G', resourceWait: '90s' }, {});
  assert.deepEqual(pick(agentEnv(c, {}), ['PRLOOP_GATE', 'PRLOOP_GATE_WEIGHT', 'PRLOOP_GATE_SLOTS', 'PRLOOP_MAX_LOAD', 'PRLOOP_MIN_FREE_MEM', 'PRLOOP_RESOURCE_WAIT', 'PRLOOP_REVIEW_BEFORE_GATE']),
    { PRLOOP_GATE: 'make check', PRLOOP_GATE_WEIGHT: 'light', PRLOOP_GATE_SLOTS: '4', PRLOOP_MAX_LOAD: '6', PRLOOP_MIN_FREE_MEM: String(2 * GiB), PRLOOP_RESOURCE_WAIT: '90s', PRLOOP_REVIEW_BEFORE_GATE: 'false' });
  const back = config({}, agentEnv(c, {})); // the agent's own prloop reads the same values
  assert.deepEqual(pick(back, ['gate', 'gateSlots', 'gateCost', 'maxLoad', 'minFreeMem', 'resourceWait', 'reviewBeforeGate']),
    pick(c, ['gate', 'gateSlots', 'gateCost', 'maxLoad', 'minFreeMem', 'resourceWait', 'reviewBeforeGate']));
});

test('a light gate skips the slot queue while load allows; a heavy gate may take several slots', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'prloop-slots-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const full = acquireSlots(dir, 2, 2); // two long gates fill the pool
  assert.equal(slotsInUse(dir), 2);
  const light = { ...cfg, gateSlots: 2, gateCost: 0 };
  assert.equal((await runGate('echo ran', dir, light, { ...idle(), dir })).stdout.trim(), 'ran');
  // On a busy machine, after the resource wait, a light gate queues for the one slot like any other.
  const x = idle({ load: 50 });
  const pause = async (ms) => { x.clock.t += ms; if (x.clock.t > cfg.resourceWait) full(); };
  await runGate('true', dir, light, { ...x, pause, dir });
  assert.deepEqual(x.events.map((e) => e.event), ['waiting_for_resources', 'resource_wait_expired', 'waiting_for_gate_slot']);
  const one = acquireSlot(dir, 3);
  assert.equal(acquireSlots(dir, 3, 3), null); // all or nothing
  assert.equal(slotsInUse(dir), 1);
  one();
  const three = acquireSlots(dir, 3, 3);
  assert.equal(slotsInUse(dir), 3);
  three();
  assert.deepEqual(readdirSync(dir), []);
});

test('the fix prompt follows pipelined review and carries a gate failure', () => {
  const t = { trigger: 'gate_failed', pr: 7, repo: 'o/r', branch: 'b', head: 'h', cwd: '/w', gate: 'make check', reviewBeforeGate: true, missing: ['x'],
    gateFailure: { head: 'h', log: '/state/gate.log' }, requestBody: '@codex review' };
  const p = buildPrompt(t);
  assert.match(p, /The full gate failed on head h; rerun its steps locally/);
  assert.doesNotMatch(p, /gate\.log/); // the agent reads referenced files, and the log may hold a secret
  assert.match(p, /requests the review first and prloop runs the full gate \(make check\) in parallel/);
  assert.match(buildPrompt({ ...t, localReview: true }), /prloop ready 7 --repo o\/r --review-before-gate false` runs the gate/);
});

test('only claude agents get the Bash timeout variables', () => {
  assert.deepEqual(pick(agentEnv({ agent: 'claude', agentTimeout: 5400000 }, {}), ['BASH_DEFAULT_TIMEOUT_MS', 'BASH_MAX_TIMEOUT_MS']),
    { BASH_DEFAULT_TIMEOUT_MS: '5400000', BASH_MAX_TIMEOUT_MS: '5400000' });
  assert.deepEqual(agentEnv({ agent: 'codex', agentTimeout: 1 }, { A: '1' }), { A: '1' });
  assert.equal(config({}, {}).agentTimeout, 90 * 6e4);
  assert.equal(config({}, { PRLOOP_AGENT_TIMEOUT: '2h' }).agentTimeout, 2 * 36e5);
});

test('run keeps polling when an agent without a result line still made progress', async (t) => {
  const { res } = await runNoResultAgent(t, true);
  assert.equal(res.verdict, 'clean', JSON.stringify(res));
  assert.ok(existsSync(res.agentLog));
  const events = runStatus('example-org/example-repo').prs[0].events.map((e) => e.phase);
  assert.ok(events.includes('agent_no_result'), events.join(','));
  const log = readFileSync(join(process.env.XDG_STATE_HOME, 'prloop', readdirSync(join(process.env.XDG_STATE_HOME, 'prloop')).find((f) => f.startsWith('run-'))), 'utf8');
  assert.match(log, /agent made progress without a result line \(the agent session ended at its max-turns limit\)/);
});

test('run counts a configured gate pass as progress when the head already had another gate\'s marker', async (t) => {
  const state = tempState(t);
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  r.run(r.work, 'push', '-q', 'origin', 'feat');
  const head = r.run(r.work, 'rev-parse', 'HEAD');
  writeFileSync(join(state, 'heads.json'), JSON.stringify({ 'example-org/example-repo#7': { sha: head, at: at('09:00') } }));
  markTested(head, r.work); // a generic marker left by another gate
  const pr = fixture();
  Object.assign(pr, { headRefName: 'feat', headRefOid: head, mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE' });
  request(pr).reactions.nodes.push({ content: 'THUMBS_UP', createdAt: at('10:30'), user: BOT });
  fakeGh(t, r.dir, pr);
  const mod = fileURLToPath(new URL('../prloop.mjs', import.meta.url));
  writeFileSync(join(r.dir, 'bin', 'claude'), `#!/bin/sh
node -e 'import(process.argv[1]).then((m) => m.recordGatePass("true", process.cwd()))' "${mod}"
echo '{"status":"nothing_to_do","head":"${head}"}'
`, { mode: 0o755 });
  const [res] = await runAll({ repo: 'example-org/example-repo', pr: '7', worktree: r.work, merge: 'rebase', deadline: '1h' }, { ...cfg, gate: 'true', interval: 1 }, { metrics: idle().metrics });
  assert.equal(res.verdict, 'merged', JSON.stringify(res));
});

test('run skips a locked worktree before judging its checkout: the holder\'s uncommitted edit does not block', async (t) => {
  tempState(t);
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  r.run(r.work, 'push', '-q', 'origin', 'feat');
  const pr = fixture();
  Object.assign(pr, { headRefName: 'feat', headRefOid: r.run(r.work, 'rev-parse', 'HEAD'), mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE' });
  pr.reviewThreads.nodes.push(thread('T1', at('10:20')));
  fakeGh(t, r.dir, pr);
  const lock = takeLock(r.work, 'fix agent for PR #7 (another supervisor)');
  t.after(() => lock.release());
  writeFileSync(join(r.work, 'app.txt'), 'agent edit in progress\n');
  const [res] = await runAll({ repo: 'example-org/example-repo', pr: '7', worktree: r.work }, { ...cfg, interval: 1, deadline: 200 }, { metrics: idle().metrics });
  assert.equal(res.verdict, 'deadline', JSON.stringify(res));
});

test('ready rereads the PR after its gate: a head pushed meanwhile is not reported ready', (t) => {
  tempState(t);
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  r.run(r.work, 'push', '-q', 'origin', 'feat');
  const head = r.run(r.work, 'rev-parse', 'HEAD');
  const pr = fixture();
  Object.assign(pr, { headRefName: 'feat', headRefOid: head, mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE' });
  fakeGh(t, r.dir, pr);
  const moved = 'd'.repeat(40);
  writeFileSync(join(r.dir, 'moved.json'), readFileSync(join(r.dir, 'pr.json'), 'utf8').replaceAll(head, moved));
  // The "gate" passes while another worktree pushes a new head.
  // Many slots: the suite may itself run as a prloop gate that holds one of the shared machine-wide slots.
  // No real resource waits: a busy machine must not stall this test for --resource-wait.
  const res = spawnSync(process.execPath, [PRLOOP, 'ready', '7', '--repo', 'example-org/example-repo', '--gate', `cp "${r.dir}/moved.json" "${r.dir}/pr.json"`],
    { cwd: r.work, encoding: 'utf8', env: { ...process.env, PRLOOP_LOCK_TOKEN: '', PRLOOP_GATE_SLOTS: '64', PRLOOP_MAX_LOAD: '100000', PRLOOP_MIN_FREE_MEM: '1K' } });
  const out = JSON.parse(res.stdout);
  assert.equal(res.status, 50, res.stdout);
  assert.deepEqual([out.ready, out.head], [false, moved]);
  assert.ok(out.missing.some((m) => m.includes(`head ${moved.slice(0, 7)} not marked tested`)), res.stdout);
  assert.equal(isTested(head, r.work), true); // the gated old head stays marked
});

test('status reports tested from the configured gate, not from another gate\'s marker', (t) => {
  tempState(t);
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  r.run(r.work, 'push', '-q', 'origin', 'feat');
  const head = r.run(r.work, 'rev-parse', 'HEAD');
  markTested(head, r.work); // a generic marker, as left by another gate
  const pr = fixture();
  Object.assign(pr, { headRefName: 'feat', headRefOid: head });
  fakeGh(t, r.dir, pr);
  const status = (gate, cwd = r.work) => JSON.parse(spawnSync(process.execPath, [PRLOOP, 'status', '7', '--repo', 'example-org/example-repo', ...gate],
    { cwd, encoding: 'utf8', env: { ...process.env, PRLOOP_LOCK_TOKEN: '', PRLOOP_GATE: '' } }).stdout);
  assert.equal(status([]).tested, true);
  const s = status(['--gate', 'true']);
  assert.equal(s.tested, false);
  assert.ok(s.reasons.some((m) => m.includes('not marked tested')));
  const outside = mkdtempSync(join(tmpdir(), 'prloop-nogit-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  assert.equal(status(['--gate', 'true'], outside).tested, false); // no checkout: a remote status, not a git error
});

test('a standalone sync holds the worktree lock for its whole run unless its token already owns it', (t) => {
  tempState(t);
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  r.run(r.work, 'push', '-q', 'origin', 'feat');
  const pr = fixture();
  Object.assign(pr, { headRefName: 'feat', headRefOid: r.run(r.work, 'rev-parse', 'HEAD'), baseRefOid: r.run(r.work, 'rev-parse', 'origin/main') });
  fakeGh(t, r.dir, pr);
  const lockDir = join(r.run(r.work, 'rev-parse', '--absolute-git-dir'), 'prloop-lock');
  const gh = join(r.dir, 'bin', 'gh');
  writeFileSync(gh, readFileSync(gh, 'utf8').replace('#!/bin/sh\n', `#!/bin/sh\ncat "${lockDir}"/* >> "${r.dir}/seen"; echo >> "${r.dir}/seen"\n`));
  const sync = (env) => spawnSync(process.execPath, [PRLOOP, 'sync', '7', '--repo', 'example-org/example-repo'], { cwd: r.work, encoding: 'utf8', env: { ...process.env, ...env } });
  sync({ PRLOOP_LOCK_TOKEN: '' });
  assert.match(readFileSync(join(r.dir, 'seen'), 'utf8'), /"purpose":"sync of PR #7"/); // claimed while it read the PR
  assert.equal(lockHolder(r.work, null), null); // and released afterwards
  const lock = takeLock(r.work, 'fix agent for PR #7');
  t.after(() => lock.release());
  rmSync(join(r.dir, 'seen'));
  sync({ PRLOOP_LOCK_TOKEN: lock.token });
  const seen = readFileSync(join(r.dir, 'seen'), 'utf8');
  assert.match(seen, /fix agent for PR #7/);
  assert.doesNotMatch(seen, /sync of PR #7/); // the inherited claim covers it
});

test('pipelined ready: a head that needs a request is ready without the gate; once requested, ready runs the gate', (t) => {
  const state = tempState(t);
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  r.run(r.work, 'push', '-q', 'origin', 'feat');
  const head = r.run(r.work, 'rev-parse', 'HEAD');
  writeFileSync(join(state, 'heads.json'), JSON.stringify({ 'example-org/example-repo#7': { sha: head, at: at('09:00') } }));
  const pr = fixture();
  Object.assign(pr, { headRefName: 'feat', headRefOid: head, mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE' });
  const requested = JSON.parse(JSON.stringify(pr));
  pr.comments.nodes = [];
  fakeGh(t, r.dir, pr);
  const ran = join(r.dir, 'ran');
  const ready = () => spawnSync(process.execPath, [PRLOOP, 'ready', '7', '--repo', 'example-org/example-repo', '--gate', `touch "${ran}"`, '--review-before-gate', 'true'],
    { cwd: r.work, encoding: 'utf8', env: { ...process.env, PRLOOP_LOCK_TOKEN: '', PRLOOP_GATE_WEIGHT: 'light', PRLOOP_MAX_LOAD: '100000', PRLOOP_MIN_FREE_MEM: '1K', PRLOOP_TIMEOUT: '99999h', PRLOOP_ACK_TIMEOUT: '99999h' } });
  let res = ready();
  assert.equal(res.status, 0, res.stdout);
  assert.deepEqual(pick(JSON.parse(res.stdout), ['ready', 'gate']), { ready: true, gate: 'deferred' });
  assert.equal(existsSync(ran), false); // requested first
  writeFileSync(join(r.dir, 'pr.json'), JSON.stringify({ data: { viewer: { login: 'example-dev' }, repository: { mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true, pullRequest: requested } } }));
  res = ready();
  assert.equal(res.status, 50, res.stdout); // the request is pending, so not ready for another one
  assert.deepEqual(pick(JSON.parse(res.stdout), ['ready', 'gate']), { ready: false, gate: 'passed' });
  assert.equal(existsSync(ran), true);
  assert.equal(gatePassed(`touch "${ran}"`, r.work), head);
});

// A requested, pending PR under pipelined review: `run` gates the head itself while the review runs.
async function runPipelined(t, gate, { clean = false } = {}) {
  const state = tempState(t);
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  r.run(r.work, 'push', '-q', 'origin', 'feat');
  const head = r.run(r.work, 'rev-parse', 'HEAD');
  writeFileSync(join(state, 'heads.json'), JSON.stringify({ 'example-org/example-repo#7': { sha: head, at: at('09:00') } }));
  const pr = fixture();
  Object.assign(pr, { headRefName: 'feat', headRefOid: head, mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE' });
  if (clean) request(pr).reactions.nodes.push({ content: 'THUMBS_UP', createdAt: at('10:20'), user: BOT });
  const calls = fakeGh(t, r.dir, pr);
  const [res] = await runAll({ repo: 'example-org/example-repo', pr: '7', worktree: r.work, deadline: '1h' },
    { ...cfg, agent: 'none', interval: 1, timeout: 1e12, ackTimeout: 1e12, gate: gate(r), gateCost: 0, reviewBeforeGate: true }, { metrics: idle().metrics });
  return { res, r, head, calls };
}

test('pipelined run: prloop gates the clean head itself, and a clean review plus a passed gate on that head finish it', async (t) => {
  const { res, r, head, calls } = await runPipelined(t, (r) => `touch "${r.dir}/ran"`, { clean: true });
  assert.equal(res.verdict, 'clean', JSON.stringify(res));
  assert.equal(existsSync(join(r.dir, 'ran')), true);
  assert.equal(gatePassed(`touch "${r.dir}/ran"`, r.work), head);
  assert.ok(calls().every((c) => c.startsWith('api graphql')));
});

test('pipelined run: a gate failure on the requested head goes to a fix agent with the gate output', async (t) => {
  const { res } = await runPipelined(t, () => 'echo FAIL test_$((6*7)); exit 1');
  assert.equal(res.verdict, 'gate_failed', JSON.stringify(res)); // --agent none: the prompt is handed back
  assert.match(res.prompt, /Trigger: gate_failed/);
  // The output may hold a secret: it stays in an owner-only local log, and neither it nor its path reaches the prompt.
  assert.doesNotMatch(res.prompt, /FAIL test_42/);
  const { log } = JSON.parse(readFileSync(join(process.env.XDG_STATE_HOME, 'prloop', 'example-org__example-repo__7.json'), 'utf8')).gateFailure;
  assert.ok(!res.prompt.includes(log));
  assert.match(readFileSync(log, 'utf8'), /FAIL test_42/);
  assert.equal(statSync(log).mode & 0o777, 0o600);
});

test('pipelined run: a later pass of the same gate on the head supersedes a recorded gate failure', async (t) => {
  const gate = 'echo FAIL test_retry; exit 1';
  const { res, r } = await runPipelined(t, () => gate, { clean: true });
  assert.equal(res.verdict, 'gate_failed', JSON.stringify(res));
  recordGatePass(gate, r.work); // e.g. an agent's `prloop ready` passed after a flaky failure
  const [again] = await runAll({ repo: 'example-org/example-repo', pr: '7', worktree: r.work, deadline: '1h' },
    { ...cfg, agent: 'none', interval: 1, timeout: 1e12, ackTimeout: 1e12, gate, gateCost: 0, reviewBeforeGate: true }, { metrics: idle().metrics });
  assert.equal(again.verdict, 'clean', JSON.stringify(again));
});

test('pipelined run: a head that moved away and back is gated afresh, and the state file is owner-only', async (t) => {
  let ok;
  const { res, r } = await runPipelined(t, (r) => (ok = join(r.dir, 'ok'), `test -e "${ok}"`), { clean: true });
  assert.equal(res.verdict, 'gate_failed', JSON.stringify(res));
  const file = join(process.env.XDG_STATE_HOME, 'prloop', 'example-org__example-repo__7.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  writeFileSync(ok, '');
  const st = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...st, head: '0'.repeat(40) })); // a poll saw another head meanwhile
  const [again] = await runAll({ repo: 'example-org/example-repo', pr: '7', worktree: r.work, deadline: '1h' },
    { ...cfg, agent: 'none', interval: 1, timeout: 1e12, ackTimeout: 1e12, gate: `test -e "${ok}"`, gateCost: 0, reviewBeforeGate: true }, { metrics: idle().metrics });
  assert.equal(again.verdict, 'clean', JSON.stringify(again));
});

test('run linearizes once and retries when GitHub refuses a rebase merge of a clean PR', async (t) => {
  const state = tempState(t);
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  r.commit('feature', { 'app.txt': 'feature\n' });
  divergeOnMain(r, { 'other.txt': 'base\n' });
  r.run(r.work, 'merge', '-q', '--no-edit', 'main'); // a merge commit GitHub will not rebase-merge
  r.run(r.work, 'push', '-q', 'origin', 'feat');
  const head = r.run(r.work, 'rev-parse', 'HEAD');
  markTested(head, r.work);
  writeFileSync(join(state, 'heads.json'), JSON.stringify({ 'example-org/example-repo#7': { sha: head, at: at('09:00') } }));
  const pr = fixture();
  Object.assign(pr, { headRefName: 'feat', headRefOid: head, mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE' });
  request(pr).reactions.nodes.push({ content: 'THUMBS_UP', createdAt: at('10:20'), user: BOT });
  const calls = fakeGh(t, r.dir, pr);
  // The first merge is refused.
  const gh = join(r.dir, 'bin', 'gh');
  writeFileSync(gh, readFileSync(gh, 'utf8').replace('"pr merge") ', `"pr merge") if [ ! -e "${r.dir}/refused" ]; then touch "${r.dir}/refused"; echo "Merge commits are not allowed on this branch" >&2; exit 1; fi; `));
  const runP = runAll({ repo: 'example-org/example-repo', pr: '7', worktree: r.work, merge: 'rebase', deadline: '1h' }, { ...cfg, agent: 'none', interval: 1 }, { metrics: idle().metrics });
  for (let i = 0; i < 400 && r.run(r.work, 'rev-parse', 'HEAD') === head; i++) await new Promise((d) => setTimeout(d, 5));
  const linear = r.run(r.work, 'rev-parse', 'HEAD');
  const merged = fixture();
  Object.assign(merged, { headRefName: 'feat', headRefOid: linear, state: 'MERGED', mergeCommit: { oid: 'c'.repeat(40) } });
  writeFileSync(join(r.dir, 'pr.json'), JSON.stringify({ data: { viewer: { login: 'example-dev' }, repository: { mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true, pullRequest: merged } } }));
  const [res] = await runP;
  assert.notEqual(linear, head);
  assert.equal(r.run(r.work, 'rev-list', '--merges', 'origin/main..origin/feat'), ''); // linearized and pushed
  assert.equal(res.verdict, 'merged', JSON.stringify(res));
  assert.equal(calls().filter((c) => c.startsWith('pr merge')).length, 1);
  assert.match(readFileSync(JSON.parse(readFileSync(join(state, 'example-org__example-repo__7.json'), 'utf8')).log, 'utf8'), /"phase":"merge_refused"/);
});

test('run blocks without linearizing when GitHub refuses a rebase merge for another reason', async (t) => {
  const state = tempState(t);
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  r.commit('feature', { 'app.txt': 'feature\n' });
  divergeOnMain(r, { 'other.txt': 'base\n' });
  r.run(r.work, 'merge', '-q', '--no-edit', 'main');
  r.run(r.work, 'push', '-q', 'origin', 'feat');
  const head = r.run(r.work, 'rev-parse', 'HEAD');
  markTested(head, r.work);
  writeFileSync(join(state, 'heads.json'), JSON.stringify({ 'example-org/example-repo#7': { sha: head, at: at('09:00') } }));
  const pr = fixture();
  Object.assign(pr, { headRefName: 'feat', headRefOid: head, mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE' });
  request(pr).reactions.nodes.push({ content: 'THUMBS_UP', createdAt: at('10:20'), user: BOT });
  const calls = fakeGh(t, r.dir, pr);
  const gh = join(r.dir, 'bin', 'gh');
  writeFileSync(gh, readFileSync(gh, 'utf8').replace('"pr merge") ', '"pr merge") echo "HTTP 502: Bad Gateway" >&2; exit 1; '));
  const [res] = await runAll({ repo: 'example-org/example-repo', pr: '7', worktree: r.work, merge: 'rebase', deadline: '1h' }, { ...cfg, agent: 'none', interval: 1 }, { metrics: idle().metrics });
  assert.equal(res.verdict, 'blocked', JSON.stringify(res));
  assert.match(res.reason, /HTTP 502/);
  assert.equal(r.run(r.work, 'rev-parse', 'origin/feat'), head); // nothing rewritten or pushed
  assert.equal(calls().filter((c) => c.startsWith('pr merge')).length, 1);
});

test('pipelined run: a clean review without a worktree to gate it is blocked, not clean', async (t) => {
  const state = tempState(t);
  const dir = mkdtempSync(join(tmpdir(), 'prloop-nowt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pr = fixture();
  Object.assign(pr, { headRefName: 'no-such-branch', mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE' });
  writeFileSync(join(state, 'heads.json'), JSON.stringify({ 'example-org/example-repo#7': { sha: pr.headRefOid, at: at('09:00') } }));
  request(pr).reactions.nodes.push({ content: 'THUMBS_UP', createdAt: at('10:20'), user: BOT });
  fakeGh(t, dir, pr);
  const [res] = await runAll({ repo: 'example-org/example-repo', pr: '7', deadline: '1h' },
    { ...cfg, agent: 'none', interval: 1, gate: 'true', reviewBeforeGate: true }, { metrics: idle().metrics });
  assert.equal(res.verdict, 'blocked', JSON.stringify(res));
  assert.match(res.reason, /to run the gate; pass --worktree/);
});

// ---------- generated-file conflicts and sync --continue ----------

for (const settings of [{ merge: true, squash: true }, { merge: false, squash: false }]) {
  const method = settings.merge ? 'merge' : 'rebase';

  test(`sync (${method}) resolves conflicts limited to generated files: base side, one regenerate, commit, push`, (t) => {
    const r = gitRepo();
    t.after(() => rmSync(r.dir, { recursive: true, force: true }));
    const runs = join(r.dir, 'regen-runs');
    const regenerate = `cat app.txt log.csv > gen.txt && echo run >> "${runs}"`;
    r.commit('feature 1', { 'gen.txt': 'feature 1\n', 'app.txt': 'one\nfeature\n' });
    r.commit('feature 2', { 'gen.txt': 'feature 2\n' });
    r.run(r.work, 'push', '-q', 'origin', 'feat');
    divergeOnMain(r, { 'gen.txt': 'base build\n', 'log.csv': 'id\na\nbase\n' });
    const head = r.run(r.work, 'rev-parse', 'HEAD');
    const v = syncBranch({ cwd: r.work, branch: 'feat', base: 'main', head, settings, generated: ['*.txt'], regenerate });
    assert.equal(v.verdict, 'synced', JSON.stringify(v));
    assert.deepEqual(v.regenerated, ['gen.txt']);
    assert.equal(v.unchanged, false);
    assert.equal(readFileSync(runs, 'utf8'), 'run\n'); // once, at the end
    assert.equal(r.run(r.work, 'cat-file', '-p', 'HEAD:gen.txt'), 'one\nfeature\nid\na\nbase');
    assert.match(r.run(r.work, 'log', '-1', '--format=%s'), /^Regenerate generated files/);
    assert.equal(r.run(r.work, 'rev-parse', 'origin/feat'), v.head);
    assert.equal(r.run(r.work, 'status', '--porcelain'), '');
  });

  test(`sync (${method}) still aborts and reports when a generated conflict comes with a manual one`, (t) => {
    const r = gitRepo();
    t.after(() => rmSync(r.dir, { recursive: true, force: true }));
    r.commit('feature', { 'gen.txt': 'feature\n', 'app.txt': 'feature\n' });
    r.run(r.work, 'push', '-q', 'origin', 'feat');
    divergeOnMain(r, { '.gitattributes': 'gen.txt linguist-generated\n', 'gen.txt': 'base\n', 'app.txt': 'base\n' });
    const head = r.run(r.work, 'rev-parse', 'HEAD');
    const v = syncBranch({ cwd: r.work, branch: 'feat', base: 'main', head, settings, regenerate: 'true' });
    assert.equal(v.verdict, 'conflict', JSON.stringify(v));
    assert.deepEqual([v.conflicts, v.generated], [['app.txt'], ['gen.txt']]); // the attribute marks it generated
    assert.match(v.next, /prloop sync <pr> --continue/);
    assert.equal(r.run(r.work, 'rev-parse', 'HEAD'), head);
    assert.equal(r.run(r.work, 'status', '--porcelain'), '');
  });

  test(`sync --continue (${method}) leaves manual conflicts in place, then continues, regenerates and pushes`, (t) => {
    const r = gitRepo();
    t.after(() => rmSync(r.dir, { recursive: true, force: true }));
    r.commit('feature', { 'gen.txt': 'feature\n', 'app.txt': 'feature\n', 'log.csv': 'id\na\nfeature\n' });
    r.run(r.work, 'push', '-q', 'origin', 'feat');
    divergeOnMain(r, { 'gen.txt': 'base\n', 'app.txt': 'base\n', 'log.csv': 'id\na\nbase\n' });
    const head = r.run(r.work, 'rev-parse', 'HEAD');
    const args = { cwd: r.work, branch: 'feat', base: 'main', head, settings, union: ['*.csv'], generated: ['gen.txt'], regenerate: 'cp app.txt gen.txt', resume: true };
    let v = syncBranch(args);
    assert.equal(v.verdict, 'conflict', JSON.stringify(v));
    assert.deepEqual([v.conflicts, v.generated, v.inProgress], [['app.txt'], ['gen.txt'], true]);
    v = syncBranch(args); // markers still there
    assert.equal(v.verdict, 'conflict', JSON.stringify(v));
    assert.match(v.next, /conflict markers/);
    assert.equal(syncBranch({ ...args, head: 'f'.repeat(40) }).verdict, 'error'); // not a sync of this head
    writeFileSync(join(r.work, 'app.txt'), 'base and feature\n');
    assert.match(syncBranch(args).next, /stage each resolution/); // resolved but not staged
    r.run(r.work, 'add', 'app.txt');
    writeFileSync(join(r.work, 'log.csv'), 'unrelated edit\n');
    writeFileSync(join(r.work, 'scratch.txt'), 'secret\n');
    v = syncBranch(args); // neither the unstaged edit nor the untracked file may be committed
    assert.deepEqual([v.verdict, v.stray], ['conflict', ['log.csv', 'scratch.txt']], JSON.stringify(v));
    r.run(r.work, 'checkout', '--', 'log.csv');
    rmSync(join(r.work, 'scratch.txt'));
    v = syncBranch(args);
    assert.equal(v.verdict, 'synced', JSON.stringify(v));
    assert.deepEqual([v.resumed, v.unchanged], [true, false]);
    assert.equal(r.run(r.work, 'cat-file', '-p', 'HEAD:gen.txt'), 'base and feature');
    assert.equal(r.run(r.work, 'cat-file', '-p', 'HEAD:log.csv'), 'id\na\nbase\nfeature');
    assert.equal(r.run(r.work, 'rev-parse', 'origin/feat'), v.head);
    assert.equal(r.run(r.work, 'status', '--porcelain'), '');
  });
}

test('a failing regenerate command restores the old head and reports no output', (t) => {
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  r.commit('feature', { 'gen.txt': 'feature\n' });
  r.run(r.work, 'push', '-q', 'origin', 'feat');
  divergeOnMain(r, { 'gen.txt': 'base\n' });
  const head = r.run(r.work, 'rev-parse', 'HEAD');
  writeFileSync(join(r.work, '.git', 'info', 'exclude'), '*.out\n');
  writeFileSync(join(r.work, 'old.out'), 'kept\n');
  const v = syncBranch({ cwd: r.work, branch: 'feat', base: 'main', head, settings: { merge: true }, generated: ['gen.txt'], regenerate: ['echo x > build.out', 'echo $((6 * 7)) > new.txt; exit 3'] });
  assert.equal(v.verdict, 'error');
  assert.match(v.error, /exit 3/);
  assert.doesNotMatch(v.error, /42/); // the output is not reported
  assert.equal(r.run(r.work, 'rev-parse', 'HEAD'), head);
  assert.equal(r.run(r.work, 'rev-parse', 'origin/feat'), head);
  assert.equal(r.run(r.work, 'status', '--porcelain', '--ignored'), '!! old.out'); // new files are gone, ignored ones too
});

test('sync --continue refuses a markerless conflict until it is staged, also with the apply rebase backend', (t) => {
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  r.run(r.work, 'config', 'rebase.backend', 'apply');
  r.commit('feature', { 'app.txt': 'feature\n' });
  r.run(r.work, 'push', '-q', 'origin', 'feat');
  r.run(r.work, 'switch', '-q', 'main');
  r.run(r.work, 'rm', '-q', 'app.txt');
  r.run(r.work, 'commit', '-qm', 'drop app');
  r.run(r.work, 'push', '-q', 'origin', 'main');
  r.run(r.work, 'switch', '-q', 'feat');
  const head = r.run(r.work, 'rev-parse', 'HEAD');
  const args = { cwd: r.work, branch: 'feat', base: 'main', head, settings: { merge: false, squash: false }, resume: true };
  assert.equal(syncBranch(args).verdict, 'conflict');
  const v = syncBranch(args); // modify/delete: no markers, still unresolved
  assert.deepEqual([v.verdict, v.conflicts], ['conflict', ['app.txt']], JSON.stringify(v));
  assert.equal(r.run(r.work, 'rev-parse', 'origin/feat'), head);
  r.run(r.work, 'rm', '-q', 'app.txt');
  assert.equal(syncBranch(args).verdict, 'synced');
  assert.equal(r.run(r.work, 'ls-tree', '--name-only', 'HEAD'), 'log.csv');
});

test('.prloop.json validates regenerate and generated, and mark-tested records its gate in the gate cache', (t) => {
  tempState(t);
  const r = gitRepo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  for (const [bad, re] of [[{ regenerate: 3 }, /regenerate must be string\|array/], [{ regenerate: [1] }, /regenerate must be/], [{ regenerate: [] }, /non-blank/], [{ regenerate: ['make', ' '] }, /non-blank/], [{ regenerate: '' }, /non-blank/], [{ generated: 'x' }, /generated must be array/]]) {
    writeFileSync(join(r.work, '.prloop.json'), JSON.stringify(bad));
    assert.throws(() => repoConfig(r.work), re);
  }
  writeFileSync(join(r.work, '.prloop.json'), JSON.stringify({ gate: 'make check', regenerate: ['make gen'], generated: ['dist/**'] }));
  assert.deepEqual(repoConfig(r.work).regenerate, ['make gen']);
  r.commit('config', {});
  const head = r.run(r.work, 'rev-parse', 'HEAD');
  const res = spawnSync(process.execPath, [PRLOOP, 'mark-tested'], { cwd: r.work, encoding: 'utf8', env: (({ PRLOOP_GATE, ...env }) => ({ ...env, PRLOOP_LOCK_TOKEN: '' }))(process.env) });
  assert.equal(JSON.parse(res.stdout).gatePassedHead, head, res.stdout + res.stderr);
  assert.equal(gatePassed('make check', r.work), head);
});

test('the conflict prompt sends the agent through prloop sync --continue, never a raw rebase', () => {
  const p = buildPrompt({ trigger: 'conflict', conflicts: ['app.txt'], pr: 7, repo: 'o/r', gate: 'make test' });
  assert.match(p, /never with a raw `git rebase`/);
  assert.match(p, /`prloop sync 7 --continue`/);
});
