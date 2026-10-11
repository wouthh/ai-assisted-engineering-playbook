/**
 * [AI_CONTEXT]
 * purpose: Define the durable, PR-stable review-generation policy and queue-state migration contract.
 * touches: Autonomous PR-review budgets, request-cycle identity, exact review comments, and v1 queue-state preservation.
 * invariants: Budgets are keyed by immutable GitHub repository and pull-request node IDs plus reviewer; names, numbers, heads, and branches are diagnostics only; only a confirmed trigger spends a generation; migrations retain prior request and retry evidence.
 * inputs: Parsed queue state, pull-request identity and timestamps, review-cycle metadata, and authenticated owner-override audit data.
 * outputs: Validated immutable state and policy values for the queue orchestrator to persist atomically.
 * see: README.md, review-state.mjs
 */

import { createHash } from "node:crypto";

export const PR_REVIEW_QUEUE_STATE_SCHEMA_VERSION = 2;
export const PR_REVIEW_POLICY_VERSION = 1;
export const PR_REVIEW_REPORT_SCHEMA_VERSION = 3;

export const REVIEW_EPOCH_NORMAL = "normal";
export const REVIEW_EPOCH_LEGACY_CLOSURE = "legacy_closure";
export const REVIEW_REQUEST_INITIAL_FULL = "initial_full";
export const REVIEW_REQUEST_TARGETED_CLOSURE = "targeted_closure";

export const DEFAULT_REVIEW_BUDGETS = Object.freeze({
  [REVIEW_EPOCH_NORMAL]: Object.freeze({
    initial_full: 1,
    targeted_closure: 2,
  }),
  [REVIEW_EPOCH_LEGACY_CLOSURE]: Object.freeze({
    initial_full: 0,
    targeted_closure: 2,
  }),
});

export const REQUIRED_REVIEW_POLICY_FIELDS = Object.freeze([
  "policy_key",
  "repository_id",
  "pull_request_id",
  "repo",
  "pr_number",
  "branch",
  "reviewer",
  "state_schema_version",
  "policy_version",
  "report_schema_version",
  "epoch_type",
  "policy_activated_at",
  "pr_created_at",
  "epoch_started_at",
  "historical_review_count",
  "historical_review_ids",
  "review_budget",
  "external_review_generations_used",
  "external_review_generations_remaining",
  "last_full_review_head_sha",
  "last_targeted_review_base_sha",
  "last_targeted_review_head_sha",
  "current_request_cycle_id",
  "current_actionable_fingerprint",
  "root_cause_cluster_fingerprints",
  "exact_review_request_comment_body",
  "request_timestamp",
  "github_comment_id",
  "current_request",
  "latest_terminal_result",
  "budget_exhaustion_reason",
  "selected_local_worker_profile",
  "merge_blockers",
  "external_review_generations",
  "owner_overrides",
  "legacy_request_evidence",
  "current_head_sha",
  "current_base_sha",
  "updated_at",
]);

const REQUEST_MARKER_PATTERN =
  /<!-- pr-review-followup:cycle=([^;\s<>]+);type=(initial_full|targeted_closure)(?:;base=([^;\s<>]+))?;head=([^;\s<>]+) -->/gu;
const MARKER_TOKEN_PATTERN = /^[A-Za-z0-9._:/-]+$/u;

function cloneJson(value) {
  return structuredClone(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requirePlainObject(value, label) {
  if (!isPlainObject(value)) {
    throw new Error(`state_corruption: ${label} must be an object`);
  }
  return value;
}

function requireRecordMap(value, label) {
  const records = requirePlainObject(value, label);
  for (const [recordKey, record] of Object.entries(records)) {
    requirePlainObject(record, `${label}[${JSON.stringify(recordKey)}]`);
  }
  return records;
}

function requireNonEmptyString(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function requireMarkerToken(value, label) {
  const normalized = requireNonEmptyString(value, label);
  if (!MARKER_TOKEN_PATTERN.test(normalized)) {
    throw new Error(`${label} contains unsupported marker characters`);
  }
  return normalized;
}

function requirePositiveInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return normalized;
}

function requireNonNegativeInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return normalized;
}

function requireIsoTimestamp(value, label) {
  const normalized = requireNonEmptyString(value, label);
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return new Date(milliseconds).toISOString();
}

function normalizeNullableMarkerToken(value, label) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }
  return requireMarkerToken(value, label);
}

function normalizeCommentId(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }
  const normalized = String(value).trim();
  if (!/^[1-9]\d*$/u.test(normalized)) {
    throw new Error("githubCommentId must be a positive integer identifier");
  }
  return normalized;
}

function normalizeDisplayLine(value, label) {
  const normalized = requireNonEmptyString(value, label).replace(/\s+/gu, " ");
  if (normalized.includes("<!--") || normalized.includes("-->")) {
    throw new Error(`${label} cannot contain an HTML comment marker`);
  }
  return normalized;
}

function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validateOverrideBudgetSummary(value, label) {
  const summary = requirePlainObject(value, label);
  const full = requireNonNegativeInteger(summary.full, `${label}.full`);
  const targeted = requireNonNegativeInteger(
    summary.targeted,
    `${label}.targeted`,
  );
  const total = requireNonNegativeInteger(summary.total, `${label}.total`);
  if (total !== full + targeted) {
    throw new Error(
      `state_corruption: ${label} total does not match its component budgets`,
    );
  }
  return { full, targeted, total };
}

function assertOwnerOverrideLedger(policy) {
  const defaults = DEFAULT_REVIEW_BUDGETS[policy.epoch_type];
  if (!defaults) {
    throw new Error(
      "state_corruption: review policy epoch has no default budget",
    );
  }
  const overrideIds = new Set();
  let targetedCredits = 0;
  for (const [index, rawOverride] of policy.owner_overrides.entries()) {
    const label = `owner_overrides[${index}]`;
    const override = requirePlainObject(rawOverride, label);
    const overrideId = requireNonEmptyString(
      override.override_id,
      `${label}.override_id`,
    );
    if (overrideIds.has(overrideId)) {
      throw new Error("state_corruption: owner override IDs must be unique");
    }
    overrideIds.add(overrideId);
    if (override.kind !== "grant_one_targeted_review") {
      throw new Error(
        `state_corruption: ${label}.kind is not a supported owner override`,
      );
    }
    const actor = requireNonEmptyString(override.actor, `${label}.actor`);
    const reason = requireNonEmptyString(override.reason, `${label}.reason`);
    const grantedAt = requireIsoTimestamp(
      override.granted_at,
      `${label}.granted_at`,
    );
    const headSha = normalizeNullableMarkerToken(
      override.head_sha,
      `${label}.head_sha`,
    );
    const creditsGranted = requireNonNegativeInteger(
      override.credits_granted,
      `${label}.credits_granted`,
    );
    if (creditsGranted !== 1) {
      throw new Error(
        `state_corruption: ${label} must grant exactly one targeted review`,
      );
    }
    const expectedOverrideId = stableHash({
      policy_key: policy.policy_key,
      actor,
      reason,
      granted_at: grantedAt,
      head_sha: headSha,
    });
    if (overrideId !== expectedOverrideId) {
      throw new Error(
        `state_corruption: ${label}.override_id does not match its audit evidence`,
      );
    }
    const before = validateOverrideBudgetSummary(
      override.budget_remaining_before,
      `${label}.budget_remaining_before`,
    );
    const after = validateOverrideBudgetSummary(
      override.budget_remaining_after,
      `${label}.budget_remaining_after`,
    );
    if (
      after.full !== before.full ||
      after.targeted !== before.targeted + 1 ||
      after.total !== before.total + 1
    ) {
      throw new Error(
        `state_corruption: ${label} budget evidence does not grant exactly one targeted review`,
      );
    }
    targetedCredits += creditsGranted;
  }

  if (policy.review_budget.initial_full_limit !== defaults.initial_full) {
    throw new Error(
      "state_corruption: initial full review limit differs from the epoch default",
    );
  }
  if (
    policy.review_budget.targeted_closure_limit !==
    defaults.targeted_closure + targetedCredits
  ) {
    throw new Error(
      "state_corruption: targeted closure review limit is not backed by audited owner overrides",
    );
  }
}

function normalizeHistoricalReviewIds(values) {
  if (values === null || values === undefined) {
    return [];
  }
  if (!Array.isArray(values)) {
    throw new Error("historicalReviewIds must be an array");
  }
  return [
    ...new Set(
      values.map((value) =>
        requireNonEmptyString(value, "historical review id"),
      ),
    ),
  ].sort();
}

function normalizeRequestType(value) {
  const normalized = requireNonEmptyString(value, "requestType");
  if (
    normalized !== REVIEW_REQUEST_INITIAL_FULL &&
    normalized !== REVIEW_REQUEST_TARGETED_CLOSURE
  ) {
    throw new Error(`unsupported review request type: ${normalized}`);
  }
  return normalized;
}

function generationMatchesRequest(
  generation,
  { cycleId, headSha, commentBody },
) {
  return (
    generation?.cycle_id === cycleId &&
    generation?.head_sha === headSha &&
    generation?.request_comment_body === commentBody
  );
}

function generationBudgetFields(policy) {
  const fullLimit = requireNonNegativeInteger(
    policy.review_budget.initial_full_limit,
    "review_budget.initial_full_limit",
  );
  const targetedLimit = requireNonNegativeInteger(
    policy.review_budget.targeted_closure_limit,
    "review_budget.targeted_closure_limit",
  );
  const fullUsed = requireNonNegativeInteger(
    policy.review_budget.initial_full_used,
    "review_budget.initial_full_used",
  );
  const targetedUsed = requireNonNegativeInteger(
    policy.review_budget.targeted_closure_used,
    "review_budget.targeted_closure_used",
  );
  if (fullUsed > fullLimit || targetedUsed > targetedLimit) {
    throw new Error(
      "state_corruption: review generation usage exceeds its persisted limit",
    );
  }
  const fullRemaining = Math.max(0, fullLimit - fullUsed);
  const targetedRemaining = Math.max(0, targetedLimit - targetedUsed);
  return {
    review_budget: {
      ...policy.review_budget,
      initial_full_limit: fullLimit,
      targeted_closure_limit: targetedLimit,
      initial_full_used: fullUsed,
      targeted_closure_used: targetedUsed,
      initial_full_remaining: fullRemaining,
      targeted_closure_remaining: targetedRemaining,
      total_remaining: fullRemaining + targetedRemaining,
    },
    external_review_generations_used: {
      full: fullUsed,
      targeted: targetedUsed,
      total: fullUsed + targetedUsed,
    },
    external_review_generations_remaining: {
      full: fullRemaining,
      targeted: targetedRemaining,
      total: fullRemaining + targetedRemaining,
    },
  };
}

