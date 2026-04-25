"""
historical_recap_polygon_only.py
---------------------------------
Multi-day historical rundown of small cap HOD runners.
DATA SOURCE: Polygon only — no AskEdgar dependency.

Outputs:
  - historical_recap_polygon_YYYY-MM-DD_to_YYYY-MM-DD.md

Usage:
    python historical_recap_polygon_only.py
"""

import os, time, json, requests
from datetime import date, timedelta, datetime, timezone

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

POLYGON_API_KEY = ""       # filled at runtime
OUTPUT_DIR      = r"D:\Projects\smallcap-heatguage"

TOP_N        = 10
NEAR_MISS_PCT = 100
MIN_VOLUME   = 500_000
MAX_FLOAT_M  = 150
MAX_HOD_PCT  = 10000  # filters reverse split artifacts

POLYGON_BASE = "https://api.polygon.io"

HOLIDAYS = {
    "2024-01-01","2024-01-15","2024-02-19","2024-03-29","2024-05-27",
    "2024-06-19","2024-07-04","2024-09-02","2024-11-28","2024-12-25",
    "2025-01-01","2025-01-20","2025-02-17","2025-04-18","2025-05-26",
    "2025-06-19","2025-07-04","2025-09-01","2025-11-27","2025-12-25",
    "2026-01-01","2026-01-19","2026-02-16","2026-04-03","2026-05-25",
    "2026-06-19","2026-07-03","2026-09-07","2026-11-26","2026-12-25",
}

# ---------------------------------------------------------------------------
# Ticker filter — excludes warrants, units, rights, ETFs
# ---------------------------------------------------------------------------

KNOWN_ETFS = {
    "SPY","QQQ","IWM","DIA","GLD","SLV","TLT","HYG","LQD","XLF","XLE",
    "XLK","XLV","XLI","XLY","XLP","XLU","XLB","XLRE","VXX","UVXY","SVXY",
    "SQQQ","TQQQ","SPXU","SPXL","LABD","LABU","SOXS","SOXL","FNGU","FNGD",
    "ARKK","ARKG","ARKW","ARKF","ARKQ","BOIL","KOLD","UNG","USO","UCO",
    "SCO","VIXY","TVIX","SDOW","UDOW","TNA","TZA","FAS","FAZ","ERX","ERY",
}

def is_valid_ticker(t):
    if not t: return False
    t = t.upper().strip()
    if not t.isalpha(): return False          # no digits, dots, hyphens
    if len(t) < 1 or len(t) > 5: return False
    if t.endswith("W") or t.endswith("WS") or t.endswith("WT"): return False  # warrants
    if t.endswith("R"): return False          # rights
    if t.endswith("U"): return False          # units
    if t in KNOWN_ETFS: return False
    return True

# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------

def is_trading_day(d):
    return d.weekday() < 5 and str(d) not in HOLIDAYS

def get_prev_trading_date(d):
    d = d - timedelta(days=1)
    while not is_trading_day(d):
        d -= timedelta(days=1)
    return d

def trading_days_between(start_d, end_d):
    d = start_d
    while d <= end_d:
        if is_trading_day(d):
            yield d
        d += timedelta(days=1)

def fmt_vol(v):
    if not v: return "N/A"
    if v >= 1e6: return f"{v/1e6:.1f}M"
    if v >= 1e3: return f"{v/1e3:.0f}K"
    return str(v)

def fmt_mc(v):
    if not v: return "N/A"
    if v >= 1e9: return f"${v/1e9:.1f}B"
    return f"${v/1e6:.0f}M"

def parse_date(s):
    parts = s.strip().split("-")
    return date(int(parts[0]), int(parts[1]), int(parts[2]))

# ---------------------------------------------------------------------------
# Polygon fetchers
# ---------------------------------------------------------------------------

