/**
 * [AI_CONTEXT]
 * purpose: Define pure review-generation contracts for clustering, exact local scope, bounded context, completion attestation, base revalidation, and worker routing.
 * touches: Autonomous PR-review queue inputs and validation only; this module performs no GitHub, git, filesystem, or worker side effects.
 * invariants: Current findings are assigned exactly once; clusters remain whole; local scope and worker profiles fail closed.
 * inputs: Current-head findings, worker cluster results, diff metadata, environment overrides, and an injected Codex model catalog.
 * outputs: Validated generation descriptors, deterministic fingerprints, bounded context packs, completion evidence, and explicit blockers.
 * see: README.md
 */
import { createHash } from "node:crypto";
import path from "node:path";

export const DEFAULT_RAW_CURRENT_THREAD_LIMIT = 100;
export const DEFAULT_ROOT_CAUSE_CLUSTER_LIMIT = 20;
export const DEFAULT_CONTEXT_PACK_MAX_CHARS = 80_000;
export const MAX_LOCAL_REVIEW_PASSES = 2;
export const GENERATION_COMPLETION_ATTESTATION_VERSION = 1;

export const ROOT_CAUSE_CLASSIFICATIONS = Object.freeze([
  "accepted",
  "invalid",
  "deferred",
  "ambiguous",
]);
export const ROOT_CAUSE_SEVERITIES = Object.freeze(["P0", "P1", "P2", "P3"]);
export const CREDIBLE_ROOT_CAUSE_CLASSIFICATIONS = Object.freeze([
  "accepted",
  "deferred",
  "ambiguous",
]);

export const WORKER_PROFILE_DEFAULTS = Object.freeze({
  normal: Object.freeze({ model: "gpt-5.6-terra", reasoning_effort: "high" }),
  critical: Object.freeze({ model: "gpt-5.6-sol", reasoning_effort: "xhigh" }),
  manual_architecture: Object.freeze({
    model: "gpt-5.6-sol",
    reasoning_effort: "max",
  }),
});

export const CRITICAL_RISK_DOMAINS = Object.freeze([
  "authentication",
  "authorization",
  "platform_permissions",
  "platform_roles",
  "member_removals",
  "member_bans",
  "moderation",
  "migration",
  "backfill",
  "activation",
  "rollback",
  "durable_recovery",
  "distributed_concurrency",
  "leases",
  "locks",
  "fencing",
  "multi_replica",
  "idempotency",
  "duplicate_awards",
  "duplicate_sends",
  "lost_work",
  "data_loss",
  "privacy",
  "retention",
  "sensitive_evidence",
  "currency",
  "rewards",
  "weighted_selection",
  "fairness",
]);

const PROFILE_ENV_KEYS = Object.freeze({
  normal: Object.freeze({
    model: "PR_REVIEW_FOLLOWUP_NORMAL_MODEL",
    reasoning: "PR_REVIEW_FOLLOWUP_NORMAL_REASONING_EFFORT",
  }),
  critical: Object.freeze({
    model: "PR_REVIEW_FOLLOWUP_CRITICAL_MODEL",
    reasoning: "PR_REVIEW_FOLLOWUP_CRITICAL_REASONING_EFFORT",
  }),
  manual_architecture: Object.freeze({
    model: "PR_REVIEW_FOLLOWUP_MANUAL_ARCHITECTURE_MODEL",
    reasoning: "PR_REVIEW_FOLLOWUP_MANUAL_ARCHITECTURE_REASONING_EFFORT",
  }),
});

const RISK_DOMAIN_ALIASES = new Map([
  ["auth", "authentication"],
  ["authn", "authentication"],
  ["authz", "authorization"],
  ["permissions", "platform_permissions"],
  ["permission", "platform_permissions"],
  ["roles", "platform_roles"],
  ["role", "platform_roles"],
  ["kicks", "member_removals"],
  ["kick", "member_removals"],
  ["bans", "member_bans"],
  ["ban", "member_bans"],
  ["migrations", "migration"],
  ["backfills", "backfill"],
  ["rollbacks", "rollback"],
  ["recovery", "durable_recovery"],
  ["concurrency", "distributed_concurrency"],
  ["distributed", "distributed_concurrency"],
  ["lease", "leases"],
  ["lock", "locks"],
  ["multi_replica_behavior", "multi_replica"],
  ["duplicate_award", "duplicate_awards"],
  ["duplicate_send", "duplicate_sends"],
  ["data_loss_risk", "data_loss"],
  ["reward", "rewards"],
  ["weighted", "weighted_selection"],
]);

const CRITICAL_TEXT_PATTERNS = Object.freeze([
  ["authentication", /\bauthentication\b|\bauthn\b/iu],
  ["authorization", /\bauthorization\b|\bauthz\b|\baccess control\b/iu],
  ["platform_permissions", /\b(?:access|platform) permissions?\b/iu],
  ["platform_roles", /\b(?:access|platform) roles?\b|\brole assignment\b/iu],
  ["member_removals", /\bkicks?\b/iu],
  ["member_bans", /\bbans?\b/iu],
  ["moderation", /\bmoderation\b|\bsanctions?\b/iu],
  ["migration", /\bmigrations?\b/iu],
  ["backfill", /\bbackfills?\b/iu],
  ["activation", /\bactivation\b/iu],
  ["rollback", /\brollbacks?\b/iu],
  ["durable_recovery", /\bdurable recovery\b/iu],
  ["distributed_concurrency", /\bdistributed concurrency\b/iu],
  ["leases", /\bleases?\b/iu],
  ["locks", /\blocks?\b/iu],
  ["fencing", /\bfenc(?:e|es|ed|ing)\b/iu],
  ["multi_replica", /\bmulti[- ]replica\b/iu],
  ["idempotency", /\bidempoten(?:cy|t)\b/iu],
  ["duplicate_awards", /\bduplicate awards?\b/iu],
  ["duplicate_sends", /\bduplicate sends?\b/iu],
  ["lost_work", /\blost work\b/iu],
  ["data_loss", /\bdata loss\b/iu],
  ["privacy", /\bprivacy\b/iu],
  ["retention", /\bretention\b/iu],
  ["sensitive_evidence", /\bsensitive evidence\b/iu],
  ["currency", /\bcurrenc(?:y|ies)\b/iu],
  ["rewards", /\brewards?\b|\bawards?\b/iu],
  ["weighted_selection", /\bweighted selection\b/iu],
  ["fairness", /\bfairness\b/iu],
]);

export class GenerationValidationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "GenerationValidationError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new GenerationValidationError(code, message, details);
}

function asRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_generation_contract", `${label} must be an object`);
  }
  return value;
}

function requiredString(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    fail("invalid_generation_contract", `${label} is required`);
  }
  return normalized;
}

function optionalString(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function stringList(value, label, { allowEmpty = true } = {}) {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.trim().length === 0)
  ) {
    fail(
      "invalid_generation_contract",
      `${label} must be an array of non-empty strings`,
    );
  }
  const normalized = [...new Set(value.map((item) => item.trim()))].sort();
  if (!allowEmpty && normalized.length === 0) {
    fail("invalid_generation_contract", `${label} must not be empty`);
  }
  return normalized;
}

function optionalStringList(value, label) {
  return value === undefined ? [] : stringList(value, label);
}

function booleanValue(value, label) {
  if (typeof value !== "boolean") {
    fail("invalid_generation_contract", `${label} must be a boolean`);
  }
  return value;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    fail("invalid_generation_contract", `${label} must be a positive integer`);
  }
  return parsed;
}

function normalizeForFingerprint(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, " ");
}

function fingerprint(prefix, value) {
  return `${prefix}-${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20)}`;
}