const EXTERNAL_REVIEW_GENERATION_STATUSES = new Set([
  "confirmed",
  "timed_out",
  "clear",
  "findings",
]);

function assertExternalReviewGeneration(rawGeneration, index) {
  const label = `external_review_generations[${index}]`;
  try {
    const generation = requirePlainObject(rawGeneration, label);
    const cycleId = requireMarkerToken(
      generation.cycle_id,
      `${label}.cycle_id`,
    );
    const requestType = normalizeRequestType(generation.request_type);
    const baseSha = normalizeNullableMarkerToken(
      generation.base_sha,
      `${label}.base_sha`,
    );
    const headSha = requireMarkerToken(
      generation.head_sha,
      `${label}.head_sha`,
    );
    if (requestType === REVIEW_REQUEST_INITIAL_FULL && baseSha !== null) {
      throw new Error(
        `${label}.base_sha must be null for an initial full review`,
      );
    }
    if (requestType === REVIEW_REQUEST_TARGETED_CLOSURE && baseSha === null) {
      throw new Error(
        `${label}.base_sha is required for a targeted closure review`,
      );
    }

    const requestBody = requireNonEmptyString(
      generation.request_comment_body,
      `${label}.request_comment_body`,
    );
    if (generation.trigger_kind === "automatic_initial_pr_open") {
      assertAutomaticInitialEvidence(generation);
    } else if (generation.trigger_kind !== undefined || requestBody.split(/\r?\n/u, 1)[0]?.trim() !== "@codex review") {
      throw new Error(
        `${label}.request_comment_body must begin with the exact review trigger`,
      );
    }
    const marker = parseReviewRequestMarker(requestBody);
    if (requestBody.includes("<!-- pr-review-followup:") && marker === null) {
      throw new Error(
        `${label}.request_comment_body contains an invalid queue marker`,
      );
    }
    if (
      marker !== null &&
      (marker.cycle_id !== cycleId ||
        marker.request_type !== requestType ||
        marker.base_sha !== baseSha ||
        marker.head_sha !== headSha)
    ) {
      throw new Error(
        `${label}.request_comment_body marker disagrees with the persisted request scope`,
      );
    }

    const requestedAt = requireIsoTimestamp(
      generation.request_timestamp,
      `${label}.request_timestamp`,
    );
    const confirmedAt = requireIsoTimestamp(
      generation.confirmed_at,
      `${label}.confirmed_at`,
    );
    if (Date.parse(confirmedAt) < Date.parse(requestedAt)) {
      throw new Error(
        `${label}.confirmed_at cannot precede its request timestamp`,
      );
    }
    const githubCommentId = normalizeCommentId(generation.github_comment_id);
    if (githubCommentId === null) {
      throw new Error(`${label}.github_comment_id is required`);
    }

    const status = requireNonEmptyString(generation.status, `${label}.status`);
    if (!EXTERNAL_REVIEW_GENERATION_STATUSES.has(status)) {
      throw new Error(`${label}.status is unsupported`);
    }
    if (generation.timed_out_at !== undefined) {
      const timedOutAt = requireIsoTimestamp(
        generation.timed_out_at,
        `${label}.timed_out_at`,
      );
      if (Date.parse(timedOutAt) < Date.parse(confirmedAt)) {
        throw new Error(`${label}.timed_out_at cannot precede confirmation`);
      }
    }
    if (status === "timed_out" && generation.timed_out_at === undefined) {
      throw new Error(`${label}.timed_out_at is required for timed_out status`);
    }
    if (generation.terminal_result_at !== undefined) {
      const terminalResultAt = requireIsoTimestamp(
        generation.terminal_result_at,
        `${label}.terminal_result_at`,
      );
      if (Date.parse(terminalResultAt) < Date.parse(confirmedAt)) {
        throw new Error(
          `${label}.terminal_result_at cannot precede confirmation`,
        );
      }
      if (
        status === "clear" &&
        Date.parse(terminalResultAt) <= Date.parse(requestedAt)
      ) {
        throw new Error(
          `${label}.clear terminal result must be strictly later than its request`,
        );
      }
    }
    if (
      ["clear", "findings"].includes(status) &&
      generation.terminal_result_at === undefined
    ) {
      throw new Error(
        `${label}.terminal_result_at is required for ${status} status`,
      );
    }

    const reviewSubmissionId =
      generation.review_submission_id === null ||
      generation.review_submission_id === undefined ||
      String(generation.review_submission_id).trim() === ""
        ? null
        : normalizeCommentId(generation.review_submission_id);
    return {
      cycleId,
      githubCommentId,
      requestType,
      reviewSubmissionId,
    };
  } catch (error) {
    const message = String(error?.message ?? error);
    if (message.startsWith("state_corruption:")) {
      throw error;
    }
    throw new Error(`state_corruption: ${message}`);
  }
}

function withSynchronizedBudget(policy) {
  return {
    ...policy,
    ...generationBudgetFields(policy),
  };
}

export function buildLegacyReviewPolicyKey({
  repo,
  prNumber,
  reviewer = "codex",
}) {
  const normalizedRepo = requireNonEmptyString(repo, "repo");
  const normalizedPrNumber = requirePositiveInteger(prNumber, "prNumber");
  const normalizedReviewer = requireNonEmptyString(
    reviewer,
    "reviewer",
  ).toLowerCase();
  return `${normalizedRepo}#${normalizedPrNumber}#${normalizedReviewer}`;
}

export function buildReviewPolicyKey({
  repositoryId,
  pullRequestId,
  reviewer = "codex",
}) {
  const normalizedRepositoryId = requireNonEmptyString(
    repositoryId,
    "repositoryId",
  );
  const normalizedPullRequestId = requireNonEmptyString(
    pullRequestId,
    "pullRequestId",
  );
  const normalizedReviewer = requireNonEmptyString(
    reviewer,
    "reviewer",
  ).toLowerCase();
  return `github:${encodeURIComponent(normalizedRepositoryId)}#${encodeURIComponent(normalizedPullRequestId)}#${encodeURIComponent(normalizedReviewer)}`;
}

export function determineReviewEpochType({ prCreatedAt, policyActivatedAt }) {
  const createdAt = requireIsoTimestamp(prCreatedAt, "prCreatedAt");
  const activatedAt = requireIsoTimestamp(
    policyActivatedAt,
    "policyActivatedAt",
  );
  return Date.parse(createdAt) < Date.parse(activatedAt)
    ? REVIEW_EPOCH_LEGACY_CLOSURE
    : REVIEW_EPOCH_NORMAL;
}

export function countHistoricalReviewSubmissions(reviewSubmissions) {
  if (!Array.isArray(reviewSubmissions)) {
    throw new Error("reviewSubmissions must be an array");
  }
  const ids = reviewSubmissions.map((submission) => {
    if (!isPlainObject(submission)) {
      throw new Error("review submission must be an object");
    }
    return requireNonEmptyString(submission.id, "review submission id");
  });
  return new Set(ids).size;
}

export function createQueueState({
  policyActivatedAt,
  createdAt = policyActivatedAt,
}) {
  const activatedAt = requireIsoTimestamp(
    policyActivatedAt,
    "policyActivatedAt",
  );
  const migrationTimestamp = requireIsoTimestamp(createdAt, "createdAt");
  return {
    version: PR_REVIEW_QUEUE_STATE_SCHEMA_VERSION,
    state_schema_version: PR_REVIEW_QUEUE_STATE_SCHEMA_VERSION,
    policy_version: PR_REVIEW_POLICY_VERSION,
    report_schema_version: PR_REVIEW_REPORT_SCHEMA_VERSION,
    policy_activated_at: activatedAt,
    entries: {},
    execution_cache: {},
    policies: {},
    migrations: [
      {
        from_version: null,
        to_version: PR_REVIEW_QUEUE_STATE_SCHEMA_VERSION,
        migrated_at: migrationTimestamp,
      },
    ],
  };
}

export function assertQueueStateV2(state) {
  requirePlainObject(state, "queue state");
  if (state.version !== PR_REVIEW_QUEUE_STATE_SCHEMA_VERSION) {
    throw new Error(
      `state_corruption: unsupported queue state version ${String(state.version)}`,
    );
  }
  if (
    state.state_schema_version !== undefined &&
    state.state_schema_version !== PR_REVIEW_QUEUE_STATE_SCHEMA_VERSION
  ) {
    throw new Error("state_corruption: queue state schema versions disagree");
  }
  if (state.policy_version !== PR_REVIEW_POLICY_VERSION) {
    throw new Error(
      `state_corruption: unsupported review policy version ${String(state.policy_version)}`,
    );
  }
  if (state.report_schema_version !== PR_REVIEW_REPORT_SCHEMA_VERSION) {
    throw new Error(
      `state_corruption: unsupported report schema version ${String(state.report_schema_version)}`,
    );
  }
  requireIsoTimestamp(state.policy_activated_at, "policy_activated_at");
  requireRecordMap(state.entries, "queue state entries");
  requireRecordMap(state.execution_cache, "queue state execution_cache");
  requirePlainObject(state.policies, "queue state policies");
  if (!Array.isArray(state.migrations)) {
    throw new Error(
      "state_corruption: queue state migrations must be an array",
    );
  }
  for (const [policyKey, policy] of Object.entries(state.policies)) {
    assertReviewPolicy(policy, { allowLegacyIdentity: true });
    if (policy.policy_key !== policyKey) {
      throw new Error(
        "state_corruption: review policy map key does not match policy_key",
      );
    }
  }
  return true;
}