def poly_get(path, params=None):
    try:
        r = requests.get(
            f"{POLYGON_BASE}{path}",
            params={**(params or {}), "apiKey": POLYGON_API_KEY},
            timeout=20,
        )
        if r.status_code == 200:
            return r.json()
    except Exception as e:
        print(f"    [WARN] Polygon {path}: {e}")
    return {}

def fetch_grouped(date_str):
    return poly_get(
        f"/v2/aggs/grouped/locale/us/market/stocks/{date_str}",
        {"adjusted": "false", "include_otc": "false"}
    ).get("results") or []

def fetch_ticker_details(ticker):
    return poly_get(f"/v3/reference/tickers/{ticker}").get("results") or {}

def fetch_intraday_minute(ticker, date_str):
    return poly_get(
        f"/v2/aggs/ticker/{ticker}/range/1/minute/{date_str}/{date_str}",
        {"adjusted": "false", "sort": "asc", "limit": 1000}
    ).get("results") or []

def _to_et(ts_ms):
    """Convert Polygon ms-epoch UTC to (et_hour, et_min). Handles EDT/EST automatically."""
    dt_utc = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
    offset = -4 if 3 <= dt_utc.month <= 10 else -5
    return (dt_utc.hour + offset) % 24, dt_utc.minute

def analyze_intraday(bars):
    if not bars:
        return None, "session", None

    hod_bar         = max(bars, key=lambda b: b.get("h", 0))
    et_hour, et_min = _to_et(hod_bar.get("t", 0))
    time_dec        = et_hour + et_min / 60
    session         = "premarket" if time_dec < 9.5 else "session"
    ampm            = "AM" if et_hour < 12 else "PM"
    disp_h          = et_hour if et_hour <= 12 else et_hour - 12
    if disp_h == 0: disp_h = 12
    hod_time_str    = f"{disp_h:02d}:{et_min:02d} {ampm} ET"

    pm_bars = [b for b in bars
               if (_to_et(b.get("t", 0))[0] + _to_et(b.get("t", 0))[1] / 60) < 9.5]
    pm_high = max((b.get("h", 0) for b in pm_bars), default=None) if pm_bars else None

    return hod_time_str, session, pm_high

def fetch_avg_volume(ticker, date_str, days=20):
    start = str(date.fromisoformat(date_str) - timedelta(days=days + 10))
    bars  = poly_get(
        f"/v2/aggs/ticker/{ticker}/range/1/day/{start}/{date_str}",
        {"adjusted": "false", "sort": "desc", "limit": days + 5}
    ).get("results") or []
    past = [b["v"] for b in bars
            if b.get("t") and str(date.fromtimestamp(b["t"]/1000)) != date_str]
    return sum(past[:days]) / min(len(past), days) if past else None

def fetch_news(ticker, date_str):
    res = poly_get("/v2/reference/news", {
        "ticker": ticker,
        "published_utc.gte": f"{date_str}T00:00:00Z",
        "published_utc.lte": f"{date_str}T23:59:59Z",
        "limit": 5,
    }).get("results", [])
    return [{"title": x.get("title",""), "publisher": (x.get("publisher") or {}).get("name","")}
            for x in res if x.get("title")]

# ---------------------------------------------------------------------------
# Polygon-only classification
# ---------------------------------------------------------------------------