function normalizeRepoPath(value, label) {
  const raw = requiredString(value, label).replaceAll("\\", "/");
  const normalized = path.posix.normalize(raw);
  if (
    path.posix.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    fail(
      "invalid_generation_contract",
      `${label} must be a repository-relative path`,
      { path: raw },
    );
  }
  return normalized.replace(/^\.\//u, "");
}

function repoPathList(value, label) {
  return [
    ...new Set(
      optionalStringList(value, label).map((item, index) =>
        normalizeRepoPath(item, `${label}[${index}]`),
      ),
    ),
  ].sort();
}

function findingIdentity(finding, index) {
  const record = asRecord(finding, `currentFindings[${index}]`);
  const explicitId = optionalString(record.id ?? record.finding_id);
  if (explicitId) {
    return explicitId;
  }
  const threadId = optionalString(record.thread_id ?? record.threadId);
  if (threadId) {
    return `thread:${threadId}`;
  }
  const commentId = optionalString(record.comment_id ?? record.commentId);
  if (commentId) {
    return `comment:${commentId}`;
  }
  fail(
    "invalid_generation_contract",
    `currentFindings[${index}] needs an id, thread_id, or comment_id`,
  );
}

function normalizeFinding(finding, index) {
  const record = asRecord(finding, `currentFindings[${index}]`);
  return {
    ...record,
    id: findingIdentity(record, index),
    thread_id: optionalString(record.thread_id ?? record.threadId),
    comment_id: optionalString(record.comment_id ?? record.commentId),
  };
}

function memberFindingIds(rawCluster, findingById, clusterIndex) {
  const explicitIds = optionalStringList(
    rawCluster.member_finding_ids,
    `clusters[${clusterIndex}].member_finding_ids`,
  );
  const threadIds = optionalStringList(
    rawCluster.member_thread_ids,
    `clusters[${clusterIndex}].member_thread_ids`,
  );
  const commentIds = optionalStringList(
    rawCluster.member_comment_ids,
    `clusters[${clusterIndex}].member_comment_ids`,
  );
  const result = new Set(explicitIds);
  for (const threadId of threadIds) {
    if (
      ![...findingById.values()].some(
        (finding) => finding.thread_id === threadId,
      )
    ) {
      fail(
        "invalid_generation_contract",
        `cluster references unknown current thread: ${threadId}`,
      );
    }
  }
  for (const commentId of commentIds) {
    if (
      ![...findingById.values()].some(
        (finding) => finding.comment_id === commentId,
      )
    ) {
      fail(
        "invalid_generation_contract",
        `cluster references unknown current comment: ${commentId}`,
      );
    }
  }
  for (const finding of findingById.values()) {
    if (
      (finding.thread_id && threadIds.includes(finding.thread_id)) ||
      (finding.comment_id && commentIds.includes(finding.comment_id))
    ) {
      result.add(finding.id);
    }
  }
  if (result.size === 0) {
    fail(
      "invalid_generation_contract",
      `clusters[${clusterIndex}] must include at least one current finding`,
    );
  }
  for (const findingId of result) {
    const finding = findingById.get(findingId);
    if (!finding) {
      continue;
    }
    if (finding.thread_id && !threadIds.includes(finding.thread_id)) {
      fail(
        "invalid_generation_contract",
        `cluster must include the thread id for current finding ${findingId}`,
      );
    }
    if (finding.comment_id && !commentIds.includes(finding.comment_id)) {
      fail(
        "invalid_generation_contract",
        `cluster must include the comment id for current finding ${findingId}`,
      );
    }
  }
  return {
    findingIds: [...result].sort(),
    threadIds,
    commentIds,
  };
}

export function computeRootCauseFingerprint(cluster) {
  const record = asRecord(cluster, "cluster");
  const invariantKey = requiredString(
    record.invariant_key,
    "cluster.invariant_key",
  );
  const governingInvariant = requiredString(
    record.governing_invariant,
    "cluster.governing_invariant",
  );
  const behaviorAreas = optionalStringList(
    record.behavior_areas,
    "cluster.behavior_areas",
  ).map(normalizeForFingerprint);
  return fingerprint("root", {
    invariant_key: normalizeForFingerprint(invariantKey),
    governing_invariant: normalizeForFingerprint(governingInvariant),
    behavior_areas: behaviorAreas.sort(),
  });
}

export function computeClusterMembershipFingerprint(cluster) {
  const record = asRecord(cluster, "cluster");
  return fingerprint("members", {
    finding_ids: optionalStringList(
      record.member_finding_ids,
      "cluster.member_finding_ids",
    ),
    thread_ids: optionalStringList(
      record.member_thread_ids,
      "cluster.member_thread_ids",
    ),
    comment_ids: optionalStringList(
      record.member_comment_ids,
      "cluster.member_comment_ids",
    ),
  });
}

export function validateAndFingerprintRootCauseClusters({
  currentFindings,
  clusters,
  requireAcceptedTestEvidence = true,
}) {
  if (!Array.isArray(currentFindings) || !Array.isArray(clusters)) {
    fail(
      "invalid_generation_contract",
      "currentFindings and clusters must be arrays",
    );
  }
  const findings = currentFindings.map(normalizeFinding);
  const findingById = new Map();
  for (const finding of findings) {
    if (findingById.has(finding.id)) {
      fail(
        "invalid_generation_contract",
        `duplicate current finding id: ${finding.id}`,
      );
    }
    findingById.set(finding.id, finding);
  }

  const assignedFindingIds = new Set();
  const rootCauseFingerprints = new Set();
  const normalizedClusters = clusters.map((value, clusterIndex) => {
    const rawCluster = asRecord(value, `clusters[${clusterIndex}]`);
    const invariantKey = requiredString(
      rawCluster.invariant_key,
      `clusters[${clusterIndex}].invariant_key`,
    );
    const governingInvariant = requiredString(
      rawCluster.governing_invariant,
      `clusters[${clusterIndex}].governing_invariant`,
    );
    const severity = requiredString(
      rawCluster.severity,
      `clusters[${clusterIndex}].severity`,
    ).toUpperCase();
    if (!ROOT_CAUSE_SEVERITIES.includes(severity)) {
      fail(
        "invalid_generation_contract",
        `clusters[${clusterIndex}].severity must be P0, P1, P2, or P3`,
      );
    }
    const classification = requiredString(
      rawCluster.classification,
      `clusters[${clusterIndex}].classification`,
    ).toLowerCase();
    if (!ROOT_CAUSE_CLASSIFICATIONS.includes(classification)) {
      fail(
        "invalid_generation_contract",
        `clusters[${clusterIndex}].classification must be accepted, invalid, deferred, or ambiguous`,
      );
    }
    const members = memberFindingIds(rawCluster, findingById, clusterIndex);
    for (const findingId of members.findingIds) {
      if (!findingById.has(findingId)) {
        fail(
          "invalid_generation_contract",
          `cluster references unknown current finding: ${findingId}`,
        );
      }
      if (assignedFindingIds.has(findingId)) {
        fail(
          "invalid_generation_contract",
          `current finding is assigned to more than one cluster: ${findingId}`,
        );
      }
      assignedFindingIds.add(findingId);
    }
    const affectedFiles = repoPathList(
      rawCluster.affected_files,
      `clusters[${clusterIndex}].affected_files`,
    );
    if (classification === "accepted" && affectedFiles.length === 0) {
      fail(
        "invalid_generation_contract",
        `clusters[${clusterIndex}] must identify affected files for an accepted repair`,
      );
    }
    const behaviorAreas = stringList(
      rawCluster.behavior_areas,
      `clusters[${clusterIndex}].behavior_areas`,
      {
        allowEmpty: false,
      },
    );
    const evidence = requiredString(
      rawCluster.evidence,
      `clusters[${clusterIndex}].evidence`,
    );
    const implementationSummary = requiredString(
      rawCluster.implementation_summary,
      `clusters[${clusterIndex}].implementation_summary`,
    );
    const siblingPathsAudited = repoPathList(
      rawCluster.sibling_paths_audited,
      `clusters[${clusterIndex}].sibling_paths_audited`,
    );
    const testsAddedOrRun = optionalStringList(
      rawCluster.tests_added_or_run,
      `clusters[${clusterIndex}].tests_added_or_run`,
    );
    if (
      requireAcceptedTestEvidence &&
      classification === "accepted" &&
      testsAddedOrRun.length === 0
    ) {
      fail(
        "invalid_generation_contract",
        `clusters[${clusterIndex}] must list focused regression tests for an accepted repair`,
      );
    }
    const filesChanged = repoPathList(
      rawCluster.files_changed,
      `clusters[${clusterIndex}].files_changed`,
    );
    const everyMemberFullyAddressed = booleanValue(
      rawCluster.every_member_fully_addressed,
      `clusters[${clusterIndex}].every_member_fully_addressed`,
    );
    const workerResolvableThreadIds = optionalStringList(
      rawCluster.resolvable_thread_ids,
      `clusters[${clusterIndex}].resolvable_thread_ids`,
    );
    if (
      workerResolvableThreadIds.some(
        (threadId) => !members.threadIds.includes(threadId),
      ) ||
      (workerResolvableThreadIds.length > 0 && !everyMemberFullyAddressed) ||
      (workerResolvableThreadIds.length > 0 &&
        !["accepted", "invalid"].includes(classification))
    ) {
      fail(
        "invalid_generation_contract",
        `clusters[${clusterIndex}] may resolve only its own fully addressed accepted or invalid threads`,
      );
    }
    if (
      ["deferred", "ambiguous"].includes(classification) &&
      everyMemberFullyAddressed
    ) {
      fail(
        "invalid_generation_contract",
        `clusters[${clusterIndex}] cannot mark deferred or ambiguous findings fully addressed`,
      );
    }
    const resolvableThreadIds =
      everyMemberFullyAddressed &&
      ["accepted", "invalid"].includes(classification)
        ? members.threadIds
        : [];

    const normalized = {
      worker_cluster_id: optionalString(rawCluster.cluster_id),
      invariant_key: invariantKey,
      governing_invariant: governingInvariant,
      severity,
      risk_domains: optionalStringList(
        rawCluster.risk_domains,
        `clusters[${clusterIndex}].risk_domains`,
      ).map(normalizeRiskDomain),
      member_finding_ids: members.findingIds,
      member_thread_ids: members.threadIds,
      member_comment_ids: members.commentIds,
      affected_files: affectedFiles,
      behavior_areas: behaviorAreas,
      classification,
      evidence,
      implementation_summary: implementationSummary,
      sibling_paths_audited: siblingPathsAudited,
      tests_added_or_run: testsAddedOrRun,
      files_changed: filesChanged,
      every_member_fully_addressed: everyMemberFullyAddressed,
      worker_resolvable_thread_ids: workerResolvableThreadIds,
      resolvable_thread_ids: resolvableThreadIds,
    };
    const rootCauseFingerprint = computeRootCauseFingerprint(normalized);
    if (rootCauseFingerprints.has(rootCauseFingerprint)) {
      fail(
        "invalid_generation_contract",
        `equivalent root-cause clusters must be grouped: ${rootCauseFingerprint}`,
      );
    }
    rootCauseFingerprints.add(rootCauseFingerprint);
    return {
      ...normalized,
      cluster_id: rootCauseFingerprint,
      root_cause_fingerprint: rootCauseFingerprint,
      membership_fingerprint: computeClusterMembershipFingerprint(normalized),
    };
  });

  const unassigned = findings
    .map((finding) => finding.id)
    .filter((id) => !assignedFindingIds.has(id));
  if (unassigned.length > 0) {
    fail(
      "invalid_generation_contract",
      "every current finding must be assigned to exactly one cluster",
      {
        unassigned_finding_ids: unassigned.sort(),
      },
    );
  }

  return {
    findings,
    clusters: normalizedClusters.sort((left, right) =>
      left.cluster_id.localeCompare(right.cluster_id),
    ),
    credible_cluster_count: normalizedClusters.filter((cluster) =>
      CREDIBLE_ROOT_CAUSE_CLASSIFICATIONS.includes(cluster.classification),
    ).length,
    resolvable_thread_ids: [
      ...new Set(
        normalizedClusters.flatMap((cluster) => cluster.resolvable_thread_ids),
      ),
    ].sort(),
  };
}

function findingDiagnosticMetadata(finding, index) {
  const normalized = normalizeFinding(finding, index);
  return {
    id: normalized.id,
    thread_id: normalized.thread_id,
    comment_id: normalized.comment_id,
    severity: optionalString(normalized.severity)?.toUpperCase() ?? null,
    path: optionalString(normalized.path ?? normalized.file_path),
    outdated: normalized.outdated === true,
  };
}

function diagnosticFindingComparator(left, right) {
  const severityOrder = new Map(
    ROOT_CAUSE_SEVERITIES.map((severity, index) => [severity, index]),
  );
  return (
    (severityOrder.get(left.severity) ?? 99) -
      (severityOrder.get(right.severity) ?? 99) ||
    String(left.path ?? "").localeCompare(String(right.path ?? "")) ||
    left.id.localeCompare(right.id)
  );
}

export function evaluateGenerationLimits({
  currentActionableThreads = [],
  clusters = [],
  rawCurrentThreadLimit = DEFAULT_RAW_CURRENT_THREAD_LIMIT,
  rootCauseClusterLimit = DEFAULT_ROOT_CAUSE_CLUSTER_LIMIT,
  diagnosticSampleSize = 10,
} = {}) {
  if (!Array.isArray(currentActionableThreads) || !Array.isArray(clusters)) {
    fail(
      "invalid_generation_contract",
      "currentActionableThreads and clusters must be arrays",
    );
  }
  const threadLimit = positiveInteger(
    rawCurrentThreadLimit,
    "rawCurrentThreadLimit",
  );
  const clusterLimit = positiveInteger(
    rootCauseClusterLimit,
    "rootCauseClusterLimit",
  );
  const sampleSize = positiveInteger(
    diagnosticSampleSize,
    "diagnosticSampleSize",
  );
  const credibleClusters = clusters.filter((cluster) =>
    CREDIBLE_ROOT_CAUSE_CLASSIFICATIONS.includes(
      String(cluster?.classification ?? "").toLowerCase(),
    ),
  );
  const blockers = [];
  let diagnosticSample = [];
  if (currentActionableThreads.length > threadLimit) {
    diagnosticSample = currentActionableThreads
      .map(findingDiagnosticMetadata)
      .sort(diagnosticFindingComparator)
      .slice(0, sampleSize);
    blockers.push({
      kind: "split_required",
      reason: "raw_current_thread_limit_exceeded",
      current_actionable_thread_count: currentActionableThreads.length,
      limit: threadLimit,
    });
  }
  if (credibleClusters.length > clusterLimit) {
    blockers.push({
      kind: "split_required",
      reason: "root_cause_cluster_limit_exceeded",
      credible_root_cause_cluster_count: credibleClusters.length,
      limit: clusterLimit,
    });
  }
  return {
    status: blockers.length > 0 ? "split_required" : "within_limits",
    current_actionable_thread_count: currentActionableThreads.length,
    root_cause_cluster_count: clusters.length,
    credible_root_cause_cluster_count: credibleClusters.length,
    excluded_or_truncated_current_thread_count: 0,
    diagnostic_sample: diagnosticSample,
    blockers,
  };
}

function sanitizePrMetadata(pr) {
  const record = asRecord(pr, "pr");
  return {
    number: record.number ?? null,
    branch: optionalString(record.branch),
    intent: optionalString(record.intent),
    base_sha: optionalString(record.base_sha ?? record.baseSha),
    head_sha: optionalString(record.head_sha ?? record.headSha),
  };
}

function compactCluster(cluster) {
  return {
    cluster_id: cluster.cluster_id,
    root_cause_fingerprint: cluster.root_cause_fingerprint,
    membership_fingerprint: cluster.membership_fingerprint,
    governing_invariant: cluster.governing_invariant,
    severity: cluster.severity,
    classification: cluster.classification,
    behavior_areas: cluster.behavior_areas,
    affected_files: cluster.affected_files,
  };
}

function targetFingerprints(item, label) {
  const values = item.cluster_fingerprints ?? item.cluster_ids;
  return values === undefined
    ? []
    : stringList(values, `${label}.cluster_fingerprints`);
}

function scopedContextItems(items, selectedClusterIds, label, valueField) {
  if (!Array.isArray(items)) {
    fail("invalid_generation_contract", `${label} must be an array`);
  }
  return items
    .map((value, index) => {
      const item = asRecord(value, `${label}[${index}]`);
      const targets = targetFingerprints(item, `${label}[${index}]`);
      return {
        path:
          item.path === undefined
            ? null
            : normalizeRepoPath(item.path, `${label}[${index}].path`),
        [valueField]: requiredString(
          item[valueField],
          `${label}[${index}].${valueField}`,
        ),
        cluster_fingerprints: targets,
      };
    })
    .filter(
      (item) =>
        item.cluster_fingerprints.length === 0 ||
        item.cluster_fingerprints.some((clusterId) =>
          selectedClusterIds.has(clusterId),
        ),
    );
}

// Fail closed on a target that names no validated cluster instead of
// silently dropping that context from every partition.
function assertKnownContextTargets(items, knownClusterIds, label) {
  if (!Array.isArray(items)) {
    fail("invalid_generation_contract", `${label} must be an array`);
  }
  items.forEach((value, index) => {
    const item = asRecord(value, `${label}[${index}]`);
    for (const target of targetFingerprints(item, `${label}[${index}]`)) {
      if (!knownClusterIds.has(target)) {
        fail(
          "invalid_generation_contract",
          `${label}[${index}] targets unknown cluster ${target}`,
        );
      }
    }
  });
}

function serializeContextPayload(payload) {
  const serialized = JSON.stringify(payload);
  return { payload, serialized, character_count: serialized.length };
}

export function buildBoundedContextPacks({
  pr,
  repositoryInstructions = [],
  scope,
  currentFindings,
  clusters,
  diffPatches = [],
  siblingContext = [],
  resolvedFindingFingerprints = [],
  validationFailures = [],
  maxChars = DEFAULT_CONTEXT_PACK_MAX_CHARS,
} = {}) {
  const limit = positiveInteger(maxChars, "maxChars");
  const validated = validateAndFingerprintRootCauseClusters({
    currentFindings,
    clusters,
    // Context packs are built from the pre-edit cluster plan. Accepted
    // repairs gain mandatory focused-test evidence in the worker-result gate.
    requireAcceptedTestEvidence: false,
  });
  const findingById = new Map(
    validated.findings.map((finding) => [finding.id, finding]),
  );
  const knownClusterIds = new Set(
    validated.clusters.map((cluster) => cluster.cluster_id),
  );
  assertKnownContextTargets(diffPatches, knownClusterIds, "diffPatches");
  assertKnownContextTargets(siblingContext, knownClusterIds, "siblingContext");
  const common = {
    context_schema_version: 1,
    pr: sanitizePrMetadata(pr),
    repository_instructions: stringList(
      repositoryInstructions,
      "repositoryInstructions",
    ),
    scope: asRecord(scope, "scope"),
    cluster_catalog: validated.clusters.map(compactCluster),
    resolved_or_superseded_fingerprints: stringList(
      resolvedFindingFingerprints,
      "resolvedFindingFingerprints",
    ),
    validation_failures: stringList(validationFailures, "validationFailures"),
  };

  const payloadForClusters = (selectedClusters) => {
    const selectedClusterIds = new Set(
      selectedClusters.map((cluster) => cluster.cluster_id),
    );
    const assignedFindingIds = new Set(
      selectedClusters.flatMap((cluster) => cluster.member_finding_ids),
    );
    return {
      ...common,
      assigned_clusters: selectedClusters,
      current_findings: [...assignedFindingIds]
        .sort()
        .map((findingId) => findingById.get(findingId)),
      exact_diff_patches: scopedContextItems(
        diffPatches,
        selectedClusterIds,
        "diffPatches",
        "patch",
      ),
      sibling_context: scopedContextItems(
        siblingContext,
        selectedClusterIds,
        "siblingContext",
        "content",
      ),
    };
  };

  if (validated.clusters.length === 0) {
    const emptyPack = serializeContextPayload(payloadForClusters([]));
    if (emptyPack.character_count > limit) {
      return {
        status: "context_pack_overflow",
        blocker: {
          kind: "context_pack_overflow",
          cluster_id: null,
          required_character_count: emptyPack.character_count,
          limit,
        },
        packs: [],
      };
    }
    return {
      status: "ready",
      limit,
      total_character_count: emptyPack.character_count,
      packs: [emptyPack],
    };
  }

  const packs = [];
  let pendingClusters = [];
  for (const cluster of validated.clusters) {
    const individualPack = serializeContextPayload(
      payloadForClusters([cluster]),
    );
    if (individualPack.character_count > limit) {
      return {
        status: "context_pack_overflow",
        blocker: {
          kind: "context_pack_overflow",
          cluster_id: cluster.cluster_id,
          required_character_count: individualPack.character_count,
          limit,
        },
        packs: [],
      };
    }
    const candidateClusters = [...pendingClusters, cluster];
    const candidatePack = serializeContextPayload(
      payloadForClusters(candidateClusters),
    );
    if (candidatePack.character_count <= limit) {
      pendingClusters = candidateClusters;
      continue;
    }
    packs.push(serializeContextPayload(payloadForClusters(pendingClusters)));
    pendingClusters = [cluster];
  }
  if (pendingClusters.length > 0) {
    packs.push(serializeContextPayload(payloadForClusters(pendingClusters)));
  }

  return {
    status: "ready",
    limit,
    total_character_count: packs.reduce(
      (sum, pack) => sum + pack.character_count,
      0,
    ),
    packs: packs.map((pack, index) => ({
      ...pack,
      partition_index: index + 1,
      partition_count: packs.length,
    })),
  };
}

export function buildLocalReviewScope({
  epochType,
  requestType,
  mergeBaseSha = null,
  lastExternallyReviewedHeadSha = null,
  priorTimedOutRequestHeadSha = null,
  currentHeadSha,
  siblingPaths = [],
  currentUnresolvedFindingIds = [],
} = {}) {
  const epoch = requiredString(epochType, "epochType");
  const request = requiredString(requestType, "requestType");
  const headSha = requiredString(currentHeadSha, "currentHeadSha");
  if (!["normal", "legacy_closure"].includes(epoch)) {
    fail(
      "invalid_generation_contract",
      "epochType must be normal or legacy_closure",
    );
  }
  if (!["initial_full", "targeted_closure"].includes(request)) {
    fail(
      "invalid_generation_contract",
      "requestType must be initial_full or targeted_closure",
    );
  }
  if (epoch === "legacy_closure" && request !== "targeted_closure") {
    fail(
      "invalid_generation_contract",
      "legacy_closure cannot request an initial full review",
    );
  }
  const reviewedBase = optionalString(lastExternallyReviewedHeadSha);
  const timedOutBase = optionalString(priorTimedOutRequestHeadSha);
  const rawBaseSha =
    request === "initial_full" ? mergeBaseSha : (reviewedBase ?? timedOutBase);
  const baseSha = optionalString(rawBaseSha);
  if (!baseSha) {
    fail(
      "review_scope_unavailable",
      request === "initial_full"
        ? "the current PR merge base is unavailable"
        : "neither the last externally reviewed head nor the prior timed-out request head is available",
      { epoch_type: epoch, request_type: request, head_sha: headSha },
    );
  }
  return {
    kind:
      epoch === "legacy_closure"
        ? "legacy_closure"
        : request === "initial_full"
          ? "initial_full"
          : "targeted_delta",
    epoch_type: epoch,
    request_type: request,
    diff_base_kind:
      request === "initial_full"
        ? "merge_base"
        : reviewedBase
          ? "last_externally_reviewed_head"
          : "prior_timed_out_request_head",
    base_sha: baseSha,
    head_sha: headSha,
    diff_range: `${baseSha}..${headSha}`,
    sibling_paths: repoPathList(siblingPaths, "siblingPaths"),
    include_all_current_unresolved_findings: epoch === "legacy_closure",
    current_unresolved_finding_ids:
      epoch === "legacy_closure"
        ? stringList(currentUnresolvedFindingIds, "currentUnresolvedFindingIds")
        : [],
  };
}

export function validateWorkerEditAllowlist({
  workerChangedFiles = [],
  diffFiles = [],
  siblingPaths = [],
  testFiles = [],
  generatedArtifactFiles = [],
} = {}) {
  const changed = repoPathList(workerChangedFiles, "workerChangedFiles");
  const categories = {
    diff_files: repoPathList(diffFiles, "diffFiles"),
    sibling_paths: repoPathList(siblingPaths, "siblingPaths"),
    test_files: repoPathList(testFiles, "testFiles"),
    generated_artifact_files: repoPathList(
      generatedArtifactFiles,
      "generatedArtifactFiles",
    ),
  };
  const allowed = new Set(Object.values(categories).flat());
  const unexpected = changed.filter((file) => !allowed.has(file));
  return {
    status: unexpected.length > 0 ? "worker_scope_violation" : "allowed",
    allowed_files: [...allowed].sort(),
    changed_files: changed,
    unexpected_files: unexpected,
    categories,
    blocker:
      unexpected.length > 0
        ? { kind: "worker_scope_violation", unexpected_files: unexpected }
        : null,
  };
}

export function evaluateLocalStabilization({
  passes = [],
  maxPasses = MAX_LOCAL_REVIEW_PASSES,
} = {}) {
  const limit = positiveInteger(maxPasses, "maxPasses");
  if (limit !== MAX_LOCAL_REVIEW_PASSES) {
    fail(
      "invalid_generation_contract",
      `maxPasses must remain ${MAX_LOCAL_REVIEW_PASSES}`,
    );
  }
  if (!Array.isArray(passes) || passes.length > limit) {
    fail(
      "invalid_generation_contract",
      `passes must contain at most ${limit} local review passes`,
    );
  }
  const normalizedPasses = passes.map((pass, index) => {
    const record = asRecord(pass, `passes[${index}]`);
    const count = Number(record.credible_unresolved_defect_count ?? 0);
    if (!Number.isSafeInteger(count) || count < 0) {
      fail(
        "invalid_generation_contract",
        `passes[${index}].credible_unresolved_defect_count must be non-negative`,
      );
    }
    return { pass_number: index + 1, credible_unresolved_defect_count: count };
  });
  if (normalizedPasses.length === 0) {
    return {
      status: "local_review_required",
      passes_used: 0,
      passes_remaining: limit,
      blocker: null,
    };
  }
  const latest = normalizedPasses.at(-1);
  if (latest.credible_unresolved_defect_count === 0) {
    return {
      status: "stable",
      passes_used: normalizedPasses.length,
      passes_remaining: limit - normalizedPasses.length,
      blocker: null,
    };
  }
  if (normalizedPasses.length < limit) {
    return {
      status: "local_repair_required",
      passes_used: normalizedPasses.length,
      passes_remaining: limit - normalizedPasses.length,
      blocker: null,
    };
  }
  return {
    status: "local_stabilization_failed",
    passes_used: normalizedPasses.length,
    passes_remaining: 0,
    blocker: {
      kind: "local_stabilization_failed",
      credible_unresolved_defect_count: latest.credible_unresolved_defect_count,
    },
  };
}

function nonNegativeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    fail(
      "invalid_generation_attestation",
      `${label} must be a non-negative integer`,
    );
  }
  return parsed;
}