export function migrateQueueStateV1ToV2(
  input,
  { policyActivatedAt, migratedAt = policyActivatedAt },
) {
  requirePlainObject(input, "queue state");
  if (input.version !== 1) {
    throw new Error(
      `state_corruption: expected queue state version 1, received ${String(input.version)}`,
    );
  }
  const entries =
    input.entries === undefined
      ? {}
      : requireRecordMap(input.entries, "queue state entries");
  const executionCache =
    input.execution_cache === undefined
      ? {}
      : requireRecordMap(input.execution_cache, "queue state execution_cache");
  if (input.migrations !== undefined && !Array.isArray(input.migrations)) {
    throw new Error(
      "state_corruption: queue state migrations must be an array when present",
    );
  }
  const activatedAt = requireIsoTimestamp(
    policyActivatedAt,
    "policyActivatedAt",
  );
  const migrationTimestamp = requireIsoTimestamp(migratedAt, "migratedAt");
  const migrated = {
    ...cloneJson(input),
    version: PR_REVIEW_QUEUE_STATE_SCHEMA_VERSION,
    state_schema_version: PR_REVIEW_QUEUE_STATE_SCHEMA_VERSION,
    policy_version: PR_REVIEW_POLICY_VERSION,
    report_schema_version: PR_REVIEW_REPORT_SCHEMA_VERSION,
    policy_activated_at: activatedAt,
    entries: cloneJson(entries),
    execution_cache: cloneJson(executionCache),
    policies: {},
    migrations: [
      ...(input.migrations === undefined ? [] : cloneJson(input.migrations)),
      {
        from_version: 1,
        to_version: PR_REVIEW_QUEUE_STATE_SCHEMA_VERSION,
        migrated_at: migrationTimestamp,
        preserved_entry_count: Object.keys(entries).length,
        preserved_execution_cache_count: Object.keys(executionCache).length,
      },
    ],
  };
  assertQueueStateV2(migrated);
  return migrated;
}

export function prepareQueueState(
  input,
  { policyActivatedAt, migratedAt = policyActivatedAt } = {},
) {
  if (input === null || input === undefined) {
    return {
      state: createQueueState({ policyActivatedAt, createdAt: migratedAt }),
      migrated: true,
      sourceVersion: null,
      backupRequired: false,
    };
  }
  requirePlainObject(input, "queue state");
  if (input.version === 1) {
    return {
      state: migrateQueueStateV1ToV2(input, { policyActivatedAt, migratedAt }),
      migrated: true,
      sourceVersion: 1,
      backupRequired: true,
    };
  }
  if (input.version === PR_REVIEW_QUEUE_STATE_SCHEMA_VERSION) {
    assertQueueStateV2(input);
    return {
      state: cloneJson(input),
      migrated: false,
      sourceVersion: PR_REVIEW_QUEUE_STATE_SCHEMA_VERSION,
      backupRequired: false,
    };
  }
  throw new Error(
    `state_corruption: unsupported queue state version ${String(input.version)}`,
  );
}

export function extractLegacyRequestEvidence(
  entries,
  { repo, prNumber, reviewer = "codex" },
) {
  requireRecordMap(entries, "queue state entries");
  const normalizedRepo = requireNonEmptyString(repo, "repo");
  const normalizedPrNumber = requirePositiveInteger(prNumber, "prNumber");
  const normalizedReviewer = requireNonEmptyString(
    reviewer,
    "reviewer",
  ).toLowerCase();
  return Object.entries(entries)
    .filter(([, entry]) => {
      return (
        entry.repo === normalizedRepo &&
        Number(entry.pr_number) === normalizedPrNumber &&
        String(entry.reviewer ?? "").toLowerCase() === normalizedReviewer
      );
    })
    .map(([entryKey, entry]) => ({
      entry_key: entryKey,
      head_sha: entry.head_sha ?? null,
      request: cloneJson(entry.request ?? null),
      review_request_state: cloneJson(entry.review_request_state ?? null),
      timeout_retry: cloneJson(entry.timeout_retry ?? null),
      terminal_clear: cloneJson(entry.terminal_clear ?? null),
    }))
    .filter((evidence) => {
      return (
        evidence.request !== null ||
        evidence.review_request_state !== null ||
        evidence.timeout_retry !== null ||
        evidence.terminal_clear !== null
      );
    })
    .sort((left, right) => left.entry_key.localeCompare(right.entry_key));
}

export function createReviewPolicy({
  repositoryId,
  pullRequestId,
  repo,
  prNumber,
  branch,
  reviewer = "codex",
  prCreatedAt,
  policyActivatedAt,
  historicalReviewCount,
  historicalReviewIds = [],
  createdAt = policyActivatedAt,
  legacyRequestEvidence = [],
}) {
  const normalizedRepositoryId = requireNonEmptyString(
    repositoryId,
    "repositoryId",
  );
  const normalizedPullRequestId = requireNonEmptyString(
    pullRequestId,
    "pullRequestId",
  );
  const normalizedRepo = requireNonEmptyString(repo, "repo");
  const normalizedPrNumber = requirePositiveInteger(prNumber, "prNumber");
  const normalizedBranch = requireNonEmptyString(branch, "branch");
  const normalizedReviewer = requireNonEmptyString(
    reviewer,
    "reviewer",
  ).toLowerCase();
  const normalizedCreatedAt = requireIsoTimestamp(createdAt, "createdAt");
  const activatedAt = requireIsoTimestamp(
    policyActivatedAt,
    "policyActivatedAt",
  );
  const normalizedPrCreatedAt = requireIsoTimestamp(prCreatedAt, "prCreatedAt");
  const reviewIds = normalizeHistoricalReviewIds(historicalReviewIds);
  const reviewCount =
    historicalReviewCount === undefined
      ? reviewIds.length
      : requireNonNegativeInteger(
          historicalReviewCount,
          "historicalReviewCount",
        );
  if (reviewCount < reviewIds.length) {
    throw new Error(
      "historicalReviewCount cannot be smaller than the unique historical review id count",
    );
  }
  if (!Array.isArray(legacyRequestEvidence)) {
    throw new Error("legacyRequestEvidence must be an array");
  }
  const epochType = determineReviewEpochType({
    prCreatedAt: normalizedPrCreatedAt,
    policyActivatedAt: activatedAt,
  });
  const limits = DEFAULT_REVIEW_BUDGETS[epochType];
  const policy = {
    policy_key: buildReviewPolicyKey({
      repositoryId: normalizedRepositoryId,
      pullRequestId: normalizedPullRequestId,
      reviewer: normalizedReviewer,
    }),
    repository_id: normalizedRepositoryId,
    pull_request_id: normalizedPullRequestId,
    repo: normalizedRepo,
    pr_number: normalizedPrNumber,
    branch: normalizedBranch,
    reviewer: normalizedReviewer,
    state_schema_version: PR_REVIEW_QUEUE_STATE_SCHEMA_VERSION,
    policy_version: PR_REVIEW_POLICY_VERSION,
    report_schema_version: PR_REVIEW_REPORT_SCHEMA_VERSION,
    epoch_type: epochType,
    policy_activated_at: activatedAt,
    pr_created_at: normalizedPrCreatedAt,
    epoch_started_at: normalizedCreatedAt,
    historical_review_count: reviewCount,
    historical_review_ids: reviewIds,
    review_budget: {
      initial_full_limit: limits.initial_full,
      targeted_closure_limit: limits.targeted_closure,
      initial_full_used: 0,
      targeted_closure_used: 0,
      initial_full_remaining: limits.initial_full,
      targeted_closure_remaining: limits.targeted_closure,
      total_remaining: limits.initial_full + limits.targeted_closure,
    },
    external_review_generations_used: { full: 0, targeted: 0, total: 0 },
    external_review_generations_remaining: {
      full: limits.initial_full,
      targeted: limits.targeted_closure,
      total: limits.initial_full + limits.targeted_closure,
    },
    last_full_review_head_sha: null,
    last_targeted_review_base_sha: null,
    last_targeted_review_head_sha: null,
    current_request_cycle_id: null,
    current_actionable_fingerprint: null,
    root_cause_cluster_fingerprints: [],
    exact_review_request_comment_body: null,
    request_timestamp: null,
    github_comment_id: null,
    current_request: null,
    latest_terminal_result: null,
    budget_exhaustion_reason: null,
    selected_local_worker_profile: null,
    merge_blockers: [],
    external_review_generations: [],
    owner_overrides: [],
    legacy_request_evidence: cloneJson(legacyRequestEvidence),
    current_head_sha: null,
    current_base_sha: null,
    updated_at: normalizedCreatedAt,
  };
  assertReviewPolicy(policy);
  return policy;
}

const CURRENT_REQUEST_STATUSES = new Set([
  "reserved",
  "confirmed",
  "timed_out",
  "legacy_adopted_pending",
  "clear",
  "findings",
]);