def classify_runner_polygon(m, headlines):
    reasons     = []
    risk_badges = []
    float_m     = m.get("float")
    rel_vol     = m.get("relVol")
    gap_pct     = m.get("gapPct", 0)

    if float_m and float_m < 10:
        risk_badges.append(f"Float {float_m}M")

    material_kw = ["fda","approval","contract","acquisition","merger","partnership",
                   "earnings","beats","guidance","clinical","phase","award",
                   "authorization","clearance","breakthrough"]
    news_material = any(
        any(k in h.get("title","").lower() for k in material_kw)
        for h in headlines
    )

    if news_material and gap_pct >= 50:
        tag = "RIG"
        reasons.append(f"Gapped {gap_pct:+.1f}% on news catalyst")
        for h in headlines[:2]:
            reasons.append(h["title"])
    elif news_material:
        tag = "NEWS-DRIVEN"
        reasons.append("Material news catalyst — no dilution data available (Polygon only)")
        for h in headlines[:2]:
            reasons.append(h["title"])
    elif float_m and float_m < 5:
        tag = "RETAIL PUMP"
        reasons.append("No news catalyst — social/momentum driven")
        reasons.append(f"Float {float_m}M" + (f" + RelVol {rel_vol}x" if rel_vol else ""))
    elif gap_pct >= 30:
        tag = "SYMPATHY"
        reasons.append("No direct catalyst — sector/sympathy driven")
    else:
        tag = "RETAIL PUMP"
        reasons.append("No catalyst identified — momentum/retail driven")

    return {"primary_tag": tag, "reasons": reasons, "risk_badges": risk_badges}

# ---------------------------------------------------------------------------
# Per-day pull
# ---------------------------------------------------------------------------

def get_day_movers_historical(target_date):
    prev_date = get_prev_trading_date(target_date)
    date_str  = str(target_date)
    prev_str  = str(prev_date)

    print(f"\n  Fetching grouped bars ({date_str} / prev {prev_str})...")
    today_bars = fetch_grouped(date_str)
    prev_bars  = fetch_grouped(prev_str)
    if not today_bars:
        print(f"  No bars for {date_str} — skipping")
        return [], []

    prev_map   = {r["T"]: r["c"] for r in prev_bars if r.get("c")}
    all_movers = []

    for r in today_bars:
        ticker = r.get("T","")
        if not is_valid_ticker(ticker): continue
        pc = prev_map.get(ticker)
        if not pc or pc <= 0: continue
        if r.get("v", 0) < MIN_VOLUME: continue
        hod = r.get("h", 0)
        if hod <= 0: continue
        hod_pct = round((hod - pc) / pc * 100, 2)
        if hod_pct <= 0: continue
        if hod_pct > MAX_HOD_PCT: continue  # reverse split artifact
        gap_pct = round((r.get("o",0) - pc) / pc * 100, 2) if pc else 0

        all_movers.append({
            "ticker":    ticker,
            "hodPct":    hod_pct,
            "gapPct":    gap_pct,
            "fadePct":   round((hod - r.get("c",0)) / hod * 100, 2) if hod else 0,
            "prevClose": round(pc, 4),
            "open":      round(r.get("o",0), 4),
            "high":      round(hod, 4),
            "close":     round(r.get("c",0), 4),
            "vwap":      round(r.get("vw",0), 4),
            "vsVwap":    "above" if r.get("c",0) > r.get("vw",0) else "below",
            "vol":       int(r.get("v",0)),
        })

    all_movers.sort(key=lambda x: x["hodPct"], reverse=True)

    top, near_miss = [], []
    detail_cache   = {}

    print(f"  {len(all_movers)} candidates. Enriching top runners...")

    for c in all_movers:
        if len(top) >= TOP_N and c["hodPct"] < NEAR_MISS_PCT:
            break
        ticker  = c["ticker"]
        details = detail_cache.setdefault(ticker, fetch_ticker_details(ticker))
        time.sleep(0.06)
        if not details: continue

        float_shares = details.get("share_class_shares_outstanding") or details.get("weighted_shares_outstanding")
        float_m = round(float_shares / 1e6, 2) if float_shares else None

        if float_m and float_m > MAX_FLOAT_M:
            if c["hodPct"] >= NEAR_MISS_PCT:
                near_miss.append({**c, "name": details.get("name", ticker),
                                  "float": round(float_m,1) if float_m else None,
                                  "reason_missed": f"Float {float_m:.0f}M > {MAX_FLOAT_M}M cap"})
            continue

        if len(top) >= TOP_N:
            if c["hodPct"] >= NEAR_MISS_PCT:
                near_miss.append({**c, "name": details.get("name", ticker),
                                  "float": round(float_m,1) if float_m else None,
                                  "reason_missed": f"Ranked below top {TOP_N}"})
            continue

        print(f"    [{len(top)+1}/{TOP_N}] {ticker}")

        bars                    = fetch_intraday_minute(ticker, date_str)
        hod_time, session, pm_high = analyze_intraday(bars)
        time.sleep(0.06)

        avg_vol = fetch_avg_volume(ticker, date_str)
        rel_vol = round(c["vol"] / avg_vol, 1) if avg_vol else None
        time.sleep(0.06)

        headlines = fetch_news(ticker, date_str)
        time.sleep(0.06)

        enriched = {
            **c,
            "name":      details.get("name", ticker),
            "sector":    details.get("sic_description") or details.get("sector") or "Unknown",
            "country":   (details.get("locale") or "us").upper(),
            "float":     float_m,
            "float_src": "Polygon",
            "marketCap": details.get("market_cap", 0),
            "hodTime":   hod_time,
            "session":   session,
            "pmHigh":    round(pm_high, 4) if pm_high else None,
            "relVol":    rel_vol,
            "avgVol":    round(avg_vol/1e6, 1) if avg_vol else None,
            "headlines": headlines,
        }
        enriched["classification"] = classify_runner_polygon(enriched, headlines)
        top.append(enriched)

    return top, near_miss