function attestationBoolean(value, label) {
  if (typeof value !== "boolean") {
    fail("invalid_generation_attestation", `${label} must be a boolean`);
  }
  return value;
}

function attestationTimestamp(value, label) {
  const timestamp = requiredString(value, label);
  if (!Number.isFinite(Date.parse(timestamp))) {
    fail(
      "invalid_generation_attestation",
      `${label} must be an ISO-compatible timestamp`,
    );
  }
  return timestamp;
}

function attestationStringList(value, label) {
  if (value === undefined) {
    fail("invalid_generation_attestation", `${label} must be present`);
  }
  return stringList(value, label);
}

function normalizeAttestedPasses(value) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_LOCAL_REVIEW_PASSES
  ) {
    fail(
      "invalid_generation_attestation",
      `local_passes must contain between 1 and ${MAX_LOCAL_REVIEW_PASSES} passes`,
    );
  }
  const passes = value.map((entry, index) => {
    const pass = asRecord(entry, `local_passes[${index}]`);
    const expectedPassNumber = index + 1;
    if (
      pass.pass_number !== undefined &&
      Number(pass.pass_number) !== expectedPassNumber
    ) {
      fail(
        "invalid_generation_attestation",
        `local_passes[${index}].pass_number must be ${expectedPassNumber}`,
      );
    }
    return {
      pass_number: expectedPassNumber,
      credible_unresolved_defect_count: nonNegativeInteger(
        pass.credible_unresolved_defect_count,
        `local_passes[${index}].credible_unresolved_defect_count`,
      ),
      worker_profile: optionalString(pass.worker_profile),
      result_fingerprint: optionalString(pass.result_fingerprint),
    };
  });
  const stabilization = evaluateLocalStabilization({ passes });
  if (stabilization.status !== "stable") {
    fail(
      "generation_not_stable",
      "the final local pass must contain no credible unresolved defects",
      { stabilization },
    );
  }
  return passes;
}

