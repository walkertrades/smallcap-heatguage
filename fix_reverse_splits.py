"""
fix_reverse_splits.py
---------------------
Removes runners with HOD% above MAX_HOD_PCT from data2.json.
Targets reverse split artifacts that show up as 10,000%+ moves.

Also updates day-level hod/fade averages after removals.

Usage:
    python fix_reverse_splits.py
"""

import json, os, shutil

DATA_FILE   = r"D:\Projects\smallcap-heatguage\data2.json"
BACKUP_FILE = DATA_FILE.replace(".json", "_backup_pre_splitfix.json")

MAX_HOD_PCT = 10000   # anything above this is almost certainly a reverse split

# ---------------------------------------------------------------------------

def main():
    print("Reverse Split Artifact Remover")
    print("=" * 40)

    if not os.path.exists(DATA_FILE):
        print(f"ERROR: {DATA_FILE} not found.")
        input("\nPress Enter to close...")
        return

    shutil.copy2(DATA_FILE, BACKUP_FILE)
    print(f"  Backup saved -> {BACKUP_FILE}")

    with open(DATA_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)

    total_removed = 0
    affected_days = 0

    for entry in data.get("entries", []):
        runners_before = entry.get("runners", [])
        runners_after  = [r for r in runners_before
                          if (r.get("hodExact") or r.get("hod") or 0) <= MAX_HOD_PCT]

        removed = len(runners_before) - len(runners_after)
        if removed > 0:
            affected_days += 1
            total_removed += removed
            for r in runners_before:
                if r not in runners_after:
                    print(f"  [{entry['date']}] REMOVED {r.get('sym')} +{r.get('hodExact') or r.get('hod')}%")

            entry["runners"] = runners_after

            # Recalculate day-level averages from remaining runners
            if runners_after:
                entry["hod"]  = runners_after[0].get("hod", 0)
                entry["fade"] = round(sum(r.get("fade", 0) for r in runners_after) / len(runners_after))
            else:
                entry["hod"]  = 0
                entry["fade"] = 0

    # Update top-level count
    data["count"] = sum(len(e.get("runners", [])) for e in data.get("entries", []))

    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    print(f"\nDone!")
    print(f"   Runners removed : {total_removed}")
    print(f"   Days affected   : {affected_days}")
    print(f"   Total remaining : {data['count']}")
    print(f"\n-> Push data2.json via GitHub Desktop.")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"\nERROR: {e}")
        import traceback; traceback.print_exc()
    input("\nPress Enter to close...")
