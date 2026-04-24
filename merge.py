"""
merge.py
--------
Merges a new heat-gauge dated JSON into the master data2.json.
Run this after historical_heatgauge.py generates a new file.

Usage:
    python merge.py

Place this script in the same folder as data2.json and your
generated heat-gauge-YYYY-MM-DD.json files.
"""

import json, os, glob
from datetime import datetime


DATA_FILE = "data2.json"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_json(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path: str, data: dict):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(f"  Saved → {os.path.abspath(path)}")


def find_new_files() -> list[str]:
    """Find all heat-gauge-*.json files in the current folder, excluding data2.json."""
    files = glob.glob("heat-gauge-*.json")
    return sorted(files)


def pick_file(files: list[str]) -> str:
    """Let the user pick which file to merge if there are multiple."""
    if not files:
        return None
    if len(files) == 1:
        return files[0]

    print("\nMultiple heat-gauge files found:")
    for i, f in enumerate(files):
        print(f"  {i+1}) {f}")
    print(f"  {len(files)+1}) Merge ALL of them")

    choice = input("\nSelect: ").strip()
    try:
        idx = int(choice) - 1
        if idx == len(files):
            return "__all__"
        return files[idx]
    except:
        print("Invalid choice.")
        return None


# ---------------------------------------------------------------------------
# Core merge logic
# ---------------------------------------------------------------------------

def merge_entries(existing: list, incoming: list) -> tuple[list, int, int]:
    """
    Merges incoming entries into existing, keyed by date.
    Returns (merged_list, added_count, skipped_count).
    """
    existing_dates = {e["date"]: i for i, e in enumerate(existing)}
    added   = 0
    skipped = 0

    for entry in incoming:
        d = entry["date"]
        if d in existing_dates:
            print(f"  [SKIP] {d} already exists in data2.json — skipping")
            skipped += 1
        else:
            existing.append(entry)
            existing_dates[d] = len(existing) - 1
            print(f"  [ADD]  {d} — {len(entry.get('runners', []))} runners")
            added += 1

    # Sort chronologically descending (newest first, matches existing pattern)
    existing.sort(key=lambda e: e["date"], reverse=True)
    return existing, added, skipped


def merge_file(master: dict, new_file: str) -> tuple[dict, int, int]:
    """Merge one dated JSON file into the master dict."""
    print(f"\nMerging: {new_file}")
    new_data = load_json(new_file)
    incoming = new_data.get("entries", [])

    merged, added, skipped = merge_entries(master.get("entries", []), incoming)

    master["entries"]    = merged
    master["count"]      = sum(len(e.get("runners", [])) for e in merged)
    master["exportedAt"] = datetime.utcnow().isoformat() + "Z"

    # Carry over thresholds from new file if master doesn't have them
    if "thresholds" not in master and "thresholds" in new_data:
        master["thresholds"] = new_data["thresholds"]

    return master, added, skipped


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    print("🔀 Heat Gauge — Merge Tool")
    print("=" * 40)

    # Load or initialize master
    if os.path.exists(DATA_FILE):
        print(f"\nLoading existing {DATA_FILE}...")
        master = load_json(DATA_FILE)
        print(f"  {len(master.get('entries', []))} existing days")
    else:
        print(f"\n{DATA_FILE} not found — will create a new one.")
        master = {
            "schema":     "heat-gauge.v1",
            "exportedAt": datetime.utcnow().isoformat() + "Z",
            "count":      0,
            "thresholds": {
                "hodHot":       150,
                "hodNeutralLo": 100,
                "fadeHot":      25,
                "fadeCold":     40,
            },
            "entries": [],
        }

    # Find files to merge
    new_files = find_new_files()
    if not new_files:
        print("\nNo heat-gauge-*.json files found in this folder.")
        print("Run historical_heatgauge.py first to generate one.")
        input("\nPress Enter to close...")
        return

    choice = pick_file(new_files)
    if not choice:
        input("\nPress Enter to close...")
        return

    files_to_merge = new_files if choice == "__all__" else [choice]

    total_added   = 0
    total_skipped = 0

    for f in files_to_merge:
        master, added, skipped = merge_file(master, f)
        total_added   += added
        total_skipped += skipped

    # Summary
    print(f"\n{'='*40}")
    print(f"  Days added   : {total_added}")
    print(f"  Days skipped : {total_skipped}")
    print(f"  Total days   : {len(master['entries'])}")
    print(f"  Total runners: {master['count']}")

    if total_added == 0:
        print("\n  Nothing new to save — data2.json unchanged.")
        input("\nPress Enter to close...")
        return

    save_json(DATA_FILE, master)

    # Ask if user wants to delete the merged source files
    if total_added > 0:
        print("\nDelete the merged source file(s) to keep the folder clean? (y/N):")
        if input("> ").strip().lower() in ("y", "yes"):
            for f in files_to_merge:
                os.remove(f)
                print(f"  Deleted {f}")

    print("\n✅ Done! Push data2.json via GitHub Desktop.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\nInterrupted.")
    except Exception as e:
        print(f"\nERROR: {e}")
        import traceback; traceback.print_exc()
    input("\nPress Enter to close...")
