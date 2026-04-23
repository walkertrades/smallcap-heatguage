"""
historical_heatgauge.py
-----------------------
Multi-day historical rundown of small cap HOD runners.
Pulls ONLY from Polygon (no AskEdgar dependency).
Outputs a heat-gauge.v1 JSON file ready to drop into the
smallcap-heatguage GitHub repo.

Usage:
    python historical_heatgauge.py

Output:
    heat-gauge-YYYY-MM-DD_to_YYYY-MM-DD.json
"""

import sys, os, time, json, requests
from datetime import date, timedelta, datetime

# ---------------------------------------------------------------------------
# CONFIG — edit these or enter at runtime
# ---------------------------------------------------------------------------
POLYGON_API_KEY = ""       # filled in at runtime

TOP_N          = 10        # runners per day
MIN_VOLUME     = 50_000    # minimum share volume to consider
MAX_FLOAT_M    = 150       # float cap in millions
NEAR_MISS_PCT  = 50        # % HOD threshold for near-miss list

# Heat-gauge thresholds (written into schema)
THRESHOLDS = {
    "hodHot":       150,
    "hodNeutralLo": 100,
    "fadeHot":      25,
    "fadeCold":     40,
}

# US market holidays (add/remove as needed)
MARKET_HOLIDAYS = {
    date(2026, 1, 1), date(2026, 1, 19), date(2026, 2, 16),
    date(2026, 4, 3), date(2026, 5, 25), date(2026, 7, 3),
    date(2026, 9, 7), date(2026, 11, 26), date(2026, 12, 25),
    date(2025, 1, 1), date(2025, 1, 20), date(2025, 2, 17),
    date(2025, 4, 18), date(2025, 5, 26), date(2025, 7, 4),
    date(2025, 9, 1), date(2025, 11, 27), date(2025, 12, 25),
}

BASE = "https://api.polygon.io"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def is_trading_day(d: date) -> bool:
    return d.weekday() < 5 and d not in MARKET_HOLIDAYS


def get_prev_trading_date(d: date) -> date:
    prev = d - timedelta(days=1)
    while not is_trading_day(prev):
        prev -= timedelta(days=1)
    return prev


def trading_days_between(start_d: date, end_d: date):
    d = start_d
    while d <= end_d:
        if is_trading_day(d):
            yield d
        d += timedelta(days=1)


def poly_get(path: str, params: dict = None) -> dict:
    """Make a Polygon REST call, return parsed JSON or {}."""
    p = params or {}
    p["apiKey"] = POLYGON_API_KEY
    try:
        r = requests.get(BASE + path, params=p, timeout=15)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        print(f"    [WARN] Polygon error {path}: {e}")
        return {}


def is_valid_ticker(t: str) -> bool:
    """Exclude obvious warrants/rights/units."""
    return (
        t and 1 <= len(t) <= 6
        and t.isalpha()
        and not any(t.endswith(s) for s in ("W", "R", "U", "WS"))
    )


def fmt_mc(mc) -> str:
    if not mc or mc <= 0:
        return "$0M"
    if mc >= 1_000_000_000:
        return f"${round(mc/1e9,1)}B"
    return f"${round(mc/1e6,0):.0f}M"


def fmt_vol(v: int) -> str:
    if v >= 1_000_000:
        return f"{round(v/1e6,1)}M"
    if v >= 1_000:
        return f"{round(v/1e3,1)}K"
    return str(v)


# ---------------------------------------------------------------------------
# Polygon data fetchers
# ---------------------------------------------------------------------------

def fetch_grouped(date_str: str) -> list:
    """Grouped daily bars for all tickers on a given date."""
    data = poly_get(f"/v2/aggs/grouped/locale/us/market/stocks/{date_str}",
                    {"adjusted": "false", "include_otc": "false"})
    return data.get("results", [])


def fetch_ticker_details(ticker: str) -> dict:
    data = poly_get(f"/v3/reference/tickers/{ticker}")
    return data.get("results", {})


