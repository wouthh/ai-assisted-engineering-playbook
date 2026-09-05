from __future__ import annotations

import sys
import unittest
from pathlib import Path


SOURCE = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SOURCE))

from order_rules import Decision, OrderRequest, decide_order  # noqa: E402


class OrderRuleTests(unittest.TestCase):
    def test_order_below_threshold_is_approved(self) -> None:
        request = OrderRequest(order_id="synthetic-001", amount_cents=9_999)
        self.assertEqual(decide_order(request, review_threshold_cents=10_000), Decision.APPROVED)

    def test_order_at_threshold_is_approved(self) -> None:
        request = OrderRequest(order_id="synthetic-002", amount_cents=10_000)
        self.assertEqual(decide_order(request, review_threshold_cents=10_000), Decision.APPROVED)

    def test_order_above_threshold_requires_review(self) -> None:
        request = OrderRequest(order_id="synthetic-003", amount_cents=10_001)
        self.assertEqual(decide_order(request, review_threshold_cents=10_000), Decision.MANUAL_REVIEW)

    def test_missing_order_id_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "order_id"):
            decide_order(OrderRequest(order_id=" ", amount_cents=100), review_threshold_cents=10_000)

    def test_non_positive_amount_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "amount_cents"):
            decide_order(OrderRequest(order_id="synthetic-004", amount_cents=0), review_threshold_cents=10_000)

    def test_non_positive_threshold_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "review_threshold_cents"):
            decide_order(OrderRequest(order_id="synthetic-005", amount_cents=100), review_threshold_cents=0)


if __name__ == "__main__":
    unittest.main()