function normalizeFocusedTestEvidence(
  value,
  label,
  expectedHeadSha,
  expectedGitTreeHash,
  { required },
) {
  if (value === undefined) {
    if (required) {
      fail(
        "generation_validation_incomplete",
        `${label} must contain queue-owned focused-test evidence`,
      );
    }
    return [];
  }
  if (!Array.isArray(value)) {
    fail("invalid_generation_attestation", `${label} must be an array`);
  }
  if (required && value.length === 0) {
    fail(
      "generation_validation_incomplete",
      `${label} must contain queue-owned focused-test evidence`,
    );
  }

  return value
    .map((entry, index) => {
      const evidence = asRecord(entry, `${label}[${index}]`);
      const command = optionalString(evidence.command);
      const testIdentifier = optionalString(
        evidence.test_identifier ?? evidence.testIdentifier,
      );
      if (command === null && testIdentifier === null) {
        fail(
          "invalid_generation_attestation",
          `${label}[${index}] must name a command or test identifier`,
        );
      }
      if (!attestationBoolean(evidence.passed, `${label}[${index}].passed`)) {
        fail(
          "generation_validation_incomplete",
          `${label}[${index}] did not pass`,
        );
      }
      const coveredGitTreeHash = requiredString(
        evidence.covered_git_tree_hash ?? evidence.coveredGitTreeHash,
        `${label}[${index}].covered_git_tree_hash`,
      );
      if (coveredGitTreeHash !== expectedGitTreeHash) {
        fail(
          "generation_attestation_mismatch",
          `${label}[${index}] does not cover the attested git tree`,
          {
            expected_git_tree_hash: expectedGitTreeHash,
            covered_git_tree_hash: coveredGitTreeHash,
          },
        );
      }
      const coveredHeadSha = optionalString(
        evidence.covered_head_sha ?? evidence.coveredHeadSha,
      );
      if (coveredHeadSha !== null && coveredHeadSha !== expectedHeadSha) {
        fail(
          "generation_attestation_mismatch",
          `${label}[${index}] names a different PR head`,
          {
            expected_head_sha: expectedHeadSha,
            covered_head_sha: coveredHeadSha,
          },
        );
      }
      const completedAtValue = evidence.completed_at ?? evidence.completedAt;
      return {
        command,
        test_identifier: testIdentifier,
        passed: true,
        covered_head_sha: coveredHeadSha,
        covered_git_tree_hash: coveredGitTreeHash,
        completed_at:
          completedAtValue === undefined
            ? null
            : attestationTimestamp(
                completedAtValue,
                `${label}[${index}].completed_at`,
              ),
      };
    })
    .sort((left, right) =>
      `${left.command ?? ""}\u0000${left.test_identifier ?? ""}`.localeCompare(
        `${right.command ?? ""}\u0000${right.test_identifier ?? ""}`,
      ),
    );
}