def fetch_intraday_minute(ticker: str, date_str: str) -> list:
    data = poly_get(
        f"/v2/aggs/ticker/{ticker}/range/1/minute/{date_str}/{date_str}",
        {"adjusted": "false", "sort": "asc", "limit": 1000}
    )
    return data.get("results", [])


def fetch_avg_volume(ticker: str, date_str: str, lookback: int = 20) -> float | None:
    """Simple average daily volume over the prior `lookback` trading days."""
    end_d   = date.fromisoformat(date_str) - timedelta(days=1)
    start_d = end_d - timedelta(days=lookback * 2)   # overshoot, then trim
    data = poly_get(
        f"/v2/aggs/ticker/{ticker}/range/1/day/{start_d}/{end_d}",
        {"adjusted": "false", "sort": "asc", "limit": 50}
    )
    bars = data.get("results", [])
    if not bars:
        return None
    vols = [b["v"] for b in bars if b.get("v")][-lookback:]
    return sum(vols) / len(vols) if vols else None


def fetch_news(ticker: str, date_str: str, limit: int = 5) -> list[str]:
    """Polygon news headlines for the ticker on/before the given date."""
    data = poly_get("/v2/reference/news", {
        "ticker":         ticker,
        "published_utc.lte": f"{date_str}T23:59:59Z",
        "published_utc.gte": f"{date_str}T00:00:00Z",
        "limit":          limit,
        "sort":           "published_utc",
        "order":          "desc",
    })
    items = data.get("results", [])
    return [i.get("title", "") for i in items if i.get("title")]


def analyze_intraday(bars: list) -> tuple[str, str, float | None]:
    """
    Returns (hod_time_str, session_label, pm_high).
    session_label: 'premarket' | 'session' | 'afterhours'
    """
    if not bars:
        return "?", "session", None

    # Polygon timestamps are ms-epoch UTC
    pm_high  = None
    hod_val  = -1
    hod_time = "?"
    session  = "session"

    for b in bars:
        ts  = b.get("t", 0) / 1000           # seconds
        dt  = datetime.utcfromtimestamp(ts)
        h   = b.get("h", 0)
        # Determine ET offset (rough — not DST-aware, adjust if needed)
        # Polygon returns UTC; ET = UTC-4 during EDT, UTC-5 during EST
        # April → EDT → UTC-4
        et_hour = (dt.hour - 4) % 24
        et_min  = dt.minute

        time_dec = et_hour + et_min / 60      # decimal hour in ET

        if 4.0 <= time_dec < 9.5:             # 4:00–9:29 ET premarket
            if h > (pm_high or 0):
                pm_high = round(h, 4)

        if h > hod_val:
            hod_val  = h
            minute   = f"{et_min:02d}"
            ampm     = "AM" if et_hour < 12 else "PM"
            disp_h   = et_hour if et_hour <= 12 else et_hour - 12
            if disp_h == 0: disp_h = 12
            hod_time = f"{disp_h:02d}:{minute} {ampm} ET"

            if time_dec < 9.5:
                session = "premarket"
            elif time_dec >= 16.0:
                session = "afterhours"
            else:
                session = "session"

    return hod_time, session, pm_high


# ---------------------------------------------------------------------------
# Classification (Polygon-only, no AskEdgar)
# ---------------------------------------------------------------------------

