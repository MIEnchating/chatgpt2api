#!/usr/bin/env python3
"""Validate the final source inventory without reading local secrets or business data."""
import hashlib
import json
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parent.parent
inventory = json.loads((root / "review/inventory.json").read_text())
records = inventory["files"]
paths = set()
errors = []
for record in records:
    name = record["path"]
    if name in paths:
        errors.append(f"Duplicate record: {name}")
    paths.add(name)
    path = root / name
    if not path.resolve().is_relative_to(root) or not path.is_file():
        errors.append(f"Invalid path: {name}")
        continue
    data = path.read_bytes()
    if record["status"] != "reviewed" or not record.get("checks"):
        errors.append(f"Incomplete review: {name}")
    if record["sha256"] != hashlib.sha256(data).hexdigest():
        errors.append(f"Content changed after review: {name}")
    if record.get("bytes") is not None and record["bytes"] != len(data):
        errors.append(f"Incorrect byte count: {name}")
    if record.get("lines") is not None and record["lines"] != len(data.splitlines()):
        errors.append(f"Incorrect line count: {name}")

project_files = subprocess.check_output(
    ["git", "ls-files", "-c", "-o", "--exclude-standard", "-z"], cwd=root,
).decode().split("\0")
for name in project_files:
    if not name or name.startswith("review/") or name in {
        "REVIEW.md", "REVIEW-files-infra.md", "chatgpt2api.previous",
    }:
        continue
    if name not in paths:
        errors.append(f"Missing from inventory: {name}")
for path in (root / "review").glob("*.json"):
    json.loads(path.read_text())
if errors:
    raise SystemExit("\n".join(errors))
print(f"PASS: {len(records)} files reviewed; hashes, metadata and repository coverage match.")