// A persisted request must be well-formed, bound to the cycle pointer, and a
// terminal result must match its charged generation (or be an uncharged
// adopted legacy request).
function assertCurrentRequest(policy) {
  const request = policy.current_request;
  if (request === null || request === undefined) {
    if (policy.current_request_cycle_id !== null && policy.current_request_cycle_id !== undefined) {
      throw new Error("state_corruption: current_request_cycle_id has no current_request");
    }
    return;
  }
  requirePlainObject(request, "review policy current_request");
  if (!CURRENT_REQUEST_STATUSES.has(request.status)) {
    throw new Error("state_corruption: current_request status is unsupported");
  }
  const cycleId = requireMarkerToken(request.cycle_id, "current_request.cycle_id");
  requireMarkerToken(request.head_sha, "current_request.head_sha");
  if (
    request.request_type !== REVIEW_REQUEST_INITIAL_FULL &&
    request.request_type !== REVIEW_REQUEST_TARGETED_CLOSURE
  ) {
    throw new Error("state_corruption: current_request type is unsupported");
  }
  const requestedAt = requireIsoTimestamp(
    request.request_timestamp,
    "current_request.request_timestamp",
  );
  if (policy.current_request_cycle_id !== cycleId) {
    throw new Error("state_corruption: current_request does not match current_request_cycle_id");
  }
  if (request.status === "clear" || request.status === "findings") {
    const generation = policy.external_review_generations.find(
      (candidate) => candidate.cycle_id === cycleId,
    );
    // Only an uncharged targeted request adopted from before policy
    // activation may hold a terminal result without a generation.
    const bound = generation
      ? generation.head_sha === request.head_sha && generation.status === request.status
      : request.budget_charged === false &&
        request.request_type === REVIEW_REQUEST_TARGETED_CLOSURE &&
        Date.parse(requestedAt) < Date.parse(policy.policy_activated_at);
    if (!bound) {
      throw new Error("state_corruption: terminal current_request has no matching generation");
    }
  }
}

export function assertReviewPolicy(
  policy,
  { allowLegacyIdentity = false } = {},
) {
  requirePlainObject(policy, "review policy");
  const hasRepositoryId = Object.hasOwn(policy, "repository_id");
  const hasPullRequestId = Object.hasOwn(policy, "pull_request_id");
  if (hasRepositoryId !== hasPullRequestId) {
    throw new Error(
      "state_corruption: review policy immutable identity is incomplete",
    );
  }
  for (const field of REQUIRED_REVIEW_POLICY_FIELDS) {
    if (
      allowLegacyIdentity &&
      !hasRepositoryId &&
      (field === "repository_id" || field === "pull_request_id")
    ) {
      continue;
    }
    if (!Object.hasOwn(policy, field)) {
      throw new Error(`state_corruption: review policy is missing ${field}`);
    }
  }
  if (policy.state_schema_version !== PR_REVIEW_QUEUE_STATE_SCHEMA_VERSION) {
    throw new Error(
      "state_corruption: review policy state schema version is unsupported",
    );
  }
  if (policy.policy_version !== PR_REVIEW_POLICY_VERSION) {
    throw new Error("state_corruption: review policy version is unsupported");
  }
  if (policy.report_schema_version !== PR_REVIEW_REPORT_SCHEMA_VERSION) {
    throw new Error(
      "state_corruption: review policy report schema version is unsupported",
    );
  }
  if (!hasRepositoryId && !allowLegacyIdentity) {
    throw new Error(
      "state_corruption: review policy immutable identity is missing",
    );
  }
  const expectedKey = hasRepositoryId
    ? buildReviewPolicyKey({
        repositoryId: policy.repository_id,
        pullRequestId: policy.pull_request_id,
        reviewer: policy.reviewer,
      })
    : buildLegacyReviewPolicyKey({
        repo: policy.repo,
        prNumber: policy.pr_number,
        reviewer: policy.reviewer,
      });
  if (policy.policy_key !== expectedKey) {
    throw new Error(
      "state_corruption: review policy key does not match its PR identity",
    );
  }
  if (
    policy.epoch_type !== REVIEW_EPOCH_NORMAL &&
    policy.epoch_type !== REVIEW_EPOCH_LEGACY_CLOSURE
  ) {
    throw new Error(
      "state_corruption: review policy epoch type is unsupported",
    );
  }
  requireNonEmptyString(policy.branch, "review policy branch");
  requireNonEmptyString(policy.repo, "review policy repo");
  requirePositiveInteger(policy.pr_number, "review policy pr_number");
  requireNonEmptyString(policy.reviewer, "review policy reviewer");
  requireIsoTimestamp(
    policy.policy_activated_at,
    "review policy policy_activated_at",
  );
  requireIsoTimestamp(policy.pr_created_at, "review policy pr_created_at");
  requireIsoTimestamp(
    policy.epoch_started_at,
    "review policy epoch_started_at",
  );
  requireIsoTimestamp(policy.updated_at, "review policy updated_at");
  requireNonNegativeInteger(
    policy.historical_review_count,
    "historical_review_count",
  );
  requirePlainObject(policy.review_budget, "review policy review_budget");
  const synchronizedBudget = generationBudgetFields(policy);
  if (
    JSON.stringify(policy.review_budget) !==
      JSON.stringify(synchronizedBudget.review_budget) ||
    JSON.stringify(policy.external_review_generations_used) !==
      JSON.stringify(synchronizedBudget.external_review_generations_used) ||
    JSON.stringify(policy.external_review_generations_remaining) !==
      JSON.stringify(synchronizedBudget.external_review_generations_remaining)
  ) {
    throw new Error(
      "state_corruption: review policy generation budget summaries disagree",
    );
  }
  if (!Array.isArray(policy.historical_review_ids)) {
    throw new Error("state_corruption: historical_review_ids must be an array");
  }
  if (!Array.isArray(policy.root_cause_cluster_fingerprints)) {
    throw new Error(
      "state_corruption: root_cause_cluster_fingerprints must be an array",
    );
  }
  if (!Array.isArray(policy.merge_blockers)) {
    throw new Error("state_corruption: merge_blockers must be an array");
  }
  if (!Array.isArray(policy.external_review_generations)) {
    throw new Error(
      "state_corruption: external_review_generations must be an array",
    );
  }
  const generationUsage = { full: 0, targeted: 0, total: 0 };
  const validatedGenerations = policy.external_review_generations.map(
    (generation, index) => assertExternalReviewGeneration(generation, index),
  );
  for (const generation of validatedGenerations) {
    if (generation.requestType === REVIEW_REQUEST_INITIAL_FULL) {
      generationUsage.full += 1;
    } else {
      generationUsage.targeted += 1;
    }
    generationUsage.total += 1;
  }
  if (
    generationUsage.full !==
      synchronizedBudget.external_review_generations_used.full ||
    generationUsage.targeted !==
      synchronizedBudget.external_review_generations_used.targeted ||
    generationUsage.total !==
      synchronizedBudget.external_review_generations_used.total
  ) {
    throw new Error(
      "state_corruption: external review generation request types disagree with budget usage",
    );
  }
  for (const generation of policy.external_review_generations) {
    if (generation.trigger_kind === "automatic_initial_pr_open"
      && (policy.epoch_type !== REVIEW_EPOCH_NORMAL || policy.reviewer !== "codex"
        || generation.automatic_trigger_evidence.repository_id !== policy.repository_id
        || generation.automatic_trigger_evidence.pull_request_id !== policy.pull_request_id
        || generation.automatic_trigger_evidence.pr_created_at !== policy.pr_created_at)) {
      throw new Error("state_corruption: automatic trigger policy identity mismatch");
    }
  }
  const generationCycleIds = validatedGenerations.map(
    (generation) => generation.cycleId,
  );
  if (new Set(generationCycleIds).size !== generationCycleIds.length) {
    throw new Error(
      "state_corruption: external review generation cycle IDs must be unique",
    );
  }
  const generationCommentIds = validatedGenerations.map(
    (generation) => generation.githubCommentId,
  );
  if (new Set(generationCommentIds).size !== generationCommentIds.length) {
    throw new Error(
      "state_corruption: external review generation comment IDs must be unique",
    );
  }
  const generationReviewIds = validatedGenerations
    .map((generation) => generation.reviewSubmissionId)
    .filter((reviewId) => reviewId !== null);
  if (new Set(generationReviewIds).size !== generationReviewIds.length) {
    throw new Error(
      "state_corruption: external review generation submission IDs must be unique",
    );
  }
  if (!Array.isArray(policy.owner_overrides)) {
    throw new Error("state_corruption: owner_overrides must be an array");
  }
  assertOwnerOverrideLedger(policy);
  assertCurrentRequest(policy);
  if (!Array.isArray(policy.legacy_request_evidence)) {
    throw new Error(
      "state_corruption: legacy_request_evidence must be an array",
    );
  }
  if (
    policy.identity_migrations !== undefined &&
    !Array.isArray(policy.identity_migrations)
  ) {
    throw new Error(
      "state_corruption: identity_migrations must be an array when present",
    );
  }
  return true;
}