function normalizeAttestedClusters(value, headSha, gitTreeHash) {
  if (!Array.isArray(value)) {
    fail("invalid_generation_attestation", "clusters must be an array");
  }
  const clusterIds = new Set();
  const membershipFingerprints = new Set();
  return value
    .map((entry, index) => {
      const cluster = asRecord(entry, `clusters[${index}]`);
      const clusterId = requiredString(
        cluster.cluster_id,
        `clusters[${index}].cluster_id`,
      );
      const rootCauseFingerprint = requiredString(
        cluster.root_cause_fingerprint,
        `clusters[${index}].root_cause_fingerprint`,
      );
      const membershipFingerprint = requiredString(
        cluster.membership_fingerprint,
        `clusters[${index}].membership_fingerprint`,
      );
      const classification = requiredString(
        cluster.classification,
        `clusters[${index}].classification`,
      ).toLowerCase();
      if (!["accepted", "invalid"].includes(classification)) {
        fail(
          "generation_not_stable",
          `clusters[${index}] must be accepted or invalid before completion`,
          { cluster_id: clusterId, classification },
        );
      }
      if (
        !attestationBoolean(
          cluster.every_member_fully_addressed,
          `clusters[${index}].every_member_fully_addressed`,
        )
      ) {
        fail(
          "generation_not_stable",
          `clusters[${index}] is not fully addressed`,
          { cluster_id: clusterId },
        );
      }
      if (clusterId !== rootCauseFingerprint) {
        fail(
          "invalid_generation_attestation",
          `clusters[${index}].cluster_id must equal its root-cause fingerprint`,
        );
      }
      if (clusterIds.has(clusterId)) {
        fail(
          "invalid_generation_attestation",
          `duplicate attested cluster id: ${clusterId}`,
        );
      }
      if (membershipFingerprints.has(membershipFingerprint)) {
        fail(
          "invalid_generation_attestation",
          `duplicate attested cluster membership: ${membershipFingerprint}`,
        );
      }
      clusterIds.add(clusterId);
      membershipFingerprints.add(membershipFingerprint);
      const focusedTests = attestationStringList(
        cluster.tests_added_or_run,
        `clusters[${index}].tests_added_or_run`,
      );
      if (classification === "accepted" && focusedTests.length === 0) {
        fail(
          "generation_validation_incomplete",
          `clusters[${index}] has no focused regression-test evidence`,
          { cluster_id: clusterId },
        );
      }
      const focusedTestEvidence = normalizeFocusedTestEvidence(
        cluster.focused_test_evidence ?? cluster.focusedTestEvidence,
        `clusters[${index}].focused_test_evidence`,
        headSha,
        gitTreeHash,
        { required: classification === "accepted" },
      );
      return {
        cluster_id: clusterId,
        root_cause_fingerprint: rootCauseFingerprint,
        membership_fingerprint: membershipFingerprint,
        classification,
        every_member_fully_addressed: true,
        member_thread_ids: attestationStringList(
          cluster.member_thread_ids,
          `clusters[${index}].member_thread_ids`,
        ),
        resolvable_thread_ids: attestationStringList(
          cluster.resolvable_thread_ids,
          `clusters[${index}].resolvable_thread_ids`,
        ),
        tests_added_or_run: focusedTests,
        focused_test_evidence: focusedTestEvidence,
      };
    })
    .sort((left, right) => left.cluster_id.localeCompare(right.cluster_id));
}

