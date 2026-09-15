#!/usr/bin/env python3
"""Check the current review snapshot without changing its recorded evidence."""
import hashlib
import json
import subprocess
from collections import Counter
from pathlib import Path


def main():
    root = Path(__file__).resolve().parent.parent
    manifest_path = root / "review/current-inventory.json"
    inventory = json.loads(manifest_path.read_text())
    records = inventory["files"]
    paths = set()
    errors = []
    statuses = Counter()
    for record in records:
        name = record["path"]
        if name in paths:
            errors.append(f"Duplicate record: {name}")
        paths.add(name)
        path = root / name
        if not path.resolve().is_relative_to(root) or not path.is_file():
            errors.append(f"Invalid path: {name}")
            continue
        status = record["status"]
        statuses[status] += 1
        if not record.get("checks"):
            errors.append(f"Missing review method: {name}")
        if status == "excluded":
            if not record.get("reason"):
                errors.append(f"Missing exclusion reason: {name}")
            continue
        if status == "inventory-self":
            if path != manifest_path:
                errors.append(f"Invalid self reference: {name}")
            continue
        if status not in {"reviewed", "reviewed-metadata"}:
            errors.append(f"Incomplete review: {name}")
            continue
        data = path.read_bytes()
        if record.get("sha256") != hashlib.sha256(data).hexdigest():
            errors.append(f"Content changed after review: {name}")
        if record.get("bytes") != len(data):
            errors.append(f"Incorrect byte count: {name}")
        if record.get("lines") is not None and record["lines"] != len(data.splitlines()):
            errors.append(f"Incorrect line count: {name}")

    project_files = set(filter(None, subprocess.check_output(
        ["git", "ls-files", "-c", "-o", "--exclude-standard", "-z"], cwd=root,
    ).decode().split("\0")))
    errors.extend(f"Missing from inventory: {name}" for name in sorted(project_files - paths))
    errors.extend(f"No longer in repository scope: {name}" for name in sorted(paths - project_files))
    if statuses["inventory-self"] != 1:
        errors.append("Expected exactly one inventory self reference")
    for path in (root / "review").glob("*.json"):
        json.loads(path.read_text())
    if errors:
        raise SystemExit("\n".join(errors))
    print(f"PASS: {len(records)} files accounted for; {dict(statuses)}; hashes and coverage match.")


if __name__ == "__main__":
    main()