export function ensureReviewPolicy(state, input) {
  assertQueueStateV2(state);
  const key = buildReviewPolicyKey(input);
  const nextState = cloneJson(state);
  const normalizedReviewer = requireNonEmptyString(
    input.reviewer ?? "codex",
    "reviewer",
  ).toLowerCase();
  const normalizedRepo = requireNonEmptyString(input.repo, "repo");
  const normalizedPrNumber = requirePositiveInteger(input.prNumber, "prNumber");
  const immutableIdentityConflicts = Object.values(nextState.policies).filter(
    (policy) => {
      if (
        !Object.hasOwn(policy, "repository_id") ||
        String(policy.reviewer).toLowerCase() !== normalizedReviewer
      ) {
        return false;
      }
      const sameDiagnosticIdentity =
        policy.repo === normalizedRepo &&
        Number(policy.pr_number) === normalizedPrNumber;
      const samePullRequestId =
        policy.pull_request_id === String(input.pullRequestId).trim();
      const sameRepositoryAndNumber =
        policy.repository_id === String(input.repositoryId).trim() &&
        Number(policy.pr_number) === normalizedPrNumber;
      return (
        (sameDiagnosticIdentity ||
          samePullRequestId ||
          sameRepositoryAndNumber) &&
        policy.policy_key !== key
      );
    },
  );
  if (immutableIdentityConflicts.length > 0) {
    throw new Error(
      "state_corruption: review policy immutable identity mismatch",
    );
  }

  const existing = nextState.policies[key];
  if (existing) {
    const staleAliasKeys = new Set(
      cloneJson(existing.identity_migrations ?? []).map(
        (migration) => migration?.from_policy_key,
      ),
    );
    if (
      Object.keys(nextState.policies).some(
        (policyKey) => policyKey !== key && staleAliasKeys.has(policyKey),
      )
    ) {
      throw new Error(
        "state_corruption: migrated review policy and its legacy alias both exist",
      );
    }
    const refreshed = refreshReviewPolicyMetadata(existing, {
      repositoryId: input.repositoryId,
      pullRequestId: input.pullRequestId,
      repo: input.repo,
      prNumber: input.prNumber,
      branch: input.branch,
      headSha: input.headSha,
      baseSha: input.baseSha,
      updatedAt: input.updatedAt ?? existing.updated_at,
    });
    nextState.policies[key] = refreshed;
    return {
      state: nextState,
      policy: cloneJson(refreshed),
      key,
      created: false,
    };
  }

  const legacyKey = buildLegacyReviewPolicyKey(input);
  const exactLegacy = nextState.policies[legacyKey];
  const legacyCandidates = Object.entries(nextState.policies).filter(
    ([, policy]) =>
      !Object.hasOwn(policy, "repository_id") &&
      String(policy.reviewer).toLowerCase() === normalizedReviewer &&
      Number(policy.pr_number) === normalizedPrNumber,
  );
  let legacyEntry = exactLegacy ? [legacyKey, exactLegacy] : null;
  if (!legacyEntry && legacyCandidates.length === 1) {
    legacyEntry = legacyCandidates[0];
  } else if (!legacyEntry && legacyCandidates.length > 1) {
    throw new Error(
      "state_corruption: legacy review policy identity migration is ambiguous",
    );
  }
  if (legacyEntry) {
    const [previousKey, legacyPolicy] = legacyEntry;
    const migratedAt = requireIsoTimestamp(
      input.updatedAt ?? legacyPolicy.updated_at,
      "updatedAt",
    );
    const migratedPolicy = {
      ...cloneJson(legacyPolicy),
      policy_key: key,
      repository_id: requireNonEmptyString(input.repositoryId, "repositoryId"),
      pull_request_id: requireNonEmptyString(
        input.pullRequestId,
        "pullRequestId",
      ),
      repo: normalizedRepo,
      pr_number: normalizedPrNumber,
      identity_migrations: [
        ...cloneJson(legacyPolicy.identity_migrations ?? []),
        {
          from_policy_key: previousKey,
          to_policy_key: key,
          migrated_at: migratedAt,
          repository_id: String(input.repositoryId).trim(),
          pull_request_id: String(input.pullRequestId).trim(),
          previous_repo: legacyPolicy.repo,
          previous_pr_number: legacyPolicy.pr_number,
        },
      ],
    };
    const refreshed = refreshReviewPolicyMetadata(migratedPolicy, {
      repositoryId: input.repositoryId,
      pullRequestId: input.pullRequestId,
      repo: input.repo,
      prNumber: input.prNumber,
      branch: input.branch,
      headSha: input.headSha,
      baseSha: input.baseSha,
      updatedAt: migratedAt,
    });
    delete nextState.policies[previousKey];
    nextState.policies[key] = refreshed;
    return {
      state: nextState,
      policy: cloneJson(refreshed),
      key,
      previousKey,
      created: false,
      identityMigrated: true,
    };
  }
  const legacyRequestEvidence = extractLegacyRequestEvidence(
    nextState.entries,
    input,
  );
  const policy = createReviewPolicy({
    ...input,
    policyActivatedAt: nextState.policy_activated_at,
    legacyRequestEvidence,
  });
  const refreshed = refreshReviewPolicyMetadata(policy, {
    repositoryId: input.repositoryId,
    pullRequestId: input.pullRequestId,
    repo: input.repo,
    prNumber: input.prNumber,
    branch: input.branch,
    headSha: input.headSha,
    baseSha: input.baseSha,
    updatedAt: input.updatedAt ?? policy.updated_at,
  });
  nextState.policies[key] = refreshed;
  return { state: nextState, policy: cloneJson(refreshed), key, created: true };
}

export function refreshReviewPolicyMetadata(
  policy,
  {
    repositoryId,
    pullRequestId,
    repo,
    prNumber,
    branch,
    headSha,
    baseSha,
    updatedAt = policy.updated_at,
  },
) {
  assertReviewPolicy(policy);
  const next = cloneJson(policy);
  if (
    repositoryId !== undefined &&
    requireNonEmptyString(repositoryId, "repositoryId") !== policy.repository_id
  ) {
    throw new Error(
      "state_corruption: review policy repository identity changed",
    );
  }
  if (
    pullRequestId !== undefined &&
    requireNonEmptyString(pullRequestId, "pullRequestId") !==
      policy.pull_request_id
  ) {
    throw new Error(
      "state_corruption: review policy pull-request identity changed",
    );
  }
  if (repo !== undefined) {
    next.repo = requireNonEmptyString(repo, "repo");
  }
  if (prNumber !== undefined) {
    next.pr_number = requirePositiveInteger(prNumber, "prNumber");
  }
  if (branch !== undefined) {
    next.branch = requireNonEmptyString(branch, "branch");
  }
  if (headSha !== undefined) {
    next.current_head_sha = normalizeNullableMarkerToken(headSha, "headSha");
  }
  if (baseSha !== undefined) {
    next.current_base_sha = normalizeNullableMarkerToken(baseSha, "baseSha");
  }
  next.updated_at = requireIsoTimestamp(updatedAt, "updatedAt");
  assertReviewPolicy(next);
  return next;
}

export function reviewBudgetSummary(policy) {
  assertReviewPolicy(policy);
  return cloneJson(generationBudgetFields(policy));
}

export function canRequestExternalReview(policy, requestType) {
  assertReviewPolicy(policy);
  const normalizedType = normalizeRequestType(requestType);
  const budget = generationBudgetFields(policy).review_budget;
  return normalizedType === REVIEW_REQUEST_INITIAL_FULL
    ? budget.initial_full_remaining > 0
    : budget.targeted_closure_remaining > 0;
}

export function isDuplicateReviewRequest(
  policy,
  { cycleId, headSha, commentBody },
) {
  assertReviewPolicy(policy);
  const normalized = {
    cycleId: requireMarkerToken(cycleId, "cycleId"),
    headSha: requireMarkerToken(headSha, "headSha"),
    commentBody: requireNonEmptyString(commentBody, "commentBody"),
  };
  if (generationMatchesRequest(policy.current_request, normalized)) {
    return true;
  }
  return policy.external_review_generations.some((generation) =>
    generationMatchesRequest(generation, normalized),
  );
}

export function adoptLegacyPendingReviewRequest(
  policy,
  {
    cycleId,
    headSha,
    baseSha = "none",
    commentBody,
    requestedAt,
    githubCommentId = null,
    preActivationTerminalResults = [],
  },
) {
  assertReviewPolicy(policy);
  if (policy.epoch_type !== REVIEW_EPOCH_LEGACY_CLOSURE) {
    throw new Error(
      "only a legacy_closure policy may adopt a pre-policy request",
    );
  }
  if (policy.current_request !== null) {
    return { policy: cloneJson(policy), adopted: false };
  }
  const normalizedRequestedAt = requireIsoTimestamp(requestedAt, "requestedAt");
  if (
    Date.parse(normalizedRequestedAt) >= Date.parse(policy.policy_activated_at)
  ) {
    throw new Error("a legacy adopted request must predate policy activation");
  }
  if (!Array.isArray(preActivationTerminalResults)) {
    throw new Error("preActivationTerminalResults must be an array");
  }
  const normalizedHeadSha = requireMarkerToken(headSha, "headSha");
  const requestTimestamp = Date.parse(normalizedRequestedAt);
  const activationTimestamp = Date.parse(policy.policy_activated_at);
  const completedBeforeActivation = preActivationTerminalResults.some(
    (terminalResult) => {
      if (!isPlainObject(terminalResult)) {
        throw new Error("pre-activation terminal result must be an object");
      }
      const terminalHeadSha = normalizeNullableMarkerToken(
        terminalResult.head_sha,
        "pre-activation terminal result head_sha",
      );
      if (terminalHeadSha !== normalizedHeadSha) {
        return false;
      }
      const recordedAt = requireIsoTimestamp(
        terminalResult.recorded_at,
        "pre-activation terminal result recorded_at",
      );
      const terminalTimestamp = Date.parse(recordedAt);
      return (
        terminalTimestamp >= requestTimestamp &&
        terminalTimestamp < activationTimestamp
      );
    },
  );
  if (completedBeforeActivation) {
    return {
      policy: cloneJson(policy),
      adopted: false,
      reason: "pre_activation_terminal_result",
    };
  }
  const request = {
    cycle_id: requireMarkerToken(cycleId, "cycleId"),
    request_type: REVIEW_REQUEST_TARGETED_CLOSURE,
    base_sha: requireMarkerToken(baseSha, "baseSha"),
    head_sha: normalizedHeadSha,
    request_comment_body: requireNonEmptyString(commentBody, "commentBody"),
    request_timestamp: normalizedRequestedAt,
    github_comment_id: normalizeCommentId(githubCommentId),
    status: "legacy_adopted_pending",
    budget_charged: false,
  };
  const next = cloneJson(policy);
  next.current_request = request;
  next.current_request_cycle_id = request.cycle_id;
  next.exact_review_request_comment_body = request.request_comment_body;
  next.request_timestamp = request.request_timestamp;
  next.github_comment_id = request.github_comment_id;
  next.updated_at = policy.updated_at;
  assertReviewPolicy(next);
  return { policy: next, adopted: true };
}

// Placeholder: pin the exact reviewer app identity (login, numeric ID, and
// node ID) that your repository trusts before using automatic attribution.
const AUTOMATIC_REVIEW_ACTOR = Object.freeze({
  login: "example-reviewer[bot]", id: 123456, node_id: "BOT_example",
});