function normalizeAttestedCheck(value, label, expectedCommand, headSha, tree) {
  const check = asRecord(value, label);
  if (!attestationBoolean(check.passed, `${label}.passed`)) {
    fail("generation_validation_incomplete", `${label} did not pass`);
  }
  const command = requiredString(check.command, `${label}.command`);
  if (command !== expectedCommand) {
    fail(
      "invalid_generation_attestation",
      `${label}.command must be ${expectedCommand}`,
    );
  }
  const coveredTree = requiredString(
    check.covered_git_tree_hash,
    `${label}.covered_git_tree_hash`,
  );
  if (coveredTree !== tree) {
    fail(
      "generation_attestation_mismatch",
      `${label} does not cover the attested git tree`,
      { expected_git_tree_hash: tree, covered_git_tree_hash: coveredTree },
    );
  }
  const coveredHead = optionalString(check.covered_head_sha);
  if (coveredHead !== null && coveredHead !== headSha) {
    fail(
      "generation_attestation_mismatch",
      `${label} names a different PR head`,
      { expected_head_sha: headSha, covered_head_sha: coveredHead },
    );
  }
  return {
    command,
    passed: true,
    covered_head_sha: coveredHead,
    covered_git_tree_hash: coveredTree,
    completed_at: attestationTimestamp(
      check.completed_at,
      `${label}.completed_at`,
    ),
  };
}

function normalizePublicationEvidence(value, headSha, tree) {
  const publication = asRecord(value, "publication");
  for (const field of [
    "committed",
    "pushed",
    "worktree_clean",
    "remote_head_equal",
  ]) {
    if (!attestationBoolean(publication[field], `publication.${field}`)) {
      fail(
        "generation_publication_incomplete",
        `publication.${field} must be true`,
      );
    }
  }
  const exactValues = {
    committed_head_sha: headSha,
    committed_git_tree_hash: tree,
    pushed_head_sha: headSha,
    remote_head_sha: headSha,
  };
  for (const [field, expected] of Object.entries(exactValues)) {
    const actual = requiredString(publication[field], `publication.${field}`);
    if (actual !== expected) {
      fail(
        "generation_attestation_mismatch",
        `publication.${field} does not match the attested generation`,
        { field, expected, actual },
      );
    }
  }
  return {
    committed: true,
    committed_head_sha: headSha,
    committed_git_tree_hash: tree,
    pushed: true,
    pushed_head_sha: headSha,
    remote_head_equal: true,
    remote_head_sha: headSha,
    worktree_clean: true,
    confirmed_at: attestationTimestamp(
      publication.confirmed_at,
      "publication.confirmed_at",
    ),
  };
}

function normalizeResolutionRefresh(value, headSha, clusters) {
  const refresh = asRecord(value, "resolution_refresh");
  if (!attestationBoolean(refresh.performed, "resolution_refresh.performed")) {
    fail(
      "generation_resolution_refresh_incomplete",
      "resolved-thread state must be refreshed after resolution",
    );
  }
  const refreshHead = requiredString(
    refresh.head_sha,
    "resolution_refresh.head_sha",
  );
  if (refreshHead !== headSha) {
    fail(
      "generation_attestation_mismatch",
      "resolved-thread refresh does not cover the attested PR head",
      { expected_head_sha: headSha, refreshed_head_sha: refreshHead },
    );
  }
  const resolvedThreadIds = attestationStringList(
    refresh.resolved_thread_ids,
    "resolution_refresh.resolved_thread_ids",
  );
  const remainingCurrentActionableThreadIds = attestationStringList(
    refresh.remaining_current_actionable_thread_ids,
    "resolution_refresh.remaining_current_actionable_thread_ids",
  );
  const remainingAmbiguousThreadIds = attestationStringList(
    refresh.remaining_ambiguous_thread_ids,
    "resolution_refresh.remaining_ambiguous_thread_ids",
  );
  const remainingDeferredThreadIds = attestationStringList(
    refresh.remaining_deferred_thread_ids,
    "resolution_refresh.remaining_deferred_thread_ids",
  );
  if (
    remainingCurrentActionableThreadIds.length > 0 ||
    remainingAmbiguousThreadIds.length > 0 ||
    remainingDeferredThreadIds.length > 0
  ) {
    fail(
      "generation_not_stable",
      "refreshed thread state still contains current actionable, ambiguous, or deferred feedback",
      {
        remaining_current_actionable_thread_ids:
          remainingCurrentActionableThreadIds,
        remaining_ambiguous_thread_ids: remainingAmbiguousThreadIds,
        remaining_deferred_thread_ids: remainingDeferredThreadIds,
      },
    );
  }
  const requiredResolvedThreadIds = [
    ...new Set(clusters.flatMap((cluster) => cluster.member_thread_ids)),
  ].sort();
  const missingResolvedThreadIds = requiredResolvedThreadIds.filter(
    (threadId) => !resolvedThreadIds.includes(threadId),
  );
  if (missingResolvedThreadIds.length > 0) {
    fail(
      "generation_resolution_refresh_incomplete",
      "not every fully addressed cluster thread is resolved in refreshed state",
      { missing_resolved_thread_ids: missingResolvedThreadIds },
    );
  }
  return {
    performed: true,
    head_sha: headSha,
    refreshed_at: attestationTimestamp(
      refresh.refreshed_at,
      "resolution_refresh.refreshed_at",
    ),
    resolved_thread_ids: resolvedThreadIds,
    remaining_current_actionable_thread_ids:
      remainingCurrentActionableThreadIds,
    remaining_ambiguous_thread_ids: remainingAmbiguousThreadIds,
    remaining_deferred_thread_ids: remainingDeferredThreadIds,
  };
}

