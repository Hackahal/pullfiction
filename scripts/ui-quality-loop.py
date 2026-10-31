#!/usr/bin/env python3
"""Record real UI evidence and compare independent, fixed-rubric reviews.

This tool never drives a browser, creates screenshots, assigns scores or deploys.
Use the documented Codex browser API for captures and actual interaction checks.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import struct
import subprocess
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parent.parent
PROTOCOL = ROOT / "docs/ui-quality-protocol.json"
ROLES = {
    "consistency": ["component_consistency", "state_clarity", "icon_semantics", "warcraft_identity"],
    "layout": ["hierarchy_readability", "density_alignment", "scene_panel_composition", "adaptive_layout"],
    "interaction": ["selection_direct_manipulation", "camera_navigation", "timeline_control", "discoverability_recovery"],
}


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def read(path):
    return json.loads(Path(path).read_text())


def write(path, value):
    Path(path).write_text(json.dumps(value, indent=2) + "\n")


def jpeg_size(path):
    data = Path(path).read_bytes()
    if data[:2] != b"\xff\xd8":
        raise ValueError("Capture must be an actual JPEG, not a renamed file")
    offset = 2
    while offset + 4 <= len(data):
        if data[offset] != 255:
            raise ValueError("Invalid JPEG marker")
        marker = data[offset + 1]
        offset += 2
        if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
            continue
        length = struct.unpack_from(">H", data, offset)[0]
        if length < 2 or offset + length > len(data):
            raise ValueError("Truncated JPEG")
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            height, width = struct.unpack_from(">HH", data, offset + 3)
            return [width, height]
        offset += length
    raise ValueError("JPEG dimensions not found")


def source_fingerprint():
    digest = hashlib.sha256()
    for path in sorted((ROOT / "web/editor/src").rglob("*")):
        if path.is_file():
            digest.update(str(path.relative_to(ROOT)).encode())
            digest.update(path.read_bytes())
    return digest.hexdigest()


def evidence(round_dir, name):
    path = (round_dir / name).resolve()
    if not path.is_relative_to(round_dir.resolve()) or not path.is_file():
        raise ValueError(f"Evidence must be an existing file inside the round: {name}")
    return path


def summarize(round_dir):
    record = read(round_dir / "round.json")
    protocol = read(round_dir / "protocol.json")
    seal = round_dir / "seal.json"
    if seal.exists():
        for name, digest in read(seal)["files"].items():
            if sha(evidence(round_dir, name)) != digest:
                raise ValueError(f"Sealed evidence changed: {name}")
    for capture in record["captures"].values():
        if sha(evidence(round_dir, capture["image"])) != capture["sha256"]:
            raise ValueError("Recorded screenshot changed; create a new round")
    reviews = {}
    for role, criteria in ROLES.items():
        path = round_dir / f"judge-{role}.json"
        if not path.exists():
            continue
        review = read(path)
        scores = review.get("scores", {})
        if review.get("role") != role or set(scores) != set(criteria):
            raise ValueError(f"Wrong role or criteria: {path.name}")
        if any(isinstance(s, bool) or not isinstance(s, (int, float)) or not math.isfinite(s) or not 0 <= s <= 10 for s in scores.values()):
            raise ValueError(f"Invalid score: {path.name}")
        if not review.get("evidence") or not review.get("limitations"):
            raise ValueError(f"Review requires evidence and coverage limitations: {path.name}")
        for finding in review["evidence"]:
            if not isinstance(finding, dict) or not finding.get("file") or not finding.get("finding"):
                raise ValueError(f"Review evidence needs file and finding: {path.name}")
            evidence(round_dir, finding["file"])
        unknown = review.get("unverified_interactions", [])
        if not isinstance(unknown, list) or any(not isinstance(key, str) for key in unknown):
            raise ValueError(f"Unverified interactions must be an array of protocol ID strings: {path.name}")
        if not set(unknown) <= set(protocol["interactions"]):
            raise ValueError(f"Unknown unverified interaction in {path.name}")
        reviews[role] = {"scores": scores, "mean": round(sum(scores.values()) / len(scores), 2), "blockers": review.get("blockers", []), "unverified_interactions": unknown}
    required = set(protocol["captures"])
    captured = set(record["captures"])
    checks = set(protocol["interactions"])
    passed = {key for key, value in record["interactions"].items() if value["status"] == "pass"}
    observed = {key for key, value in record["interactions"].items() if value["status"] in ("pass", "fail")}
    observed -= {key for review in reviews.values() for key in review["unverified_interactions"]}
    failed = {key for key, value in record["interactions"].items() if value["status"] == "fail"}
    for check in record["interactions"].values():
        if sha(evidence(round_dir, check["evidence"])) != check["sha256"]:
            raise ValueError("Recorded interaction evidence changed")
    complete = required <= captured and checks <= observed and set(reviews) == set(ROLES)
    mean = round(sum(r["mean"] for r in reviews.values()) / len(reviews), 2) if reviews else None
    return {"round": round_dir.name, "protocol_sha256": sha(round_dir / "protocol.json"), "fixture": record["fixture"], "captures": len(required & captured), "capture_total": len(required), "capture_gaps": sorted(required - captured), "interactions_passed": len(checks & passed), "interaction_total": len(checks), "interaction_gaps": sorted(checks - observed), "interaction_failures": sorted(checks & failed), "reviews": reviews, "mean": mean, "benchmark_complete": complete, "acceptance_passed": complete and checks <= passed and not any(r["blockers"] for r in reviews.values()), "label": "complete benchmark" if complete else "provisional - incomplete coverage"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["init", "capture", "interaction", "seal", "report"])
    parser.add_argument("round", type=Path)
    parser.add_argument("--fixture")
    parser.add_argument("--id")
    parser.add_argument("--image")
    parser.add_argument("--state")
    parser.add_argument("--status", choices=["pass", "fail", "blocked", "unrun"])
    parser.add_argument("--notes")
    parser.add_argument("--evidence")
    parser.add_argument("--compare", type=Path)
    args = parser.parse_args()
    directory = args.round.resolve()
    record_path = directory / "round.json"
    if args.command == "init":
        if record_path.exists() or not args.fixture:
            parser.error("A new round and --fixture are required")
        directory.mkdir(parents=True, exist_ok=True)
        write(directory / "protocol.json", read(PROTOCOL))
        write(record_path, {"created": datetime.now(timezone.utc).isoformat(), "commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(), "ui_source_sha256": source_fingerprint(), "fixture": args.fixture, "captures": {}, "interactions": {}})
    elif args.command in ("capture", "interaction"):
        if (directory / "seal.json").exists():
            parser.error("Round is sealed; create a new round")
        record = read(record_path)
        if not args.id:
            parser.error("--id is required")
        if args.command == "capture":
            if not args.image or not args.state:
                parser.error("--image and --state are required")
            path = evidence(directory, args.image)
            if args.id in record["captures"]:
                parser.error("Capture already recorded; use a new round")
            record["captures"][args.id] = {"image": args.image, "sha256": sha(path), "viewport": jpeg_size(path), "state": args.state}
        else:
            if not args.status or not args.notes or not args.evidence:
                parser.error("--status, --notes and --evidence are required")
            path = evidence(directory, args.evidence)
            record["interactions"][args.id] = {"status": args.status, "notes": args.notes, "evidence": args.evidence, "sha256": sha(path)}
        write(record_path, record)
    elif args.command == "seal":
        if (directory / "seal.json").exists():
            parser.error("Round already sealed")
        record = read(record_path)
        names = {"round.json", "protocol.json"}
        for capture in record["captures"].values():
            names.add(capture["image"])
            ax = str(Path(capture["image"]).with_suffix(".ax.txt"))
            if (directory / ax).exists():
                names.add(ax)
        names.update(check["evidence"] for check in record["interactions"].values())
        write(directory / "seal.json", {"created": datetime.now(timezone.utc).isoformat(), "files": {name: sha(evidence(directory, name)) for name in sorted(names)}})
    else:
        result = summarize(directory)
        if args.compare:
            previous = summarize(args.compare.resolve())
            comparable = previous["protocol_sha256"] == result["protocol_sha256"] and previous["fixture"] == result["fixture"]
            before = read(args.compare / "round.json")["captures"]
            after = read(record_path)["captures"]
            matching = {key for key in before.keys() & after.keys() if before[key]["viewport"] == after[key]["viewport"] and before[key]["state"] == after[key]["state"]}
            result["comparison"] = {"previous": previous["round"], "same_protocol_and_fixture": comparable, "matching_contexts": sorted(matching), "score_delta": round(result["mean"] - previous["mean"], 2) if comparable and result["benchmark_complete"] and previous["benchmark_complete"] and set(read(directory / "protocol.json")["captures"]) <= matching and result["mean"] is not None and previous["mean"] is not None else None}
        write(directory / "summary.json", result)
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, FileNotFoundError) as error:
        raise SystemExit(str(error)) from error