function assertAutomaticInitialEvidence(generation) {
  const evidence = requirePlainObject(generation.automatic_trigger_evidence, "automatic trigger evidence");
  const sameActor = actor => actor?.login === AUTOMATIC_REVIEW_ACTOR.login
    && actor?.id === AUTOMATIC_REVIEW_ACTOR.id && actor?.node_id === AUTOMATIC_REVIEW_ACTOR.node_id;
  const trigger = /\|[^\n]*\*\*Running\*\* since <relative-time datetime="([^"]+)">[^<]+<\/relative-time> \| `([a-f0-9]{7,40})` \| PR opened \|/u.exec(generation.request_comment_body);
  if (generation.request_type !== REVIEW_REQUEST_INITIAL_FULL || generation.base_sha !== null
    || !/^[a-f0-9]{40}$/u.test(generation.head_sha) || !trigger
    || !generation.request_comment_body.startsWith("<!-- codex-pull-request-review-summary -->")
    || !generation.head_sha.startsWith(trigger[2]) || requireIsoTimestamp(trigger[1], "automatic trigger timestamp") !== generation.request_timestamp
    || !sameActor(evidence.summary_actor) || !sameActor(evidence.review_actor)
    || evidence.owner_request !== false || evidence.repository_id === undefined || evidence.pull_request_id === undefined
    || evidence.summary_comment_id !== generation.github_comment_id
    || evidence.review_submission_id !== generation.review_submission_id
    || evidence.reviewed_head_sha !== generation.head_sha
    || !/^[a-f0-9]{64}$/u.test(evidence.original_snapshot_sha256 ?? "")
    || !/^[a-f0-9]{64}$/u.test(evidence.submission_snapshot_sha256 ?? "")
    || evidence.summary_created_at !== evidence.summary_updated_at) {
    throw new Error("invalid automatic initial review evidence");
  }
  for (const value of [evidence.summary_created_at, evidence.original_captured_at,
    evidence.submitted_at, evidence.submission_captured_at]) requireIsoTimestamp(value, "automatic evidence timestamp");
  if (Date.parse(generation.request_timestamp) < Date.parse(evidence.pr_created_at)
    || Date.parse(evidence.summary_created_at) < Date.parse(generation.request_timestamp)
    || Date.parse(evidence.original_captured_at) < Date.parse(evidence.summary_created_at)
    || Date.parse(evidence.original_captured_at) >= Date.parse(evidence.submitted_at)
    || Date.parse(evidence.submitted_at) > Date.parse(evidence.submission_captured_at)
    || evidence.summary_created_at !== generation.confirmed_at) {
    throw new Error("invalid automatic initial review chronology");
  }
}

/** Account a retained authenticated PR-open trigger, never infer one from a
 * rolling summary or an unmatched submission. Callers authenticate the original
 * snapshots outside this policy and persist the returned state under both locks.
 * Running/Completed summary text cannot establish a clear terminal result. */
export function recordConfirmedAutomaticInitialReview(policy, {
  cycleId, originalSnapshotJson, submissionSnapshotJson, summaryCommentId, reviewSubmissionId,
}) {
  assertReviewPolicy(policy);
  if (policy.epoch_type !== REVIEW_EPOCH_NORMAL || policy.reviewer !== "codex") {
    throw new Error("automatic initial review requires the normal reviewer epoch");
  }
  const originalBytes = requireNonEmptyString(originalSnapshotJson, "originalSnapshotJson");
  const submissionBytes = requireNonEmptyString(submissionSnapshotJson, "submissionSnapshotJson");
  const original = JSON.parse(originalBytes), submitted = JSON.parse(submissionBytes);
  for (const snapshot of [original, submitted]) {
    if (snapshot.pullRequest?.node_id !== policy.pull_request_id
      || snapshot.pullRequest?.base?.repo?.node_id !== policy.repository_id
      || requireIsoTimestamp(snapshot.pullRequest?.created_at, "snapshot PR creation") !== policy.pr_created_at) {
      throw new Error("automatic initial review snapshot identity mismatch");
    }
  }
  const summaryId = normalizeCommentId(summaryCommentId), reviewId = normalizeCommentId(reviewSubmissionId);
  if (!summaryId || !reviewId) throw new Error("automatic review immutable IDs required");
  const summaries = (original.issueComments ?? []).filter(item => String(item.id) === summaryId);
  const reviews = (submitted.reviews ?? []).filter(item => String(item.id) === reviewId);
  if (summaries.length !== 1 || reviews.length !== 1) throw new Error("automatic review evidence missing or ambiguous");
  const summary = summaries[0], review = reviews[0];
  const trigger = /datetime="([^"]+)"/u.exec(summary.body ?? "");
  if (original.pullRequest.head?.sha !== review.commit_id || !trigger) {
    throw new Error("automatic review original head mismatch");
  }
  const evidence = {
    repository_id: policy.repository_id, pull_request_id: policy.pull_request_id,
    owner_request: false, summary_comment_id: summaryId, review_submission_id: reviewId,
    summary_actor: { login: summary.user?.login, id: summary.user?.id, node_id: summary.user?.node_id },
    review_actor: { login: review.user?.login, id: review.user?.id, node_id: review.user?.node_id },
    reviewed_head_sha: review.commit_id, pr_created_at: policy.pr_created_at,
    summary_created_at: requireIsoTimestamp(summary.created_at, "summary creation"),
    summary_updated_at: requireIsoTimestamp(summary.updated_at, "summary update"),
    original_captured_at: original.capturedAt, submitted_at: review.submitted_at,
    submission_captured_at: submitted.capturedAt,
    original_snapshot_sha256: createHash("sha256").update(originalBytes).digest("hex"),
    submission_snapshot_sha256: createHash("sha256").update(submissionBytes).digest("hex"),
    review_body: review.body, review_state: review.state,
    findings: cloneJson((submitted.comments ?? []).filter(item => String(item.pull_request_review_id) === reviewId)),
  };
  const generation = {
    cycle_id: requireMarkerToken(cycleId, "cycleId"), request_type: REVIEW_REQUEST_INITIAL_FULL,
    base_sha: null, head_sha: review.commit_id, request_comment_body: summary.body,
    request_timestamp: requireIsoTimestamp(trigger[1], "automatic trigger timestamp"), github_comment_id: summaryId, status: "confirmed",
    confirmed_at: evidence.summary_created_at, review_submission_id: reviewId,
    trigger_kind: "automatic_initial_pr_open", automatic_trigger_evidence: evidence,
  };
  assertAutomaticInitialEvidence(generation);
  const existing = policy.external_review_generations.find(item => item.cycle_id === generation.cycle_id
    || item.github_comment_id === summaryId || item.review_submission_id === reviewId
    || item.request_type === REVIEW_REQUEST_INITIAL_FULL);
  if (existing) {
    if (existing.trigger_kind !== generation.trigger_kind || existing.cycle_id !== generation.cycle_id
      || existing.request_comment_body !== generation.request_comment_body
      || JSON.stringify(existing.automatic_trigger_evidence) !== JSON.stringify(evidence)) {
      throw new Error("conflicting automatic initial review attribution");
    }
    return { policy: cloneJson(policy), charged: false, recovered: true };
  }
  if (!canRequestExternalReview(policy, REVIEW_REQUEST_INITIAL_FULL)
    || policy.current_request && ["reserved", "confirmed"].includes(policy.current_request.status)) {
    throw new Error("automatic initial review allowance unavailable or request pending");
  }
  const next = cloneJson(policy);
  next.current_request = { ...generation, status: "reserved", github_comment_id: null };
  next.current_request_cycle_id = generation.cycle_id;
  next.exact_review_request_comment_body = summary.body;
  next.request_timestamp = generation.request_timestamp;
  next.github_comment_id = null;
  // Use the ordinary confirmed-trigger charging and terminal primitives.
  let confirmed = confirmReviewTrigger(next, { cycleId: generation.cycle_id,
    githubCommentId: summaryId, confirmedAt: summary.created_at }).policy;
  if (evidence.findings.length) confirmed = recordReviewCycleTerminalResult(confirmed, {
    cycleId: generation.cycle_id, headSha: generation.head_sha, result: "findings",
    recordedAt: review.submitted_at, evidence,
  });
  assertReviewPolicy(confirmed);
  return { policy: confirmed, charged: true, recovered: false };
}

export function reserveReviewRequestCycle(
  policy,
  { cycleId, requestType, headSha, baseSha = null, commentBody, requestedAt },
) {
  assertReviewPolicy(policy);
  const normalizedCycleId = requireMarkerToken(cycleId, "cycleId");
  const normalizedType = normalizeRequestType(requestType);
  const normalizedHeadSha = requireMarkerToken(headSha, "headSha");
  const normalizedBaseSha = normalizeNullableMarkerToken(baseSha, "baseSha");
  const normalizedBody = requireNonEmptyString(commentBody, "commentBody");
  const normalizedRequestedAt = requireIsoTimestamp(requestedAt, "requestedAt");
  if (
    normalizedType === REVIEW_REQUEST_INITIAL_FULL &&
    normalizedBaseSha !== null
  ) {
    throw new Error(
      "initial full review requests cannot carry a targeted base SHA",
    );
  }
  if (
    normalizedType === REVIEW_REQUEST_TARGETED_CLOSURE &&
    normalizedBaseSha === null
  ) {
    throw new Error(
      "targeted closure review requests require a base SHA or the literal none",
    );
  }
  const request = {
    cycle_id: normalizedCycleId,
    request_type: normalizedType,
    base_sha: normalizedBaseSha,
    head_sha: normalizedHeadSha,
    request_comment_body: normalizedBody,
    request_timestamp: normalizedRequestedAt,
    github_comment_id: null,
    status: "reserved",
  };
  if (
    isDuplicateReviewRequest(policy, {
      cycleId: normalizedCycleId,
      headSha: normalizedHeadSha,
      commentBody: normalizedBody,
    })
  ) {
    return { policy: cloneJson(policy), reserved: false, duplicate: true };
  }
  if (
    policy.current_request !== null &&
    ["reserved", "confirmed"].includes(policy.current_request.status)
  ) {
    throw new Error(
      `request_cycle_pending: ${policy.current_request.cycle_id}`,
    );
  }
  if (!canRequestExternalReview(policy, normalizedType)) {
    throw new Error(
      `review_budget_exhausted: no ${normalizedType} generation remains`,
    );
  }
  const next = cloneJson(policy);
  next.current_request = request;
  next.current_request_cycle_id = normalizedCycleId;
  next.exact_review_request_comment_body = normalizedBody;
  next.request_timestamp = normalizedRequestedAt;
  next.github_comment_id = null;
  next.updated_at = normalizedRequestedAt;
  assertReviewPolicy(next);
  return { policy: next, reserved: true, duplicate: false };
}

