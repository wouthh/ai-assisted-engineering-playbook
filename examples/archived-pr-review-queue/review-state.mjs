export const DEFAULT_SELECTED_REVIEWER = "codex";
export const SUPPORTED_REVIEWERS = ["codex", "copilot"];
export const REVIEWER_CONFIGS = Object.freeze({
  codex: Object.freeze({
    key: "codex",
    displayName: "Codex",
    loginPattern: "codex",
    requestType: "comment",
    requestCommentBody: "@codex review",
    requestReviewer: null,
    allowPassiveWaitWithoutRequest: true,
  }),
  copilot: Object.freeze({
    key: "copilot",
    displayName: "Copilot",
    loginPattern: "copilot",
    requestType: "add_reviewer",
    requestCommentBody: null,
    requestReviewer: "@copilot",
    allowPassiveWaitWithoutRequest: false,
  }),
});
export const DEFAULT_REVIEWER_LOGIN_PATTERN =
  REVIEWER_CONFIGS[DEFAULT_SELECTED_REVIEWER].loginPattern;
export const DEFAULT_REVIEW_REQUEST_COMMENT_BODY =
  REVIEWER_CONFIGS[DEFAULT_SELECTED_REVIEWER].requestCommentBody;
const FALLBACK_REVIEWER_LOGIN_REGEX = /codex/i;

export function isSupportedReviewer(value) {
  return SUPPORTED_REVIEWERS.includes(
    String(value ?? "")
      .trim()
      .toLowerCase(),
  );
}

export function normalizeReviewer(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return isSupportedReviewer(normalized) ? normalized : null;
}

export function getReviewerConfig(
  reviewer = DEFAULT_SELECTED_REVIEWER,
  overrides = {},
) {
  const reviewerKey = normalizeReviewer(reviewer);
  if (!reviewerKey) {
    throw new Error(`Unsupported reviewer: ${reviewer}`);
  }

  const baseConfig = REVIEWER_CONFIGS[reviewerKey];
  const loginPattern =
    trimToNull(overrides.loginPattern) ?? baseConfig.loginPattern;
  const requestCommentBody =
    trimToNull(overrides.requestCommentBody) ?? baseConfig.requestCommentBody;
  const requestReviewer =
    trimToNull(overrides.requestReviewer) ?? baseConfig.requestReviewer;

  return {
    ...baseConfig,
    loginPattern,
    requestCommentBody,
    requestReviewer,
  };
}

export function buildReviewerLoginRegex(
  patternSource = DEFAULT_REVIEWER_LOGIN_PATTERN,
  fallbackPatternSource = DEFAULT_REVIEWER_LOGIN_PATTERN,
) {
  const raw = String(patternSource ?? "").trim();
  if (!raw) {
    return buildFallbackReviewerLoginRegex(fallbackPatternSource);
  }

  const slashPattern = raw.match(/^\/(.+)\/([a-z]*)$/i);
  if (slashPattern) {
    try {
      return new RegExp(slashPattern[1], slashPattern[2] || "i");
    } catch {
      return buildFallbackReviewerLoginRegex(fallbackPatternSource);
    }
  }

  try {
    return new RegExp(escapeRegex(raw), "i");
  } catch {
    return buildFallbackReviewerLoginRegex(fallbackPatternSource);
  }
}