def classify_runner_polygon(m: dict, news_headlines: list) -> dict:
    """
    Simple tag logic using only price/volume/float data available from Polygon.
    Returns a dict with: tag, reasons, riskBadges
    """
    hod_pct  = m["hodExact"]
    float_m  = m.get("floatM")
    rel_vol  = m.get("relVol")
    gap_pct  = m.get("gapPct", 0)

    risk_badges = []
    if float_m and float_m < 10:
        risk_badges.append(f"Float {float_m}M")

    reasons = []

    # Tag logic (simplified without AE dilution data)
    has_news = bool(news_headlines)

    if has_news and gap_pct >= 50:
        tag = "RIG"
        reasons.append(f"Gapped {gap_pct:+.1f}% on news catalyst")
        for h in news_headlines[:2]:
            reasons.append(h)
    elif has_news:
        tag = "RIG"
        reasons.append("News-driven move")
        for h in news_headlines[:2]:
            reasons.append(h)
    elif float_m and float_m < 5:
        tag = "RETAIL PUMP"
        reasons.append("No filings or news catalyst — social-driven")
        if float_m:
            reasons.append(f"Float {float_m}M" + (f" + RelVol {rel_vol}x" if rel_vol else ""))
    elif gap_pct >= 30:
        tag = "SYMPATHY"
        reasons.append("No direct catalyst — sector/sympathy driven")
    else:
        tag = "RETAIL PUMP"
        reasons.append("No catalyst identified — momentum/retail driven")

    return {
        "tag":        tag,
        "reasons":    reasons,
        "riskBadges": risk_badges,
    }


# ---------------------------------------------------------------------------
# Per-day processing
# ---------------------------------------------------------------------------

def get_day_runners(target_date: date) -> tuple[list, list]:
    """
    Returns (top_runners, near_miss) for one trading day.
    All data from Polygon only.
    """
    prev_date = get_prev_trading_date(target_date)
    date_str  = str(target_date)
    prev_str  = str(prev_date)

    print(f"\n  Fetching grouped bars...")
    today_bars = fetch_grouped(date_str)
    prev_bars  = fetch_grouped(prev_str)

    if not today_bars:
        print(f"  No bars for {date_str} — skipping")
        return [], []

    prev_map = {r["T"]: r["c"] for r in prev_bars if r.get("c")}

    candidates = []
    for r in today_bars:
        ticker = r.get("T", "")
        if not is_valid_ticker(ticker):
            continue
        pc = prev_map.get(ticker)
        if not pc or pc <= 0:
            continue
        if r.get("v", 0) < MIN_VOLUME:
            continue
        hod = r.get("h", 0)
        if hod <= 0:
            continue
        hod_pct = round((hod - pc) / pc * 100, 2)
        if hod_pct <= 0:
            continue
        gap_pct = round((r.get("o", 0) - pc) / pc * 100, 2) if pc else 0
        close   = r.get("c", 0)
        fade    = round((hod - close) / hod * 100, 2) if hod else 0

        candidates.append({
            "ticker":    ticker,
            "hodExact":  hod_pct,
            "gapPct":    gap_pct,
            "fadeExact": fade,
            "prevClose": round(pc, 4),
            "open":      round(r.get("o", 0), 4),
            "high":      round(hod, 4),
            "close":     round(close, 4),
            "vwap":      round(r.get("vw", 0), 4),
            "vsVwap":    "above" if close > r.get("vw", 0) else "below",
            "vol":       int(r.get("v", 0)),
        })

    candidates.sort(key=lambda x: x["hodExact"], reverse=True)

    top, near_miss = [], []

    print(f"  {len(candidates)} candidates, enriching top runners...")

    for c in candidates:
        if len(top) >= TOP_N and c["hodExact"] < NEAR_MISS_PCT:
            break

        ticker  = c["ticker"]
        details = fetch_ticker_details(ticker)
        time.sleep(0.08)

        if not details:
            continue

        float_shares = details.get("share_class_shares_outstanding") or details.get("weighted_shares_outstanding")
        float_m = round(float_shares / 1e6, 2) if float_shares else None

        if float_m and float_m > MAX_FLOAT_M:
            if c["hodExact"] >= NEAR_MISS_PCT:
                near_miss.append({
                    "sym":           ticker,
                    "hod":           int(c["hodExact"]),
                    "floatM":        float_m,
                    "reason_missed": f"Float {float_m:.0f}M > {MAX_FLOAT_M}M cap",
                })
            continue

        if len(top) >= TOP_N:
            if c["hodExact"] >= NEAR_MISS_PCT:
                near_miss.append({
                    "sym":           ticker,
                    "hod":           int(c["hodExact"]),
                    "floatM":        float_m,
                    "reason_missed": f"Ranked below top {TOP_N}",
                })
            continue

        print(f"    [{len(top)+1}/{TOP_N}] {ticker}")

        bars              = fetch_intraday_minute(ticker, date_str)
        hod_time, session, pm_high = analyze_intraday(bars)
        time.sleep(0.08)

        avg_vol = fetch_avg_volume(ticker, date_str)
        rel_vol = round(c["vol"] / avg_vol, 1) if avg_vol else None
        time.sleep(0.08)

        news = fetch_news(ticker, date_str)
        time.sleep(0.08)

        clf = classify_runner_polygon(
            {**c, "floatM": float_m, "relVol": rel_vol},
            news
        )

        # Build sections from classification reasons
        sections = []
        if clf["reasons"]:
            sections.append({
                "title":   "Why it ran",
                "emoji":   None,
                "bullets": clf["reasons"],
                "prose":   None,
            })

        runner = {
            "sym":          ticker,
            "hod":          int(c["hodExact"]),
            "hodExact":     c["hodExact"],
            "news":         news,
            "tag":          clf["tag"],
            "name":         details.get("name", ticker),
            "sector":       details.get("sic_description") or details.get("sector") or "Unknown",
            "country":      (details.get("locale") or "us").upper(),
            "floatM":       float_m,
            "floatSrc":     "Polygon",
            "marketCap":    fmt_mc(details.get("market_cap", 0)),
            "riskBadges":   clf["riskBadges"],
            "sections":     sections,
            "reasons":      clf["reasons"],
            "prevClose":    c["prevClose"],
            "open":         c["open"],
            "gapPct":       c["gapPct"],
            "time":         session,
            "high":         c["high"],
            "hodTimeExact": hod_time,
            "close":        c["close"],
            "fade":         int(c["fadeExact"]),
            "fadeExact":    c["fadeExact"],
            "vwap":         c["vwap"],
            "vsVwap":       c["vsVwap"],
            "pmHigh":       pm_high,
            "volRaw":       fmt_vol(c["vol"]),
            "relVol":       rel_vol,
            "avgVolM":      round(avg_vol / 1e6, 1) if avg_vol else None,
        }
        top.append(runner)

    return top, near_miss