export function confirmReviewTrigger(
  policy,
  { cycleId, githubCommentId, confirmedAt },
) {
  assertReviewPolicy(policy);
  const normalizedCycleId = requireMarkerToken(cycleId, "cycleId");
  const normalizedCommentId = normalizeCommentId(githubCommentId);
  if (normalizedCommentId === null) {
    throw new Error("githubCommentId is required to confirm a review trigger");
  }
  const normalizedConfirmedAt = requireIsoTimestamp(confirmedAt, "confirmedAt");
  const existing = policy.external_review_generations.find(
    (generation) => generation.cycle_id === normalizedCycleId,
  );
  if (existing?.github_comment_id === normalizedCommentId) {
    return { policy: cloneJson(policy), charged: false, recovered: true };
  }
  const current = policy.current_request;
  if (!current || current.cycle_id !== normalizedCycleId) {
    throw new Error(`unknown review request cycle: ${normalizedCycleId}`);
  }
  if (current.status === "confirmed") {
    if (current.github_comment_id !== normalizedCommentId) {
      throw new Error(
        `request cycle ${normalizedCycleId} was confirmed with a different comment id`,
      );
    }
    return { policy: cloneJson(policy), charged: false, recovered: true };
  }
  if (current.status !== "reserved") {
    throw new Error(
      `request cycle ${normalizedCycleId} cannot be confirmed from ${current.status}`,
    );
  }
  if (!canRequestExternalReview(policy, current.request_type)) {
    throw new Error(
      `review_budget_exhausted: no ${current.request_type} generation remains`,
    );
  }
  let next = cloneJson(policy);
  const confirmed = {
    ...next.current_request,
    github_comment_id: normalizedCommentId,
    status: "confirmed",
    confirmed_at: normalizedConfirmedAt,
  };
  next.current_request = confirmed;
  next.github_comment_id = normalizedCommentId;
  next.external_review_generations.push(cloneJson(confirmed));
  if (confirmed.request_type === REVIEW_REQUEST_INITIAL_FULL) {
    next.review_budget.initial_full_used += 1;
  } else {
    next.review_budget.targeted_closure_used += 1;
  }
  next.updated_at = normalizedConfirmedAt;
  next = withSynchronizedBudget(next);
  assertReviewPolicy(next);
  return { policy: next, charged: true, recovered: false };
}

export function chargeConfirmedReviewTrigger(policy, request) {
  const reservation = reserveReviewRequestCycle(policy, request);
  if (!reservation.reserved) {
    const matchingGeneration =
      reservation.policy.external_review_generations.find((generation) =>
        generationMatchesRequest(generation, {
          cycleId: request.cycleId,
          headSha: request.headSha,
          commentBody: request.commentBody,
        }),
      ) ?? null;
    const existingCommentId =
      matchingGeneration?.github_comment_id ??
      (reservation.policy.current_request?.cycle_id === request.cycleId
        ? reservation.policy.current_request.github_comment_id
        : null) ??
      request.githubCommentId;
    return confirmReviewTrigger(reservation.policy, {
      cycleId: request.cycleId,
      githubCommentId: existingCommentId,
      confirmedAt: request.confirmedAt ?? request.requestedAt,
    });
  }
  return confirmReviewTrigger(reservation.policy, {
    cycleId: request.cycleId,
    githubCommentId: request.githubCommentId,
    confirmedAt: request.confirmedAt ?? request.requestedAt,
  });
}

export function markReviewRequestTimedOut(policy, { cycleId, timedOutAt }) {
  assertReviewPolicy(policy);
  const normalizedCycleId = requireMarkerToken(cycleId, "cycleId");
  const normalizedTimedOutAt = requireIsoTimestamp(timedOutAt, "timedOutAt");
  const next = cloneJson(policy);
  if (
    !next.current_request ||
    next.current_request.cycle_id !== normalizedCycleId
  ) {
    throw new Error(`unknown review request cycle: ${normalizedCycleId}`);
  }
  if (
    next.current_request.status !== "confirmed" &&
    next.current_request.status !== "timed_out" &&
    next.current_request.status !== "legacy_adopted_pending"
  ) {
    throw new Error(`request cycle ${normalizedCycleId} was not confirmed`);
  }
  next.current_request.status = "timed_out";
  next.current_request.timed_out_at = normalizedTimedOutAt;
  const generation = next.external_review_generations.find(
    (candidate) => candidate.cycle_id === normalizedCycleId,
  );
  if (generation) {
    generation.status = "timed_out";
    generation.timed_out_at = normalizedTimedOutAt;
  }
  next.latest_terminal_result = {
    cycle_id: normalizedCycleId,
    result: "timeout",
    recorded_at: normalizedTimedOutAt,
  };
  next.updated_at = normalizedTimedOutAt;
  assertReviewPolicy(next);
  return next;
}

function recomputeLastReviewedGenerationHeads(policy) {
  const terminalGenerations = policy.external_review_generations.filter(
    (generation) => ["clear", "findings"].includes(generation.status),
  );
  const latestFull = terminalGenerations
    .filter(
      (generation) => generation.request_type === REVIEW_REQUEST_INITIAL_FULL,
    )
    .at(-1);
  const latestTargeted = terminalGenerations
    .filter(
      (generation) =>
        generation.request_type === REVIEW_REQUEST_TARGETED_CLOSURE,
    )
    .at(-1);
  if (latestFull) {
    policy.last_full_review_head_sha = latestFull.head_sha;
  }
  if (latestTargeted) {
    policy.last_targeted_review_base_sha = latestTargeted.base_sha;
    policy.last_targeted_review_head_sha = latestTargeted.head_sha;
  }
}

function assertClearResultFollowsRequest({ result, recordedAt, requestedAt }) {
  if (result !== "clear") {
    return;
  }
  const normalizedRequestedAt = requireIsoTimestamp(
    requestedAt,
    "review request timestamp",
  );
  if (Date.parse(recordedAt) <= Date.parse(normalizedRequestedAt)) {
    throw new Error(
      "clear terminal result must be strictly later than its review request",
    );
  }
}

function assertTerminalResultNotStale({
  recordedAt,
  result,
  priorRecordedAt,
  priorResult,
  cycleId,
}) {
  if (typeof priorRecordedAt !== "string") {
    return;
  }
  const recordedMs = Date.parse(recordedAt);
  const priorMs = Date.parse(priorRecordedAt);
  if (recordedMs < priorMs) {
    throw new Error(
      `stale terminal review evidence for ${cycleId}: ${recordedAt} predates ${priorRecordedAt}`,
    );
  }
  if (recordedMs === priorMs && result !== priorResult) {
    throw new Error(
      `ambiguous terminal review evidence for ${cycleId}: ${result} and ${priorResult} share ${recordedAt}`,
    );
  }
}

export function recordReviewCycleTerminalResult(
  policy,
  { cycleId, headSha, result, recordedAt, evidence = null },
) {
  assertReviewPolicy(policy);
  const normalizedCycleId = requireMarkerToken(cycleId, "cycleId");
  const normalizedHeadSha = requireMarkerToken(headSha, "headSha");
  const normalizedResult = requireNonEmptyString(result, "result");
  if (!["clear", "findings"].includes(normalizedResult)) {
    throw new Error(`unsupported review terminal result: ${normalizedResult}`);
  }
  const normalizedRecordedAt = requireIsoTimestamp(recordedAt, "recordedAt");
  const next = cloneJson(policy);
  if (
    !next.current_request ||
    next.current_request.cycle_id !== normalizedCycleId ||
    next.current_request.head_sha !== normalizedHeadSha
  ) {
    throw new Error(
      `terminal review evidence does not match current cycle ${normalizedCycleId} at ${normalizedHeadSha}`,
    );
  }
  if (
    !["confirmed", "clear", "findings", "legacy_adopted_pending"].includes(
      next.current_request.status,
    )
  ) {
    throw new Error(
      `request cycle ${normalizedCycleId} cannot become ${normalizedResult} from ${next.current_request.status}`,
    );
  }
  assertClearResultFollowsRequest({
    result: normalizedResult,
    recordedAt: normalizedRecordedAt,
    requestedAt: next.current_request.request_timestamp,
  });
  assertTerminalResultNotStale({
    recordedAt: normalizedRecordedAt,
    result: normalizedResult,
    priorRecordedAt: next.current_request.terminal_result_at,
    priorResult: next.current_request.status,
    cycleId: normalizedCycleId,
  });
  const adoptedLegacyRequest =
    next.current_request.status === "legacy_adopted_pending" &&
    next.current_request.budget_charged === false;
  next.current_request.status = normalizedResult;
  next.current_request.terminal_result_at = normalizedRecordedAt;
  const generation = next.external_review_generations.find(
    (candidate) => candidate.cycle_id === normalizedCycleId,
  );
  if (
    (!generation || generation.head_sha !== normalizedHeadSha) &&
    !adoptedLegacyRequest
  ) {
    throw new Error(
      `state_corruption: confirmed generation ${normalizedCycleId} is missing or has a different head`,
    );
  }
  if (generation) {
    generation.status = normalizedResult;
    generation.terminal_result_at = normalizedRecordedAt;
    generation.terminal_evidence =
      evidence === undefined ? null : cloneJson(evidence);
    recomputeLastReviewedGenerationHeads(next);
  } else if (
    next.current_request.request_type === REVIEW_REQUEST_INITIAL_FULL
  ) {
    next.last_full_review_head_sha = normalizedHeadSha;
  } else {
    next.last_targeted_review_base_sha = next.current_request.base_sha;
    next.last_targeted_review_head_sha = normalizedHeadSha;
  }
  next.latest_terminal_result = {
    cycle_id: normalizedCycleId,
    head_sha: normalizedHeadSha,
    result: normalizedResult,
    recorded_at: normalizedRecordedAt,
    evidence: evidence === undefined ? null : cloneJson(evidence),
  };
  next.updated_at = normalizedRecordedAt;
  assertReviewPolicy(next);
  return next;
}