export function reviewerLoginMatches(
  login,
  patternSource = DEFAULT_REVIEWER_LOGIN_PATTERN,
  fallbackPatternSource = DEFAULT_REVIEWER_LOGIN_PATTERN,
) {
  return buildReviewerLoginRegex(patternSource, fallbackPatternSource).test(
    String(login ?? "").trim(),
  );
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildFallbackReviewerLoginRegex(
  patternSource = DEFAULT_REVIEWER_LOGIN_PATTERN,
) {
  const raw = trimToNull(patternSource) ?? DEFAULT_REVIEWER_LOGIN_PATTERN;
  try {
    return new RegExp(escapeRegex(raw), "i");
  } catch {
    return FALLBACK_REVIEWER_LOGIN_REGEX;
  }
}

function trimToNull(value) {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized : null;
}

export function requestCycleJustStarted({
  requestedReviewAt,
  lastReviewCycleRequestedAt,
  requestReviewRequested,
}) {
  if (!requestReviewRequested || requestedReviewAt === null) {
    return false;
  }
  if (lastReviewCycleRequestedAt === null) {
    return true;
  }

  const requestedAtMs = Date.parse(requestedReviewAt);
  const lastRequestedAtMs = Date.parse(lastReviewCycleRequestedAt);
  if (Number.isFinite(requestedAtMs) && Number.isFinite(lastRequestedAtMs)) {
    return requestedAtMs !== lastRequestedAtMs;
  }

  return requestedReviewAt !== lastReviewCycleRequestedAt;
}

export function requestReviewComparisonTimestampMs(requestedReviewAt) {
  const timestampMs = Date.parse(String(requestedReviewAt ?? "").trim());
  return Number.isFinite(timestampMs)
    ? Math.floor(timestampMs / 1000) * 1000
    : null;
}

export function shouldReuseRequestedReviewAt(input) {
  const hasStructuredOptions = input && typeof input === "object";
  const options = hasStructuredOptions
    ? input
    : {
        previousReviewCycleState: input,
      };
  const previousReviewCycleState = String(
    options.previousReviewCycleState ?? "",
  ).trim();
  if (
    !hasStructuredOptions &&
    (previousReviewCycleState === "review_pending" ||
      previousReviewCycleState === "review_pending_timeout")
  ) {
    return true;
  }

  const lastReviewCycleRequestedAt = trimToNull(
    options.lastReviewCycleRequestedAt,
  );
  if (lastReviewCycleRequestedAt === null) {
    return false;
  }

  const currentHeadOid = trimToNull(options.currentHeadOid);
  const lastReviewCycleHeadOid = trimToNull(options.lastReviewCycleHeadOid);
  // A known current head needs a saved head binding that matches it exactly.
  if (
    currentHeadOid !== null &&
    (lastReviewCycleHeadOid === null || currentHeadOid !== lastReviewCycleHeadOid)
  ) {
    return false;
  }

  if (
    previousReviewCycleState === "review_pending" ||
    previousReviewCycleState === "review_pending_timeout"
  ) {
    return true;
  }
  if (
    previousReviewCycleState === "review_completed_no_findings" ||
    previousReviewCycleState === "review_repeated_seen_set"
  ) {
    return true;
  }
  return false;
}

export function repeatedSeenSetMatchesBaseline({
  requestedReviewAt,
  freshReviewerActivityObserved,
  baselineRecordedForCycle,
  baselineFingerprintHash,
  currentFingerprintHash,
}) {
  if (
    !freshReviewerActivityObserved ||
    requestedReviewAt === null ||
    !baselineRecordedForCycle
  ) {
    return false;
  }
  if (baselineFingerprintHash === null && currentFingerprintHash === null) {
    return true;
  }
  if (baselineFingerprintHash === null || currentFingerprintHash === null) {
    return false;
  }

  return currentFingerprintHash === baselineFingerprintHash;
}

export function determineReviewCycleState({
  requestedReviewAt,
  previousReviewCycleState,
  freshReviewerActivityObserved,
  reviewerRemarksCount,
  newUniqueReviewerRemarksCount,
  repeatedSeenSetMatchesBaseline,
  unresolvedReviewCycleReviewerThreads = 0,
  reviewCycleVisibleWithoutRequest = false,
  requestCycleJustStarted = false,
}) {
  const reviewCycleVisible =
    requestedReviewAt || reviewCycleVisibleWithoutRequest;
  if (Number(unresolvedReviewCycleReviewerThreads) > 0) {
    if (newUniqueReviewerRemarksCount > 0) {
      return "new_comments_found";
    }
    if (repeatedSeenSetMatchesBaseline || reviewerRemarksCount > 0) {
      return "review_repeated_seen_set";
    }
    if (requestedReviewAt) {
      return "review_pending";
    }
    return "fetched";
  }
  if (newUniqueReviewerRemarksCount > 0) {
    return "new_comments_found";
  }
  if (
    reviewCycleVisible &&
    freshReviewerActivityObserved &&
    reviewerRemarksCount === 0
  ) {
    return "review_completed_no_findings";
  }
  if (
    freshReviewerActivityObserved &&
    (repeatedSeenSetMatchesBaseline ||
      (reviewerRemarksCount > 0 && newUniqueReviewerRemarksCount === 0))
  ) {
    return "review_repeated_seen_set";
  }
  if (
    requestedReviewAt &&
    previousReviewCycleState === "review_pending_timeout" &&
    !requestCycleJustStarted
  ) {
    return "review_pending_timeout";
  }
  if (requestedReviewAt) {
    return "review_pending";
  }
  return "fetched";
}

export function normalizeReviewPendingTimeoutSummary(summary, options = {}) {
  const actionRequired = String(
    options.actionRequired ??
      summary?.workflow?.action_required ??
      "wait_for_fresh_review_cycle",
  );
  const blockingReason =
    String(options.blockingReason ?? "").trim() ||
    "Reviewer activity did not appear before timeout. Do not merge, close, or delete the branch.";
  return {
    ...summary,
    status: "review_pending_timeout",
    review_cycle: {
      ...(summary?.review_cycle ?? {}),
      state: "review_pending_timeout",
    },
    workflow: {
      ...(summary?.workflow ?? {}),
      action_required: actionRequired,
      may_finish_task: false,
      may_merge_pr: false,
      do_not_merge: true,
      terminal_for_wait_loop: false,
      blocking_reason: blockingReason,
    },
  };
}

export function reviewCycleBlockingReason({
  mayMergePr,
  reviewCycleState,
  noReviewRequestedYet,
}) {
  if (mayMergePr) {
    return null;
  }
  if (reviewCycleState === "new_comments_found") {
    return "New reviewer remarks were found and still need implementation before the PR can pass.";
  }
  if (reviewCycleState === "review_repeated_seen_set") {
    return "The reviewer repeated the same remarks. Wait for a no-comments pass before marking this complete.";
  }
  if (reviewCycleState === "review_pending_timeout") {
    return "Reviewer activity timed out after a request. Re-request review or inspect the saved state before merging.";
  }
  if (noReviewRequestedYet) {
    return "No review request recorded yet; run with --request-review.";
  }
  return "A fresh terminal reviewer cycle is not visible yet. Do not merge, close, or delete the branch.";
}

export function stripReviewerBoilerplate(body) {
  const normalized = String(body ?? "").trim();
  if (!normalized) {
    return "";
  }

  return normalized
    .replace(/^###\s*(?:💡\s*)?(?:Codex|Copilot) Review\s*/iu, "")
    .replace(/\*\*Reviewed commit:\*\*.*$/imu, "")
    .replace(
      /Here are some automated review suggestions for this pull request\.\s*/iu,
      "",
    )
    .replace(/<details>[\s\S]*?<\/details>/giu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isNoFindingsReviewerMessage(body) {
  const stripped = stripReviewerBoilerplate(body);
  if (!stripped) {
    return false;
  }

  if (
    /\bgenerated no new comments\b/i.test(stripped) ||
    /\bno new comments were generated\b/i.test(stripped)
  ) {
    return true;
  }

  if (
    /^(?:(?:codex|copilot) review:\s*)?(?:did(?:n't| not) find any (?:major )?issues|0 comments were generated|generated no new comments|no (?:new )?comments(?: were generated)?|no new threads opened|no issues|no suggestions|no feedback)\b/i.test(
      stripped,
    )
  ) {
    return true;
  }

  return (
    /status\/summary update/i.test(stripped) &&
    /not a new reviewer finding or requested fix/i.test(stripped) &&
    /no concrete follow-up code changes to apply right now/i.test(stripped)
  );
}

export function extractActionableReviewSummaryBody(body) {
  const stripped = stripReviewerBoilerplate(body);
  if (!stripped || isNoFindingsReviewerMessage(stripped)) {
    return null;
  }

  return stripped;
}