# ---------------------------------------------------------------------------
# Day-level summary fields
# ---------------------------------------------------------------------------

def build_day_summary(runners: list, target_date: date) -> dict:
    if not runners:
        return {
            "date":    str(target_date),
            "runners": [],
            "hod":     0,
            "fade":    0,
            "hodTime": "session",
            "theme":   "No Data",
            "note":    "No qualifying runners.",
        }

    lead    = runners[0]
    avg_hod = round(sum(r["hod"] for r in runners) / len(runners))
    avg_fad = round(sum(r["fade"] for r in runners) / len(runners))

    held_well = sum(1 for r in runners if r["fade"] < 20)
    pm_led    = sum(1 for r in runners if r["time"] == "premarket")

    # Theme
    if pm_led >= len(runners) * 0.6:
        theme = "PM-Led Tape"
    elif avg_hod >= 150:
        theme = "Hot Tape"
    elif avg_hod >= 100:
        theme = "Active Tape"
    else:
        theme = "Choppy Mixed"

    news_note = ""
    for r in runners:
        if r["news"]:
            news_note = f" news: {r['sym']} — \"{r['news'][0]}\"."
            break

    note = (
        f"{lead['sym']} led +{lead['hodExact']}% ({lead['fade']}% fade). "
        f"{held_well}/{len(runners)} held <20% — closing strong.{news_note}"
    )

    return {
        "date":    str(target_date),
        "runners": runners,
        "hod":     lead["hod"],
        "fade":    avg_fad,
        "hodTime": lead["time"],
        "theme":   theme,
        "note":    note,
    }


# ---------------------------------------------------------------------------
# JSON output builder
# ---------------------------------------------------------------------------