function normalizeGenerationCompletionAttestation(value) {
  const record = asRecord(value, "generation completion attestation");
  const version = Number(
    record.attestation_schema_version ??
      record.attestationSchemaVersion ??
      GENERATION_COMPLETION_ATTESTATION_VERSION,
  );
  if (version !== GENERATION_COMPLETION_ATTESTATION_VERSION) {
    fail(
      "invalid_generation_attestation",
      `unsupported generation completion attestation version: ${version}`,
    );
  }
  const prNumber = positiveInteger(
    record.pr_number ?? record.prNumber,
    "pr_number",
  );
  const branch = requiredString(record.branch, "branch");
  const headSha = requiredString(record.head_sha ?? record.headSha, "head_sha");
  const gitTreeHash = requiredString(
    record.git_tree_hash ?? record.gitTreeHash,
    "git_tree_hash",
  );
  const localPasses = normalizeAttestedPasses(
    record.local_passes ?? record.localPasses,
  );
  const clusters = normalizeAttestedClusters(
    record.clusters,
    headSha,
    gitTreeHash,
  );
  const checksRecord = asRecord(record.checks, "checks");
  const checks = {
    diff_check: normalizeAttestedCheck(
      checksRecord.diff_check,
      "checks.diff_check",
      "git diff --check",
      headSha,
      gitTreeHash,
    ),
    full_gate: normalizeAttestedCheck(
      checksRecord.full_gate,
      "checks.full_gate",
      "npm run check",
      headSha,
      gitTreeHash,
    ),
  };
  const publication = normalizePublicationEvidence(
    record.publication,
    headSha,
    gitTreeHash,
  );
  const resolutionRefresh = normalizeResolutionRefresh(
    record.resolution_refresh ?? record.resolutionRefresh,
    headSha,
    clusters,
  );
  const generationId = fingerprint("generation", {
    pr_number: prNumber,
    head_sha: headSha,
    git_tree_hash: gitTreeHash,
    cluster_memberships: clusters.map((cluster) => ({
      cluster_id: cluster.cluster_id,
      membership_fingerprint: cluster.membership_fingerprint,
    })),
  });
  const suppliedGenerationId = optionalString(
    record.generation_id ?? record.generationId,
  );
  if (suppliedGenerationId !== null && suppliedGenerationId !== generationId) {
    fail(
      "generation_attestation_mismatch",
      "generation_id does not match the attested PR head and git tree",
      {
        expected_generation_id: generationId,
        actual_generation_id: suppliedGenerationId,
      },
    );
  }
  return {
    attestation_schema_version: version,
    generation_id: generationId,
    pr_number: prNumber,
    branch,
    head_sha: headSha,
    git_tree_hash: gitTreeHash,
    completed_at: attestationTimestamp(
      record.completed_at ?? record.completedAt,
      "completed_at",
    ),
    local_passes: localPasses,
    clusters,
    checks,
    publication,
    resolution_refresh: resolutionRefresh,
  };
}

/**
 * Creates the persisted evidence that one coherent repair generation is safe to
 * hand to an external reviewer. Time is injected so this helper stays pure.
 */
export function createGenerationCompletionAttestation(input) {
  const normalized = normalizeGenerationCompletionAttestation(input);
  return {
    ...normalized,
    attestation_fingerprint: fingerprint("attestation", normalized),
  };
}

/**
 * Revalidates persisted evidence and optionally binds it to the caller's exact
 * PR, head, and git tree. Any mutation or stale scope fails closed.
 */
export function validateGenerationCompletionAttestation(
  attestation,
  {
    expectedPrNumber = null,
    expectedHeadSha = null,
    expectedGitTreeHash = null,
    expectedMembershipFingerprints,
  } = {},
) {
  const record = asRecord(attestation, "generation completion attestation");
  const normalized = normalizeGenerationCompletionAttestation(record);
  const suppliedFingerprint = requiredString(
    record.attestation_fingerprint,
    "attestation_fingerprint",
  );
  const expectedFingerprint = fingerprint("attestation", normalized);
  if (suppliedFingerprint !== expectedFingerprint) {
    fail(
      "generation_attestation_mismatch",
      "generation completion attestation fingerprint is invalid",
      {
        expected_attestation_fingerprint: expectedFingerprint,
        actual_attestation_fingerprint: suppliedFingerprint,
      },
    );
  }
  const expected = {
    pr_number:
      expectedPrNumber === null
        ? normalized.pr_number
        : positiveInteger(expectedPrNumber, "expectedPrNumber"),
    head_sha:
      expectedHeadSha === null
        ? normalized.head_sha
        : requiredString(expectedHeadSha, "expectedHeadSha"),
    git_tree_hash:
      expectedGitTreeHash === null
        ? normalized.git_tree_hash
        : requiredString(expectedGitTreeHash, "expectedGitTreeHash"),
  };
  const actual = {
    pr_number: normalized.pr_number,
    head_sha: normalized.head_sha,
    git_tree_hash: normalized.git_tree_hash,
  };
  const mismatches = Object.keys(expected).filter(
    (field) => expected[field] !== actual[field],
  );
  if (mismatches.length > 0) {
    fail(
      "generation_attestation_mismatch",
      "generation completion attestation does not match current PR state",
      { mismatches, expected, actual },
    );
  }
  // The attested clusters must be exactly the generation's assigned clusters,
  // so a worker cannot drop a cluster and still pass.
  const expectedMembership = [
    ...new Set(
      stringList(expectedMembershipFingerprints, "expectedMembershipFingerprints"),
    ),
  ].sort();
  const attestedMembership = normalized.clusters
    .map((cluster) => cluster.membership_fingerprint)
    .sort();
  if (JSON.stringify(expectedMembership) !== JSON.stringify(attestedMembership)) {
    fail(
      "generation_attestation_mismatch",
      "generation completion attestation does not cover the assigned clusters",
      { expected: expectedMembership, actual: attestedMembership },
    );
  }
  return {
    status: "valid",
    ...normalized,
    attestation_fingerprint: suppliedFingerprint,
  };
}

/**
 * Allows expensive generation evidence to be reused only for a timed-out
 * external request on the exact same PR head and git tree.
 */
export function evaluateGenerationCompletionAttestationReuse({
  attestation,
  prNumber,
  currentHeadSha,
  currentGitTreeHash,
  expectedMembershipFingerprints,
  reason,
} = {}) {
  if (reason !== "review_timeout") {
    fail(
      "generation_attestation_reuse_not_allowed",
      "generation completion evidence may be reused only after a review timeout",
      { reason: optionalString(reason) },
    );
  }
  const validated = validateGenerationCompletionAttestation(attestation, {
    expectedPrNumber: prNumber,
    expectedHeadSha: currentHeadSha,
    expectedGitTreeHash: currentGitTreeHash,
    expectedMembershipFingerprints,
  });
  return {
    status: "reusable_after_review_timeout",
    generation_id: validated.generation_id,
    pr_number: validated.pr_number,
    head_sha: validated.head_sha,
    git_tree_hash: validated.git_tree_hash,
    attestation_fingerprint: validated.attestation_fingerprint,
  };
}

/**
 * A base advance can avoid another targeted cycle only when revalidation of the
 * current head proves that both the reviewed patch and merge result are
 * identical. Missing evidence is a request requirement, not an optimistic
 * assumption.
 */