# ---------------------------------------------------------------------------
# Heat-gauge JSON builder (heat-gauge.v1 — merge.py compatible)
# ---------------------------------------------------------------------------

THRESHOLDS = {
    "hodHot":       150,
    "hodNeutralLo": 100,
    "fadeHot":      25,
    "fadeCold":     40,
}

def build_heat_gauge_json(results):
    entries = []

    for target_date, movers, near_miss in results:
        date_str = str(target_date)
        runners  = []

        for m in movers:
            c    = m["classification"]
            news = [h["title"] for h in m.get("headlines", []) if h.get("title")]

            sections = []
            if c.get("reasons"):
                sections.append({
                    "title":   "Why it ran",
                    "emoji":   None,
                    "bullets": c["reasons"],
                    "prose":   None,
                })

            runners.append({
                "sym":          m["ticker"],
                "hod":          int(m["hodPct"]),
                "hodExact":     m["hodPct"],
                "news":         news,
                "tag":          c["primary_tag"],
                "name":         m.get("name", m["ticker"]),
                "sector":       m.get("sector", "Unknown"),
                "country":      m.get("country", "US"),
                "floatM":       m.get("float"),
                "floatSrc":     m.get("float_src", "Polygon"),
                "marketCap":    fmt_mc(m.get("marketCap", 0)),
                "riskBadges":   c.get("risk_badges", []),
                "sections":     sections,
                "reasons":      c.get("reasons", []),
                "insights":     [],
                "jmtNotes":     [],
                "tldr":         [],
                "prevClose":    m["prevClose"],
                "open":         m["open"],
                "gapPct":       m["gapPct"],
                "time":         m.get("session", "session"),
                "high":         m["high"],
                "hodTimeExact": m.get("hodTime"),
                "close":        m["close"],
                "fade":         int(m["fadePct"]),
                "fadeExact":    m["fadePct"],
                "vwap":         m["vwap"],
                "vsVwap":       m["vsVwap"],
                "pmHigh":       m.get("pmHigh"),
                "volRaw":       fmt_vol(m["vol"]),
                "relVol":       m.get("relVol"),
                "avgVolM":      m.get("avgVol"),
            })

        # Day-level summary
        lead    = runners[0] if runners else {}
        avg_hod = round(sum(r["hod"] for r in runners) / len(runners)) if runners else 0
        avg_fad = round(sum(r["fade"] for r in runners) / len(runners)) if runners else 0
        pm_led  = sum(1 for r in runners if r["time"] == "premarket")

        if pm_led >= len(runners) * 0.6:
            theme = "PM-Led Tape"
        elif avg_hod >= 150:
            theme = "Hot Tape"
        elif avg_hod >= 100:
            theme = "Active Tape"
        else:
            theme = "Choppy Mixed"

        note = (
            f"{lead.get('sym','')} led +{lead.get('hodExact',0)}% "
            f"({lead.get('fade',0)}% fade). "
            f"{sum(1 for r in runners if r['fade'] < 20)}/{len(runners)} held <20% fade."
        ) if runners else "No qualifying runners."

        entries.append({
            "date":    date_str,
            "runners": runners,
            "hod":     lead.get("hod", 0),
            "fade":    avg_fad,
            "hodTime": lead.get("time", "session"),
            "theme":   theme,
            "note":    note,
        })

    return {
        "schema":     "heat-gauge.v1",
        "exportedAt": datetime.utcnow().isoformat() + "Z",
        "count":      sum(len(e["runners"]) for e in entries),
        "thresholds": THRESHOLDS,
        "entries":    entries,
    }