def build_heat_gauge_json(results: list) -> dict:
    """
    results: list of (target_date, runners, near_miss) tuples.
    Returns the full heat-gauge.v1 dict.
    """
    entries     = []
    total_count = 0

    for target_date, runners, near_miss in results:
        day = build_day_summary(runners, target_date)
        entries.append(day)
        total_count += len(runners)

    return {
        "schema":     "heat-gauge.v1",
        "exportedAt": datetime.utcnow().isoformat() + "Z",
        "count":      total_count,
        "thresholds": THRESHOLDS,
        "entries":    entries,
    }


# ---------------------------------------------------------------------------
# Date range prompt
# ---------------------------------------------------------------------------

def parse_date(s: str) -> date:
    parts = s.strip().split("-")
    return date(int(parts[0]), int(parts[1]), int(parts[2]))


def prompt_date_range() -> tuple[date, date]:
    today      = date.today()
    end_anchor = today - timedelta(days=1)
    while not is_trading_day(end_anchor):
        end_anchor -= timedelta(days=1)

    print("\nDate range options:")
    print("  1) Last week   (prior 5 trading days)")
    print("  2) Last month  (prior 21 trading days)")
    print("  3) Custom range")
    print("  4) Single day")
    choice = input("\nSelect 1-4: ").strip()

    if choice == "1":
        count, d = 0, end_anchor
        while count < 4:
            d -= timedelta(days=1)
            if is_trading_day(d):
                count += 1
        return d, end_anchor

    if choice == "2":
        count, d = 0, end_anchor
        while count < 20:
            d -= timedelta(days=1)
            if is_trading_day(d):
                count += 1
        return d, end_anchor

    if choice == "4":
        print("Enter date (YYYY-MM-DD):")
        d = parse_date(input("> "))
        return d, d

    print("Enter start date (YYYY-MM-DD):")
    start = parse_date(input("> "))
    print("Enter end date (YYYY-MM-DD):")
    end = parse_date(input("> "))
    if start > end:
        start, end = end, start
    return start, end


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    global POLYGON_API_KEY

    print("🔥 Small Cap Heat Gauge — Historical Builder")
    print("=" * 50)
    print("\nPaste your Polygon API key and press Enter:")
    POLYGON_API_KEY = input("> ").strip()

    if not POLYGON_API_KEY:
        print("ERROR: No API key provided.")
        input("\nPress Enter to close...")
        return

    start_d, end_d    = prompt_date_range()
    trading_days      = list(trading_days_between(start_d, end_d))

    if not trading_days:
        print("\n⚠ No trading days in that range.")
        input("\nPress Enter to close...")
        return

    print(f"\nProcessing {len(trading_days)} trading day(s): {trading_days[0]} → {trading_days[-1]}")
    print(f"Top {TOP_N} runners per day | Max float {MAX_FLOAT_M}M | Min vol {MIN_VOLUME:,}\n")

    results = []
    for i, td in enumerate(trading_days):
        print(f"\n{'='*60}")
        print(f"[{i+1}/{len(trading_days)}] {td.strftime('%A %B %d, %Y')}")
        print("=" * 60)
        runners, near_miss = get_day_runners(td)
        results.append((td, runners, near_miss))
        print(f"  → {len(runners)} runners captured")

    print("\n\nBuilding heat-gauge JSON...")
    payload = build_heat_gauge_json(results)

    # Single-day: use that date. Multi-day: use range.
    if start_d == end_d:
        out_file = f"heat-gauge-{start_d}.json"
    else:
        out_file = f"heat-gauge-{start_d}_to_{end_d}.json"

    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)

    print(f"\n✅ Done!")
    print(f"   Output : {os.path.abspath(out_file)}")
    print(f"   Days   : {len(trading_days)}")
    print(f"   Runners: {payload['count']}")
    print(f"\nDrop {out_file} into your smallcap-heatguage repo and push.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\nInterrupted.")
    except Exception as e:
        print(f"\nERROR: {e}")
        import traceback; traceback.print_exc()
    input("\nPress Enter to close...")