export function evaluateBaseAdvanceRevalidation({
  previousBaseSha,
  currentBaseSha,
  currentHeadSha,
  revalidatedHeadSha = null,
  reviewedPatchIdentity = null,
  revalidatedPatchIdentity = null,
  reviewedMergeResultIdentity = null,
  revalidatedMergeResultIdentity = null,
} = {}) {
  const previousBase = requiredString(previousBaseSha, "previousBaseSha");
  const currentBase = requiredString(currentBaseSha, "currentBaseSha");
  const currentHead = requiredString(currentHeadSha, "currentHeadSha");
  if (previousBase === currentBase) {
    return {
      status: "base_unchanged",
      base_advanced: false,
      previous_base_sha: previousBase,
      current_base_sha: currentBase,
      current_head_sha: currentHead,
      revalidation_covers_current_head: false,
      patch_identity_matches: null,
      merge_result_identity_matches: null,
      patch_identity_proven_unchanged: false,
      merge_result_identity_proven_unchanged: false,
      targeted_review_required: false,
      reasons: [],
    };
  }

  const revalidatedHead = optionalString(revalidatedHeadSha);
  const reviewedPatch = optionalString(reviewedPatchIdentity);
  const revalidatedPatch = optionalString(revalidatedPatchIdentity);
  const reviewedMergeResult = optionalString(reviewedMergeResultIdentity);
  const revalidatedMergeResult = optionalString(revalidatedMergeResultIdentity);
  const coversCurrentHead = revalidatedHead === currentHead;
  const patchMatches =
    reviewedPatch !== null &&
    revalidatedPatch !== null &&
    reviewedPatch === revalidatedPatch;
  const mergeResultMatches =
    reviewedMergeResult !== null &&
    revalidatedMergeResult !== null &&
    reviewedMergeResult === revalidatedMergeResult;
  const patchProvenUnchanged = coversCurrentHead && patchMatches;
  const mergeResultProvenUnchanged = coversCurrentHead && mergeResultMatches;
  const reasons = [];
  if (!coversCurrentHead) {
    reasons.push("current_head_not_revalidated");
  }
  if (!patchProvenUnchanged) {
    reasons.push("patch_identity_not_proven_unchanged");
  }
  if (!mergeResultProvenUnchanged) {
    reasons.push("merge_result_identity_not_proven_unchanged");
  }
  const targetedReviewRequired = reasons.length > 0;
  return {
    status: targetedReviewRequired
      ? "targeted_review_required"
      : "base_advance_revalidated_unchanged",
    base_advanced: true,
    previous_base_sha: previousBase,
    current_base_sha: currentBase,
    current_head_sha: currentHead,
    revalidated_head_sha: revalidatedHead,
    revalidation_covers_current_head: coversCurrentHead,
    reviewed_patch_identity: reviewedPatch,
    revalidated_patch_identity: revalidatedPatch,
    patch_identity_matches: patchMatches,
    patch_identity_proven_unchanged: patchProvenUnchanged,
    reviewed_merge_result_identity: reviewedMergeResult,
    revalidated_merge_result_identity: revalidatedMergeResult,
    merge_result_identity_matches: mergeResultMatches,
    merge_result_identity_proven_unchanged: mergeResultProvenUnchanged,
    targeted_review_required: targetedReviewRequired,
    reasons,
  };
}

export function normalizeRiskDomain(value) {
  const normalized = normalizeForFingerprint(value).replace(/[\s-]+/gu, "_");
  return RISK_DOMAIN_ALIASES.get(normalized) ?? normalized;
}

function inferredCriticalDomains(cluster) {
  const declared = optionalStringList(
    cluster?.risk_domains,
    "cluster.risk_domains",
  ).map(normalizeRiskDomain);
  const text = [
    cluster?.invariant_key,
    cluster?.governing_invariant,
    ...(Array.isArray(cluster?.behavior_areas) ? cluster.behavior_areas : []),
    ...(Array.isArray(cluster?.affected_files) ? cluster.affected_files : []),
  ]
    .filter((value) => typeof value === "string")
    .join(" ");
  const inferred = CRITICAL_TEXT_PATTERNS.filter(([, pattern]) =>
    pattern.test(text),
  ).map(([domain]) => domain);
  return [
    ...new Set(
      [...declared, ...inferred].filter((domain) =>
        CRITICAL_RISK_DOMAINS.includes(domain),
      ),
    ),
  ].sort();
}

function profileOverride(env, profileName, field) {
  const key = PROFILE_ENV_KEYS[profileName][field];
  return optionalString(env?.[key]);
}

export function selectWorkerProfile({
  clusters = [],
  requestedProfile = null,
  failedNormalRepair = false,
  repeatedRootCauseFamilies = [],
  env = {},
  serviceTier = "priority",
} = {}) {
  if (!Array.isArray(clusters) || !Array.isArray(repeatedRootCauseFamilies)) {
    fail(
      "invalid_generation_contract",
      "clusters and repeatedRootCauseFamilies must be arrays",
    );
  }
  const explicitProfile = optionalString(
    requestedProfile ?? env.PR_REVIEW_FOLLOWUP_WORKER_PROFILE,
  );
  if (
    explicitProfile &&
    !Object.hasOwn(WORKER_PROFILE_DEFAULTS, explicitProfile)
  ) {
    fail(
      "invalid_worker_profile",
      `unsupported worker profile: ${explicitProfile}`,
    );
  }
  const escalationReasons = [];
  const criticalDomains = [
    ...new Set(clusters.flatMap(inferredCriticalDomains)),
  ].sort();
  escalationReasons.push(
    ...criticalDomains.map((domain) => `critical_risk:${domain}`),
  );
  if (failedNormalRepair) {
    escalationReasons.push("failed_normal_repair");
  }
  const currentRootCauseFamilies =
    repeatedRootCauseFamilies.length > 0
      ? new Set(clusters.map((cluster) => computeRootCauseFingerprint(cluster)))
      : new Set();
  for (const family of [
    ...new Set(
      repeatedRootCauseFamilies
        .map((value) => requiredString(value, "repeatedRootCauseFamilies"))
        .filter((value) => currentRootCauseFamilies.has(value)),
    ),
  ].sort()) {
    escalationReasons.push(`repeated_root_cause:${family}`);
  }

  let profileName = explicitProfile ?? "normal";
  if (profileName !== "manual_architecture" && escalationReasons.length > 0) {
    profileName = "critical";
  } else if (profileName === "critical" && escalationReasons.length === 0) {
    escalationReasons.push("explicit_critical_profile");
  } else if (profileName === "manual_architecture") {
    escalationReasons.unshift("explicit_manual_architecture_profile");
  }
  const defaults = WORKER_PROFILE_DEFAULTS[profileName];
  const effectiveServiceTier = optionalString(
    env.PR_REVIEW_FOLLOWUP_WORKER_SERVICE_TIER ?? serviceTier,
  );
  if (!effectiveServiceTier) {
    fail("invalid_worker_profile", "worker service tier is required");
  }
  return {
    name: profileName,
    model: profileOverride(env, profileName, "model") ?? defaults.model,
    reasoning_effort:
      profileOverride(env, profileName, "reasoning") ??
      defaults.reasoning_effort,
    service_tier: effectiveServiceTier,
    escalation_reason:
      escalationReasons.length > 0
        ? escalationReasons.join(",")
        : "ordinary_repair",
    escalation_reasons: escalationReasons,
    critical_risk_domains: criticalDomains,
    manually_selected: explicitProfile !== null,
  };
}

function parseModelCatalog(catalog) {
  let parsed = catalog;
  if (typeof catalog === "string") {
    try {
      parsed = JSON.parse(catalog);
    } catch (error) {
      fail(
        "invalid_worker_profile",
        `Codex model catalog is not valid JSON: ${error.message}`,
      );
    }
  }
  const record = asRecord(parsed, "catalog");
  if (!Array.isArray(record.models)) {
    fail(
      "invalid_worker_profile",
      "Codex model catalog must contain a models array",
    );
  }
  return record.models;
}

export function validateWorkerProfileAgainstCatalog(profile, catalog) {
  const selected = asRecord(profile, "profile");
  const models = parseModelCatalog(catalog);
  const model = models.find((candidate) => candidate?.slug === selected.model);
  if (!model) {
    fail(
      "invalid_worker_profile",
      `selected model is not installed: ${selected.model}`,
      {
        model: selected.model,
      },
    );
  }
  const efforts = Array.isArray(model.supported_reasoning_levels)
    ? model.supported_reasoning_levels.map((value) =>
        typeof value === "string" ? value : value?.effort,
      )
    : [];
  if (!efforts.includes(selected.reasoning_effort)) {
    fail(
      "invalid_worker_profile",
      `reasoning effort ${selected.reasoning_effort} is not supported by ${selected.model}`,
      {
        model: selected.model,
        supported_reasoning_efforts: efforts.filter(Boolean),
      },
    );
  }
  if (selected.service_tier !== "default") {
    const serviceTiers = Array.isArray(model.service_tiers)
      ? model.service_tiers.map((value) =>
          typeof value === "string" ? value : value?.id,
        )
      : [];
    if (!serviceTiers.includes(selected.service_tier)) {
      fail(
        "invalid_worker_profile",
        `service tier ${selected.service_tier} is not supported by ${selected.model}`,
        {
          model: selected.model,
          supported_service_tiers: ["default", ...serviceTiers.filter(Boolean)],
        },
      );
    }
  }
  return {
    ...selected,
    catalog_validated: true,
    catalog_model: model.slug,
  };
}

export function resolveWorkerProfile(options, catalog) {
  return validateWorkerProfileAgainstCatalog(
    selectWorkerProfile(options),
    catalog,
  );
}