export function recordExternalReviewGenerationTerminalResult(
  policy,
  { cycleId, headSha, result, recordedAt, evidence = null },
) {
  assertReviewPolicy(policy);
  const normalizedCycleId = requireMarkerToken(cycleId, "cycleId");
  const normalizedHeadSha = requireMarkerToken(headSha, "headSha");
  const normalizedResult = requireNonEmptyString(result, "result");
  if (!["clear", "findings"].includes(normalizedResult)) {
    throw new Error(`unsupported review terminal result: ${normalizedResult}`);
  }
  const normalizedRecordedAt = requireIsoTimestamp(recordedAt, "recordedAt");
  const next = cloneJson(policy);
  const generation = next.external_review_generations.find(
    (candidate) => candidate.cycle_id === normalizedCycleId,
  );
  if (!generation || generation.head_sha !== normalizedHeadSha) {
    throw new Error(
      `unknown external review generation ${normalizedCycleId} at ${normalizedHeadSha}`,
    );
  }
  assertClearResultFollowsRequest({
    result: normalizedResult,
    recordedAt: normalizedRecordedAt,
    requestedAt: generation.request_timestamp,
  });
  assertTerminalResultNotStale({
    recordedAt: normalizedRecordedAt,
    result: normalizedResult,
    priorRecordedAt: generation.terminal_result_at,
    priorResult: generation.status,
    cycleId: normalizedCycleId,
  });
  generation.status = normalizedResult;
  generation.terminal_result_at = normalizedRecordedAt;
  generation.terminal_evidence =
    evidence === undefined ? null : cloneJson(evidence);
  recomputeLastReviewedGenerationHeads(next);
  if (next.current_request?.cycle_id === normalizedCycleId) {
    next.current_request.status = normalizedResult;
    next.current_request.terminal_result_at = normalizedRecordedAt;
    next.latest_terminal_result = {
      cycle_id: normalizedCycleId,
      head_sha: normalizedHeadSha,
      result: normalizedResult,
      recorded_at: normalizedRecordedAt,
      evidence: evidence === undefined ? null : cloneJson(evidence),
    };
  } else {
    next.late_terminal_results = [
      ...(Array.isArray(next.late_terminal_results)
        ? next.late_terminal_results
        : []),
      {
        cycle_id: normalizedCycleId,
        head_sha: normalizedHeadSha,
        result: normalizedResult,
        recorded_at: normalizedRecordedAt,
        evidence: evidence === undefined ? null : cloneJson(evidence),
      },
    ];
  }
  next.updated_at = normalizedRecordedAt;
  assertReviewPolicy(next);
  return next;
}

export function markReviewBudgetExhausted(policy, { reason, recordedAt }) {
  assertReviewPolicy(policy);
  const next = cloneJson(policy);
  next.budget_exhaustion_reason = requireNonEmptyString(reason, "reason");
  next.latest_terminal_result = {
    cycle_id: next.current_request_cycle_id,
    result: "review_budget_exhausted",
    recorded_at: requireIsoTimestamp(recordedAt, "recordedAt"),
  };
  next.merge_blockers = [
    ...new Set([...next.merge_blockers, "review_budget_exhausted"]),
  ];
  next.updated_at = next.latest_terminal_result.recorded_at;
  assertReviewPolicy(next);
  return next;
}

export function grantOneTargetedReviewOverride(
  policy,
  { actor, reason, grantedAt, headSha = policy.current_head_sha },
) {
  assertReviewPolicy(policy);
  const normalizedActor = requireNonEmptyString(actor, "actor");
  const normalizedReason = requireNonEmptyString(reason, "reason");
  const normalizedGrantedAt = requireIsoTimestamp(grantedAt, "grantedAt");
  const normalizedHeadSha = normalizeNullableMarkerToken(headSha, "headSha");
  const overrideId = stableHash({
    policy_key: policy.policy_key,
    actor: normalizedActor,
    reason: normalizedReason,
    granted_at: normalizedGrantedAt,
    head_sha: normalizedHeadSha,
  });
  if (
    policy.owner_overrides.some(
      (override) => override.override_id === overrideId,
    )
  ) {
    return { policy: cloneJson(policy), granted: false, duplicate: true };
  }
  const before =
    generationBudgetFields(policy).external_review_generations_remaining;
  let next = cloneJson(policy);
  next.review_budget.targeted_closure_limit += 1;
  next = withSynchronizedBudget(next);
  const after = cloneJson(next.external_review_generations_remaining);
  next.owner_overrides.push({
    override_id: overrideId,
    kind: "grant_one_targeted_review",
    actor: normalizedActor,
    reason: normalizedReason,
    granted_at: normalizedGrantedAt,
    head_sha: normalizedHeadSha,
    credits_granted: 1,
    budget_remaining_before: cloneJson(before),
    budget_remaining_after: after,
  });
  next.budget_exhaustion_reason = null;
  next.merge_blockers = next.merge_blockers.filter(
    (blocker) => blocker !== "review_budget_exhausted",
  );
  next.updated_at = normalizedGrantedAt;
  assertReviewPolicy(next);
  return { policy: next, granted: true, duplicate: false };
}

export function buildInitialFullReviewComment({ cycleId, headSha }) {
  const normalizedCycleId = requireMarkerToken(cycleId, "cycleId");
  const normalizedHeadSha = requireMarkerToken(headSha, "headSha");
  return [
    "@codex review",
    "",
    "Review consequential correctness and safety defects introduced by this PR.",
    "Follow applicable AGENTS.md review rules.",
    "Group sibling manifestations under one root-cause finding.",
    "Skip style, formatting, and deterministic CI findings.",
    "Do not reopen resolved findings unless the current head reintroduces them with concrete evidence.",
    "",
    `<!-- pr-review-followup:cycle=${normalizedCycleId};type=initial_full;head=${normalizedHeadSha} -->`,
  ].join("\n");
}

export function buildTargetedClosureReviewComment({
  cycleId,
  lastReviewedHeadSha,
  currentHeadSha,
  clusters,
  priorTimedOutRequestHeadSha = null,
}) {
  const normalizedCycleId = requireMarkerToken(cycleId, "cycleId");
  const normalizedBaseSha =
    normalizeNullableMarkerToken(lastReviewedHeadSha, "lastReviewedHeadSha") ??
    "none";
  const normalizedHeadSha = requireMarkerToken(
    currentHeadSha,
    "currentHeadSha",
  );
  const normalizedPriorTimeoutHead = normalizeNullableMarkerToken(
    priorTimedOutRequestHeadSha,
    "priorTimedOutRequestHeadSha",
  );
  if (!Array.isArray(clusters)) {
    throw new Error("clusters must be an array");
  }
  const clusterLines = clusters.map((cluster, index) => {
    if (!isPlainObject(cluster)) {
      throw new Error(`cluster ${index + 1} must be an object`);
    }
    const clusterId = normalizeDisplayLine(
      cluster.id ?? cluster.fingerprint,
      `cluster ${index + 1} id`,
    );
    const invariant = normalizeDisplayLine(
      cluster.governingInvariant ?? cluster.governing_invariant,
      `cluster ${index + 1} governing invariant`,
    );
    return `- ${clusterId}: ${invariant}`;
  });
  if (clusterLines.length === 0) {
    if (normalizedPriorTimeoutHead === null) {
      throw new Error(
        "targeted closure comments require at least one repaired cluster",
      );
    }
    clusterLines.push("- none: this request replaces a timed-out review cycle");
  }
  const scopeLines = [
    `Last externally reviewed head: ${normalizedBaseSha}`,
    `Current head: ${normalizedHeadSha}`,
  ];
  if (normalizedPriorTimeoutHead !== null) {
    scopeLines.push(
      `Prior timed-out request head: ${normalizedPriorTimeoutHead}`,
    );
  }
  return [
    "@codex review",
    "",
    "Targeted closure review.",
    ...scopeLines,
    "",
    "Repaired root-cause clusters and affected invariants:",
    ...clusterLines,
    "",
    "Focus on this delta and directly affected sibling paths.",
    "Do not reopen prior findings without concrete current-head evidence.",
    "Group equivalent manifestations into one root-cause finding.",
    "Report only high-consequence correctness or safety issues.",
    "",
    `<!-- pr-review-followup:cycle=${normalizedCycleId};type=targeted_closure;base=${normalizedBaseSha};head=${normalizedHeadSha} -->`,
  ].join("\n");
}

export function parseReviewRequestMarker(body) {
  const normalizedBody = String(body ?? "");
  if (normalizedBody.split(/\r?\n/u, 1)[0]?.trim() !== "@codex review") {
    return null;
  }
  const matches = [...normalizedBody.matchAll(REQUEST_MARKER_PATTERN)];
  if (matches.length !== 1) {
    return null;
  }
  const [, cycleId, requestType, baseSha, headSha] = matches[0];
  if (
    !MARKER_TOKEN_PATTERN.test(cycleId) ||
    !MARKER_TOKEN_PATTERN.test(headSha)
  ) {
    return null;
  }
  if (requestType === REVIEW_REQUEST_INITIAL_FULL && baseSha !== undefined) {
    return null;
  }
  if (
    requestType === REVIEW_REQUEST_TARGETED_CLOSURE &&
    (baseSha === undefined || !MARKER_TOKEN_PATTERN.test(baseSha))
  ) {
    return null;
  }
  return {
    cycle_id: cycleId,
    request_type: requestType,
    base_sha: baseSha ?? null,
    head_sha: headSha,
  };
}
