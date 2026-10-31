"""Integrity tests use disposable records, never browser acceptance evidence."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("ui_quality_loop", Path(__file__).with_name("ui-quality-loop.py"))
loop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(loop)

class QualityEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "unit-evidence.txt").write_text("Disposable unit fixture, not a browser check")
        loop.write(self.root / "protocol.json", {"captures": ["scene"], "interactions": ["selection"]})
        self.record = {"fixture": "unit-only", "captures": {}, "interactions": {}}
        loop.write(self.root / "round.json", self.record)

    def test_incomplete_coverage_cannot_pass(self):
        result = loop.summarize(self.root)
        self.assertFalse(result["benchmark_complete"])
        self.assertFalse(result["acceptance_passed"])
        self.assertEqual(result["interaction_gaps"], ["selection"])

    def test_evidence_cannot_escape_round(self):
        with self.assertRaises(ValueError):
            loop.evidence(self.root, "../outside.txt")

    def test_sealed_changes_are_rejected(self):
        loop.write(self.root / "seal.json", {"files": {"unit-evidence.txt": loop.sha(self.root / "unit-evidence.txt")}})
        (self.root / "unit-evidence.txt").write_text("changed")
        with self.assertRaisesRegex(ValueError, "Sealed evidence changed"):
            loop.summarize(self.root)

    def test_boolean_nan_and_out_of_range_scores_are_rejected(self):
        for invalid in (True, float("nan"), -1, 11):
            scores = dict.fromkeys(loop.ROLES["consistency"], 7)
            scores["component_consistency"] = invalid
            loop.write(self.root / "judge-consistency.json", {"role": "consistency", "scores": scores, "evidence": [{"file": "unit-evidence.txt", "finding": "unit fixture"}], "limitations": ["unit only"]})
            with self.assertRaisesRegex(ValueError, "Invalid score"):
                loop.summarize(self.root)

    def test_malformed_unverified_interactions_give_a_clear_validation_error(self):
        loop.write(self.root / "judge-consistency.json", {"role": "consistency", "scores": dict.fromkeys(loop.ROLES["consistency"], 7), "evidence": [{"file": "unit-evidence.txt", "finding": "unit fixture"}], "limitations": ["unit only"], "unverified_interactions": [{"id": "selection"}]})
        with self.assertRaisesRegex(ValueError, "array of protocol ID strings"):
            loop.summarize(self.root)

    def test_renamed_png_is_not_accepted_as_jpeg(self):
        path = self.root / "not-jpeg.jpg"
        path.write_bytes(b"\x89PNG\r\n\x1a\n")
        with self.assertRaisesRegex(ValueError, "actual JPEG"):
            loop.jpeg_size(path)

    def test_observed_failure_is_coverage_but_never_acceptance(self):
        self.record["captures"]["scene"] = {"image": "unit-evidence.txt", "sha256": loop.sha(self.root / "unit-evidence.txt"), "viewport": [1, 1], "state": "unit fixture"}
        self.record["interactions"]["selection"] = {"status": "fail", "notes": "unit assertion", "evidence": "unit-evidence.txt", "sha256": loop.sha(self.root / "unit-evidence.txt")}
        loop.write(self.root / "round.json", self.record)
        for role, criteria in loop.ROLES.items():
            loop.write(self.root / f"judge-{role}.json", {"role": role, "scores": dict.fromkeys(criteria, 7), "evidence": [{"file": "unit-evidence.txt", "finding": "unit assertion"}], "limitations": ["unit only"]})
        result = loop.summarize(self.root)
        self.assertTrue(result["benchmark_complete"])
        self.assertFalse(result["acceptance_passed"])
        self.assertEqual(result["interaction_failures"], ["selection"])
        review = loop.read(self.root / "judge-interaction.json")
        review["unverified_interactions"] = ["selection"]
        loop.write(self.root / "judge-interaction.json", review)
        self.assertFalse(loop.summarize(self.root)["benchmark_complete"])

if __name__ == "__main__":
    unittest.main()
