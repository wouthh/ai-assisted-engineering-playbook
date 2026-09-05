"""Synthetic order-review decision used by the public walkthrough."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class Decision(str, Enum):
    APPROVED = "approved"
    MANUAL_REVIEW = "manual_review"


@dataclass(frozen=True)
class OrderRequest:
    order_id: str
    amount_cents: int


def decide_order(request: OrderRequest, *, review_threshold_cents: int) -> Decision:
    """Return a deterministic decision for validated synthetic order input."""
    if not request.order_id.strip():
        raise ValueError("order_id is required")
    if request.amount_cents <= 0:
        raise ValueError("amount_cents must be positive")
    if review_threshold_cents <= 0:
        raise ValueError("review_threshold_cents must be positive")
    if request.amount_cents > review_threshold_cents:
        return Decision.MANUAL_REVIEW
    return Decision.APPROVED
