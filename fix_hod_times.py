"""
fix_hod_times.py
----------------
One-off correction for hodTimeExact and time (session/premarket) fields
in data2.json. Fixes the timezone bug where .astimezone() on an EST machine
caused HOD times to be shifted 5 hours too early.

Adds 5 hours to every hodTimeExact string and recalculates session/premarket.

Usage:
    python fix_hod_times.py
"""

import json, os, re, shutil
from datetime import datetime, timedelta

DATA_FILE  = r"D:\Projects\smallcap-heatguage\data2.json"
BACKUP_FILE = DATA_FILE.replace(".json", "_backup_pre_hodfix.json")

MARKET_OPEN_ET  = 9.5   # 9:30 AM
MARKET_CLOSE_ET = 16.0  # 4:00 PM

def et_offset(date_str):
    """
    Return the ET offset error introduced by the timezone bug.
    The bug: .astimezone() converted UTC to local EST (UTC-5), then
    subtracted 4 more hours, giving an effective offset of UTC-9.
    Correct ET is EDT (UTC-4) Mar-Nov, EST (UTC-5) Nov-Mar.
    So the error = correct_offset - applied_offset.
    EDT months: correct=-4, applied=-9, error=+5... wait
    Actually simpler: the script subtracted 4 from local time.
    Local (EST) = UTC-5. Then -4 more = UTC-9.
    Correct EDT = UTC-4. So stored = UTC-9, correct = UTC-4 → add 5 for EDT months.
    Correct EST = UTC-5. So stored = UTC-9, correct = UTC-5 → add 4 for EST months.
    DST in US: starts 2nd Sunday March, ends 1st Sunday November.
    """
    if not date_str:
        return 4
    try:
        from datetime import date as _date
        import calendar
        d = _date.fromisoformat(date_str[:10])
        year, month, day = d.year, d.month, d.day

        # Find 2nd Sunday of March (DST start)
        march_days = [i for i in range(1, 32)
                      if _date(year, 3, i).weekday() == 6]
        dst_start = _date(year, 3, march_days[1])  # 2nd Sunday

        # Find 1st Sunday of November (DST end)
        nov_days = [i for i in range(1, 31)
                    if _date(year, 11, i).weekday() == 6]
        dst_end = _date(year, 11, nov_days[0])  # 1st Sunday

        if dst_start <= d < dst_end:
            return 5   # EDT: stored UTC-9, correct UTC-4, add 5
        else:
            return 4   # EST: stored UTC-9, correct UTC-5, add 4
    except:
        return 4   # safe default


# Only fix entries BEFORE this date (evening recap was fixed on this date)
CUTOFF_DATE = "2026-03-19"

# ---------------------------------------------------------------------------

def parse_hod_time(s):
    """
    Parse a hodTimeExact string like '07:19 AM ET' or '11:45 PM ET'.
    Returns (hour_24, minute) in ET, or None if unparseable.
    """
    if not s:
        return None, None
    m = re.match(r'(\d{1,2}):(\d{2})\s*(AM|PM)', s.strip(), re.IGNORECASE)
    if not m:
        return None, None
    h, mn, ampm = int(m.group(1)), int(m.group(2)), m.group(3).upper()
    if ampm == "AM":
        if h == 12: h = 0
    else:
        if h != 12: h += 12
    return h, mn


def format_hod_time(h24, mn):
    """Format (hour_24, minute) back to '09:47 AM ET' style."""
    ampm  = "AM" if h24 < 12 else "PM"
    disp  = h24 if h24 <= 12 else h24 - 12
    if disp == 0: disp = 12
    return f"{disp:02d}:{mn:02d} {ampm} ET"


def correct_time(hod_time_str, offset_hours=5):
    """
    Add offset_hours to a hodTimeExact string.
    Returns (new_hod_time_str, new_session_label).
    """
    h, mn = parse_hod_time(hod_time_str)
    if h is None:
        return hod_time_str, "session"   # can't parse — leave as-is

    # Add offset, wrap at 24h
    total_min = h * 60 + mn + offset_hours * 60
    new_h     = (total_min // 60) % 24
    new_mn    = total_min % 60

    new_str     = format_hod_time(new_h, new_mn)
    time_dec    = new_h + new_mn / 60
    new_session = "premarket" if time_dec < MARKET_OPEN_ET else "session"

    return new_str, new_session


# ---------------------------------------------------------------------------

def main():
    print("🔧 HOD Time Correction Tool")
    print("=" * 40)

    if not os.path.exists(DATA_FILE):
        print(f"ERROR: {DATA_FILE} not found.")
        input("\nPress Enter to close...")
        return

    # Backup first
    shutil.copy2(DATA_FILE, BACKUP_FILE)
    print(f"  Backup saved → {BACKUP_FILE}")

    with open(DATA_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)

    entries        = data.get("entries", [])
    total_runners  = 0
    total_fixed    = 0
    session_flips  = 0   # premarket → session corrections

    for entry in entries:
        # Skip entries on or after the cutoff date
        if entry.get("date", "") >= CUTOFF_DATE:
            continue
        for runner in entry.get("runners", []):
            total_runners += 1
            old_time    = runner.get("hodTimeExact")
            old_session = runner.get("time", "session")

            new_time, new_session = correct_time(old_time, offset_hours=et_offset(entry.get("date", "")))

            if new_time != old_time or new_session != old_session:
                total_fixed += 1
                if old_session == "premarket" and new_session == "session":
                    session_flips += 1

            runner["hodTimeExact"] = new_time
            runner["time"]         = new_session

        # Re-vote day-level hodTime from corrected runners
        runners = entry.get("runners", [])
        if runners:
            pm_count   = sum(1 for r in runners if r.get("time") == "premarket")
            entry["hodTime"] = "premarket" if pm_count >= len(runners) * 0.6 else "session"

    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    print(f"\n✅ Done!")
    print(f"   Runners processed : {total_runners}")
    print(f"   Times corrected   : {total_fixed}")
    print(f"   PM → Session fixes: {session_flips}")
    print(f"\n   Saved → {DATA_FILE}")
    print(f"\n→ Push data2.json via GitHub Desktop.")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"\nERROR: {e}")
        import traceback; traceback.print_exc()
    input("\nPress Enter to close...")
