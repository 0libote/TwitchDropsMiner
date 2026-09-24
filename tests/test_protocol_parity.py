from __future__ import annotations

import re
import unittest
from pathlib import Path

from constants import GQL_QUERIES


class ProtocolParityTests(unittest.TestCase):
    def test_bun_query_names_and_hashes_match_python(self) -> None:
        source = (Path(__file__).resolve().parents[1] / "src/twitchProtocol.ts").read_text(
            encoding="utf8"
        )
        bun_queries = {
            key: (operation, digest)
            for key, operation, digest in re.findall(
                r'^\s*(\w+): q\("([^"]+)", "([0-9a-f]{64})"', source, re.MULTILINE
            )
        }
        python_queries = {
            key: (
                query["operationName"],
                query["extensions"]["persistedQuery"]["sha256Hash"],
            )
            for key, query in GQL_QUERIES.items()
        }
        self.assertEqual(bun_queries, python_queries)