# ---------------------------------------------------------------------------
# Date range prompt
# ---------------------------------------------------------------------------

def prompt_date_range():
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
            if is_trading_day(d): count += 1
        return d, end_anchor

    if choice == "2":
        count, d = 0, end_anchor
        while count < 20:
            d -= timedelta(days=1)
            if is_trading_day(d): count += 1
        return d, end_anchor

    if choice == "4":
        print("Enter date (YYYY-MM-DD):")
        d = parse_date(input("> "))
        return d, d

    print("Enter start date (YYYY-MM-DD):")
    start = parse_date(input("> "))
    print("Enter end date (YYYY-MM-DD):")
    end   = parse_date(input("> "))
    if start > end:
        start, end = end, start
    return start, end

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    global POLYGON_API_KEY

    print("📚 Historical Small Cap Rundown — Polygon Only")
    print("=" * 50)

    print("\nPaste your Polygon API key and press Enter:")
    POLYGON_API_KEY = input("> ").strip()
    if not POLYGON_API_KEY:
        print("ERROR: No API key provided.")
        input("\nPress Enter to close...")
        return

    start_d, end_d   = prompt_date_range()
    trading_days     = list(trading_days_between(start_d, end_d))

    if not trading_days:
        print("\n⚠ No trading days in that range.")
        input("\nPress Enter to close...")
        return

    print(f"\nProcessing {len(trading_days)} trading day(s): {trading_days[0]} → {trading_days[-1]}")
    print(f"Top {TOP_N} runners | Max float {MAX_FLOAT_M}M | Min vol {MIN_VOLUME:,} | Polygon only\n")

    results = []
    for i, td in enumerate(trading_days):
        print(f"\n{'='*60}")
        print(f"[{i+1}/{len(trading_days)}] {td.strftime('%A %B %d, %Y')}")
        print("=" * 60)
        movers, near_miss = get_day_movers_historical(td)
        results.append((td, movers, near_miss))
        print(f"  → {len(movers)} runners captured")

    print("\n\nBuilding heat-gauge JSON...")
    payload = build_heat_gauge_json(results)

    out_dir  = OUTPUT_DIR if OUTPUT_DIR and os.path.isdir(OUTPUT_DIR) else os.getcwd()
    if start_d == end_d:
        out_file = os.path.join(out_dir, f"heat-gauge-{start_d}.json")
    else:
        out_file = os.path.join(out_dir, f"heat-gauge-{start_d}_to_{end_d}.json")

    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)

    print(f"\n✅ Done!")
    print(f"   Output : {out_file}")
    print(f"   Days   : {len(trading_days)}")
    print(f"   Runners: {payload['count']}")
    print(f"\n→ Run merge.py to fold into data2.json, then push via GitHub Desktop.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\nInterrupted.")
    except Exception as e:
        print(f"\nERROR: {e}")
        import traceback; traceback.print_exc()
    input("\nPress Enter to close...")
