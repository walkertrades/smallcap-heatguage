"""
evening_recap.py
----------------
End-of-day rundown of small cap HOD runners with "why it ran" classification.

Data sources:
  - Polygon:   OHLC, HOD time, volume, float, headlines
  - AskEdgar:  dilution rating, ATM/shelf status, warrants, offerings, research report

Outputs:
  - recap_YYYY-MM-DD.html  (tile layout matching the Phase 1 triage UI)
  - recap_YYYY-MM-DD.md    (markdown for pasting into Claude)

Usage:
    cd Downloads
    python evening_recap.py
"""

import sys, os, time, json, html, webbrowser, requests
from datetime import date, timedelta, datetime, timezone

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

POLYGON_API_KEY  = ""
ASKEDGAR_API_KEY = ""

POLYGON_BASE     = "https://api.polygon.io"
ASKEDGAR_BASE    = "https://eapi.askedgar.io/v1"

# ---------------------------------------------------------------------------
# Output directory — set this to your local repo folder so all files
# (HTML, MD, and heat-gauge JSON) land directly there ready to push.
# ---------------------------------------------------------------------------
OUTPUT_DIR = r"D:\Projects\smallcap-heatguage"

TOP_N            = 10
NEAR_MISS_PCT    = 100        # any gapper >= this % that missed top 10
MIN_VOLUME       = 500_000
MAX_FLOAT_M      = 150

DEBUG_MODE       = False      # set True at runtime to dump first ticker's AE JSON

HOLIDAYS = set([
    "2024-01-01","2024-01-15","2024-02-19","2024-03-29","2024-05-27",
    "2024-06-19","2024-07-04","2024-09-02","2024-11-28","2024-12-25",
    "2025-01-01","2025-01-20","2025-02-17","2025-04-18","2025-05-26",
    "2025-06-19","2025-07-04","2025-09-01","2025-11-27","2025-12-25",
    "2026-01-01","2026-01-19","2026-02-16","2026-04-03","2026-05-25",
    "2026-06-19","2026-07-03","2026-09-07","2026-11-26","2026-12-25",
])

# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------

def is_valid_ticker(t):
    if not t: return False
    t = t.upper().strip()

    # Must be letters only, 1-5 chars
    if not t.isalpha(): return False
    if len(t) < 1 or len(t) > 5: return False
    if len(t) >= 5 and (t.endswith("W") or t.endswith("WS") or t.endswith("WT")): return False  # warrants

    # Warrants

    # Rights

    # Units

    # Known ETFs/ETPs
    KNOWN_ETFS = {
        "SPY","QQQ","IWM","DIA","GLD","SLV","TLT","HYG","LQD","XLF","XLE",
        "XLK","XLV","XLI","XLY","XLP","XLU","XLB","XLRE","VXX","UVXY","SVXY",
        "SQQQ","TQQQ","SPXU","SPXL","LABD","LABU","SOXS","SOXL","FNGU","FNGD",
        "ARKK","ARKG","ARKW","ARKF","ARKQ","BOIL","KOLD","UNG","USO","UCO",
        "SCO","VIXY","TVIX","SDOW","UDOW","TNA","TZA","FAS","FAZ","ERX","ERY",
    }
    if t in KNOWN_ETFS: return False

    return True

def is_trading_day(d):
    return d.weekday() < 5 and str(d) not in HOLIDAYS

def get_prev_trading_date(d):
    d = d - timedelta(days=1)
    while not is_trading_day(d):
        d -= timedelta(days=1)
    return d

def fmt_vol(v):
    if not v: return "N/A"
    if v >= 1e6: return f"{v/1e6:.1f}M"
    if v >= 1e3: return f"{v/1e3:.0f}K"
    return str(v)

def fmt_mc(v):
    if not v: return "N/A"
    if v >= 1e9: return f"${v/1e9:.1f}B"
    return f"${v/1e6:.0f}M"

def safe_get(d, *keys, default=None):
    cur = d
    for k in keys:
        if cur is None: return default
        if isinstance(cur, dict): cur = cur.get(k)
        elif isinstance(cur, list) and isinstance(k, int):
            cur = cur[k] if 0 <= k < len(cur) else None
        else: return default
    return cur if cur is not None else default

# ---------------------------------------------------------------------------
# Polygon fetchers
# ---------------------------------------------------------------------------

def poly_get(path, params=None):
    try:
        url = f"{POLYGON_BASE}{path}"
        r = requests.get(url, params=params or {},
                         headers={"Authorization": f"Bearer {POLYGON_API_KEY}"},
                         timeout=20)
        if r.status_code == 200:
            return r.json()
    except Exception as e:
        print(f"    polygon error {path}: {e}")
    return {}

def fetch_grouped(date_str):
    return poly_get(f"/v2/aggs/grouped/locale/us/market/stocks/{date_str}",
                    {"adjusted": "false"}).get("results") or []

def fetch_ticker_details(ticker):
    return poly_get(f"/v3/reference/tickers/{ticker}").get("results")

def fetch_intraday_minute(ticker, date_str):
    return poly_get(
        f"/v2/aggs/ticker/{ticker}/range/1/minute/{date_str}/{date_str}",
        {"adjusted": "true", "sort": "asc", "limit": 500}
    ).get("results") or []

def analyze_intraday(bars):
    if not bars:
        return None, None, None
    hod_bar = max(bars, key=lambda b: b.get("h", 0))
    ts = hod_bar.get("t", 0) / 1000
    hod_time = datetime.fromtimestamp(ts, tz=timezone.utc).replace(tzinfo=None) - timedelta(hours=4)
    market_open = hod_time.replace(hour=9, minute=30, second=0, microsecond=0)
    session = "premarket" if hod_time < market_open else "regular session"
    pm_bars = [b for b in bars
               if datetime.fromtimestamp(b.get("t",0)/1000, tz=timezone.utc).replace(tzinfo=None) - timedelta(hours=4) < market_open]
    pm_high = max((b.get("h", 0) for b in pm_bars), default=None)
    return hod_time.strftime("%I:%M %p ET"), session, pm_high

def fetch_avg_volume(ticker, date_str, days=20):
    start = str(date.fromisoformat(date_str) - timedelta(days=days+10))
    bars = poly_get(
        f"/v2/aggs/ticker/{ticker}/range/1/day/{start}/{date_str}",
        {"adjusted": "true", "sort": "desc", "limit": days+5}
    ).get("results") or []
    past = [b["v"] for b in bars
            if b.get("t") and str(date.fromtimestamp(b["t"]/1000)) != date_str]
    if past:
        return sum(past[:days]) / min(len(past), days)
    return None

def fetch_reverse_split(ticker, date_str):
    """Returns True if Polygon shows a reverse split for this ticker on date_str."""
    res = poly_get("/v3/reference/splits", {
        "ticker":           ticker,
        "execution_date":   date_str,
        "limit":            5,
    }).get("results", [])
    for s in res:
        if s.get("split_from", 1) > s.get("split_to", 1):
            return True   # split_from > split_to = reverse split
    return False


def fetch_news(ticker, date_str):
    res = poly_get("/v2/reference/news", {
        "ticker": ticker,
        "published_utc.gte": f"{date_str}T00:00:00Z",
        "published_utc.lte": f"{date_str}T23:59:59Z",
        "limit": 5
    }).get("results", [])
    return [{"title": x.get("title",""), "publisher": safe_get(x,"publisher","name","")}
            for x in res if x.get("title")]

# ---------------------------------------------------------------------------
# AskEdgar fetchers
# ---------------------------------------------------------------------------

# Module-level flag so we stop bashing AskEdgar once we're clearly blocked
_AE_BLOCKED = False


def ae_get(endpoint, params):
    """
    AskEdgar API GET with proactive rate-limit handling.

    Reads X-RateLimit-Remaining from every response and sleeps if close to the wall.
    On 429, respects the Retry-After header exactly. On 503, retries with short delay.
    On 402 (insufficient credits) or trial_ticker_limit, returns empty immediately.

    If we detect a sustained block (3+ consecutive 429s across multiple endpoints)
    we flip the module-level _AE_BLOCKED flag and short-circuit all future calls
    in this run — no point hammering.
    """
    global _AE_BLOCKED
    if _AE_BLOCKED:
        return {}

    url = f"{ASKEDGAR_BASE}/{endpoint}"
    headers = {"API-KEY": ASKEDGAR_API_KEY}

    for attempt in range(3):  # was 5 — no point retrying 5x if we're blocked
        try:
            r = requests.get(url, params=params, headers=headers, timeout=20)
        except Exception as e:
            print(f"    askedgar {endpoint} network error: {e}")
            time.sleep(2)
            continue

        # Proactive throttle: if we're close to the ceiling, wait for reset
        remaining = r.headers.get("X-RateLimit-Remaining")
        reset_ts  = r.headers.get("X-RateLimit-Reset")
        if remaining is not None:
            try:
                rem = int(remaining)
                if rem <= 5 and reset_ts:
                    wait = max(int(reset_ts) - int(time.time()), 1) + 1
                    print(f"    ⏸  rate limit near ceiling ({rem} left), sleeping {wait}s...")
                    time.sleep(min(wait, 65))
            except (ValueError, TypeError):
                pass

        if r.status_code == 200:
            return r.json()

        # Rate-limited
        if r.status_code == 429:
            retry_after = r.headers.get("Retry-After")
            # If there's no server-provided Retry-After, this is NOT a normal rate limit.
            # Likely a trial-ticker-limit dressed as 429, or a sustained block.
            if not retry_after:
                # Try to read the error code from the body
                try:
                    body = r.json()
                    err_code = body.get("error", {}).get("code", "")
                    err_msg  = body.get("error", {}).get("message", "")
                except Exception:
                    err_code, err_msg = "", ""
                print(f"    ⛔ 429 on {endpoint} with no Retry-After header.")
                print(f"       Error code: {err_code!r}")
                print(f"       Error message: {err_msg!r}")
                print(f"       This is likely a trial-ticker-limit or sustained block.")
                print(f"       Giving up on AskEdgar for the rest of this run.")
                _AE_BLOCKED = True
                return {}

            # Real rate limit — respect it
            try:
                wait = int(retry_after)
            except ValueError:
                wait = 2 ** attempt
            wait = min(max(wait, 1), 120)
            print(f"    ⏸  429 on {endpoint}, Retry-After {wait}s (attempt {attempt+1}/3)...")
            time.sleep(wait)
            continue

        # Service temporarily unavailable — short wait, try again
        if r.status_code == 503:
            print(f"    ⏸  503 on {endpoint}, retrying in 5s...")
            time.sleep(5)
            continue

        # Hard stops — don't retry
        if r.status_code == 402:
            print(f"    ⛔ 402 insufficient credits. Aborting all AskEdgar calls for this run.")
            _AE_BLOCKED = True
            return {}

        # Check for trial ticker limit before giving up
        try:
            body = r.json()
            if body.get("error", {}).get("code") == "trial_ticker_limit":
                print(f"    ⛔ Trial ticker limit hit on {endpoint}. Resets at midnight CT.")
                print(f"       Giving up on AskEdgar for the rest of this run.")
                _AE_BLOCKED = True
                return {}
        except Exception:
            pass

        # 404 / 422 = no data for this ticker, normal outcome
        if r.status_code in (404, 422):
            return {}

        # Anything else — log and stop retrying this request
        print(f"    askedgar {endpoint} {r.status_code}: {r.text[:160]}")
        return {}

    # 3 attempts failed with real Retry-After — skip this request but don't block the run
    print(f"    ⏭  {endpoint}: 3 retries failed, skipping")
    return {}

def fetch_ae_bundle(ticker, debug=False, as_of_date=None):
    """
    Pull everything we need from AskEdgar in one batch.
    If as_of_date is provided (YYYY-MM-DD string), requests the historical-float-pro
    endpoint for a point-in-time float snapshot. Falls back to current float-outstanding
    if historical endpoint returns nothing.
    """
    # --- point-in-time float if historical date requested ---
    if as_of_date:
        hist_float = _fetch_historical_float(ticker, as_of_date, debug=debug)
    else:
        hist_float = None

    # Use historical float if found; else fall back to current snapshot
    float_out_results = hist_float if hist_float else safe_get(
        ae_get("float-outstanding", {"ticker": ticker}), "results", default=[]
    )

    bundle = {
        "dilution_rating": safe_get(ae_get("dilution-rating", {"ticker": ticker}), "results", default=[]),
        "dilution_data":   safe_get(ae_get("dilution-data",   {"ticker": ticker, "limit": 20}), "results", default=[]),
        "registrations":   safe_get(ae_get("registrations",   {"ticker": ticker, "limit": 10}), "results", default=[]),
        "offerings":       safe_get(ae_get("offerings",       {"ticker": ticker, "limit": 10}), "results", default=[]),
        "float_out":       float_out_results,
        "research":        safe_get(ae_get("research-reports",{"ticker": ticker, "limit": 1}), "results", default=[]),
        "news":            safe_get(ae_get("news",            {"ticker": ticker, "limit": 20}), "results", default=[]),
        "_float_source":   "historical-float-pro" if hist_float else "float-outstanding",
    }
    if debug:
        dump_file = f"askedgar_debug_{ticker}.json"
        with open(dump_file, "w", encoding="utf-8") as f:
            json.dump(bundle, f, indent=2, default=str)
        print(f"      🔍 DEBUG: dumped raw AskEdgar response → {dump_file}")
        print(f"      🔍 Float source: {bundle['_float_source']}")
        print(f"      🔍 Field preview:")
        for key, arr in bundle.items():
            if key.startswith("_"): continue
            if arr and isinstance(arr, list) and len(arr) > 0 and isinstance(arr[0], dict):
                print(f"         {key}: {list(arr[0].keys())}")
            else:
                print(f"         {key}: {'empty' if not arr else type(arr).__name__}")
    time.sleep(0.05)  # minimal courtesy delay; real throttling is header-driven
    return bundle


def _fetch_historical_float(ticker, as_of_date, debug=False):
    """
    Query the historical-float-pro endpoint for float as of a specific date.
    Tries a few param-name variants since the exact schema isn't publicly documented.
    Returns a list of results (same shape as float_out) or None if nothing found.

    Strictly filters out any record dated AFTER as_of_date to prevent lookahead.
    """
    def record_date(r):
        """Best-guess effective date for a record. Returns YYYY-MM-DD string or ''."""
        for fld in ("date", "as_of_date", "effective_date", "period",
                    "filed_at", "last_updated"):
            v = r.get(fld)
            if v:
                return str(v)[:10]
        return ""

    # Attempt the endpoint with a few param-name variants
    for param_name, param_set in [
        ("end_date",   {"ticker": ticker, "end_date": as_of_date, "limit": 50}),
        ("to_date",    {"ticker": ticker, "to_date":  as_of_date, "limit": 50}),
        ("as_of",      {"ticker": ticker, "as_of":    as_of_date, "limit": 50}),
        ("date",       {"ticker": ticker, "date":     as_of_date, "limit": 50}),
        ("no_param",   {"ticker": ticker, "limit": 100}),
    ]:
        raw = ae_get("historical-float-pro", param_set)
        results = safe_get(raw, "results", default=None)

        if debug:
            count = len(results) if results else 0
            sample_dates = [record_date(r) for r in (results or [])[:3]]
            print(f"        hist-float [{param_name}] → {count} records, "
                  f"sample dates: {sample_dates}")

        if not results: continue

        # Hard filter: only keep records dated STRICTLY on or before as_of_date
        filtered = []
        for r in results:
            d = record_date(r)
            if d and d <= as_of_date:
                filtered.append((d, r))

        if debug:
            print(f"        hist-float [{param_name}] → {len(filtered)} after no-lookahead filter")

        if filtered:
            filtered.sort(key=lambda x: x[0], reverse=True)
            best_date, best_record = filtered[0]
            normalized = _normalize_historical_float(best_record)
            normalized["_as_of_date"] = best_date
            if debug:
                print(f"        hist-float → using record dated {best_date}, float={normalized.get('float')}")
            return [normalized]

    if debug:
        print(f"        hist-float → NO historical record ≤ {as_of_date}, will use current snapshot")
    return None


def _normalize_historical_float(r):
    """
    Map historical-float-pro field names to the shape classify_runner expects
    (matching the float-outstanding endpoint's schema).
    """
    # Try multiple field-name variants for each attribute
    return {
        "ticker":              r.get("ticker"),
        "float":               r.get("float") or r.get("float_shares") or r.get("public_float"),
        "outstanding":         r.get("outstanding") or r.get("shares_outstanding") or r.get("total_shares"),
        "market_cap_final":    r.get("market_cap_final") or r.get("market_cap") or r.get("mkt_cap"),
        "industry":            r.get("industry"),
        "sector":              r.get("sector"),
        "country":             r.get("country"),
        "isadr":               r.get("isadr"),
        "insider_percent":     r.get("insider_percent") or r.get("insider_pct"),
        "affiliate_percent":   r.get("affiliate_percent"),
        "institutions_percent":r.get("institutions_percent") or r.get("institutional_pct"),
        "last_updated":        r.get("last_updated") or r.get("date") or r.get("as_of_date"),
        "_as_of_date":         r.get("date") or r.get("as_of_date") or r.get("effective_date"),
    }

# ---------------------------------------------------------------------------
# Classification logic
# ---------------------------------------------------------------------------

def classify_runner(m, ae, date_str):
    """
    Returns dict with:
      primary_tag  - one of: RIG, RETAIL PUMP, FUNDAMENTAL, UNDERWRITER MANIP,
                             NEWS-DRIVEN, SYMPATHY, DILUTION BAIT, COMPLIANCE, MIXED
      reasons      - short bullets explaining the classification
      risk_badges  - risk label chips
      tldr         - parsed TLDR from AskEdgar research report
    """
    reasons     = []
    risk_badges = []

    # --- parse AskEdgar dilution rating ---
    rating       = (ae["dilution_rating"][0] if ae["dilution_rating"] else {}) or {}
    overall_risk = (rating.get("overall_offering_risk") or "").lower()
    offering_abl = (rating.get("offering_ability") or "").lower()
    dilution_lvl = (rating.get("dilution") or "").lower()
    dilution_desc = rating.get("dilution_desc") or ""
    cash_months  = rating.get("cash_remaining_months")
    cash_burn    = rating.get("cash_burn")
    nasdaq_comp  = (rating.get("nasdaq_compliance") or "").lower()
    nasdaq_desc  = rating.get("nasdaq_compliance_desc") or ""
    regsho       = bool(rating.get("regsho"))
    warrant_exer = (rating.get("warrant_exercise") or "").lower()

    # --- parse registrations: ATM / shelf / best-efforts ---
    active_atm     = False
    atm_remaining  = None
    active_shelf   = False
    shelf_raisable = None
    active_best_efforts = False
    bank = None
    for r in ae["registrations"]:
        if not r.get("effective_status"): continue
        headline = (r.get("headline") or "").upper()
        if r.get("is_atm"):
            active_atm = True
            atm_remaining = r.get("amount_remaining_atm")
            bank = r.get("bank")
        if "SHELF" in headline or "S-3" in headline:
            active_shelf = True
            shelf_raisable = r.get("offering_amount") or r.get("baby_shelf_raisable_amount")
        if "BEST EFFORTS" in headline or "OFFERING" in headline:
            active_best_efforts = True
            bank = bank or r.get("bank")

    # --- parse warrants / dilution_data ---
    warrants_itm_count   = 0
    warrants_itm_shares  = 0
    warrants_zero_strike = 0
    warrants_zero_shares = 0
    toxic_price_protection = False
    curr_price = m.get("close") or 0
    for w in ae["dilution_data"]:
        strike = w.get("warrants_exercise_price")
        remaining = w.get("warrants_remaining") or 0
        pp = (w.get("price_protection") or "").lower()
        if strike == 0:
            warrants_zero_strike += 1
            warrants_zero_shares += remaining
        elif strike is not None and curr_price > 0 and strike <= curr_price:
            warrants_itm_count += 1
            warrants_itm_shares += remaining
        if any(k in pp for k in ("reset", "cashless", "alternate", "adjustment")):
            toxic_price_protection = True

    # --- parse offerings: recent pricing ---
    recent_offering       = False
    recent_offering_desc  = None
    recent_offering_bank  = None
    cutoff = str(date.fromisoformat(date_str) - timedelta(days=7))
    for off in ae["offerings"]:
        d = off.get("filed_at")
        if d and d >= cutoff:
            recent_offering = True
            amt = off.get("offering_amount")
            price = off.get("share_price")
            otype = off.get("offering_type") or off.get("form_type") or "offering"
            recent_offering_desc = f"{otype} {d}: ${amt/1e6:.1f}M @ ${price}" if amt and price else f"{otype} {d}"
            break

    # --- parse research report ---
    research = ae["research"][0] if ae["research"] else {}
    report_text = research.get("report_text") or ""
    tldr = extract_tldr(report_text)
    key_sections = extract_key_sections(report_text)

    # --- parse Grok/AI insights + jmt415 notes from news endpoint ---
    insights  = extract_insights(ae.get("news", []), target_date_str=date_str)
    jmt_notes = extract_jmt_notes(ae.get("news", []), target_date_str=date_str, days_back=7)

    # --- build risk badges ---
    if m.get("float") and m["float"] < 10:
        risk_badges.append(f"Float {m['float']}M")
    if active_atm:
        label = "Active ATM"
        if atm_remaining: label += f" ${atm_remaining/1e6:.1f}M"
        risk_badges.append(label)
    if active_best_efforts and bank:
        risk_badges.append(f"Best-efforts ({bank})")
    if warrants_zero_strike:
        risk_badges.append(f"X{warrants_zero_strike} zero-strike warrants ({warrants_zero_shares/1e6:.1f}M sh)")
    if warrants_itm_count:
        risk_badges.append(f"X{warrants_itm_count} warrants ITM")
    if active_shelf and shelf_raisable:
        risk_badges.append(f"${shelf_raisable/1e6:.1f}M shelf")
    if regsho:
        risk_badges.append("RegSHO")
    if toxic_price_protection:
        risk_badges.append("Toxic price protection")
    if nasdaq_comp == "high":
        risk_badges.append("Nasdaq risk")
    if overall_risk == "high":
        risk_badges.append("High offering risk")

    # --- classification rules (priority order) ---
    tag = None
    headlines = m.get("headlines") or []
    material_kw = ["fda", "approval", "contract", "acquisition", "merger", "partnership",
                   "earnings", "beats", "raises guidance", "clinical", "phase",
                   "award", "authorization", "clearance", "breakthrough"]
    news_material = any(any(k in (h.get("title","").lower()) for k in material_kw)
                        for h in headlines)
    # Also check Grok insights for material keywords (Polygon headlines often lag)
    insights_text = " ".join(m.get("insights", []) or []).lower()
    if not news_material and insights_text:
        news_material = any(k in insights_text for k in material_kw)

    # 1. UNDERWRITER MANIP: recent offering + active ATM or best-efforts
    if recent_offering and (active_atm or active_best_efforts):
        tag = "UNDERWRITER MANIP"
        reasons.append(f"Recent offering: {recent_offering_desc}")
        if bank: reasons.append(f"Placement agent: {bank} — supply unload mechanics active")

    # 2. DILUTION BAIT: zero-strike warrants or ITM warrants + high dilution
    elif warrants_zero_strike > 0:
        tag = "DILUTION BAIT"
        reasons.append(f"{warrants_zero_shares/1e6:.1f}M zero-exercise-price warrants registered — "
                       f"every tick up unlocks free dilution")
        if toxic_price_protection:
            reasons.append("Toxic price protection (reset/cashless) — warrant count grows as price falls")

    elif warrants_itm_count >= 2 and dilution_lvl == "high":
        tag = "DILUTION BAIT"
        reasons.append(f"X{warrants_itm_count} warrant tranches ITM ({warrants_itm_shares/1e6:.1f}M shares)")
        reasons.append(f"Dilution rating: High ({dilution_desc})")

    # 3. FUNDAMENTAL vs NEWS-DRIVEN
    elif news_material:
        if active_atm or active_shelf or warrants_itm_count > 0:
            tag = "NEWS-DRIVEN"
            reasons.append("Material news catalyst present")
            reasons.append("BUT dilution mechanics active — fade risk elevated")
        else:
            tag = "FUNDAMENTAL"
            reasons.append("Material news catalyst from credible publisher")
            reasons.append("Clean capital structure — no active ATM/shelf/ITM warrants")

    # 4. RIG: sub-15M float + active offering mechanics + no news
    elif (m.get("float") or 999) < 15 and (active_atm or active_shelf or active_best_efforts):
        tag = "RIG"
        reasons.append(f"Sub-15M float ({m.get('float')}M) + active offering mechanics")
        if m.get("relVol") and m["relVol"] > 20:
            reasons.append(f"RelVol {m['relVol']}x — coordinated entry signature")
        if regsho: reasons.append("On Reg-SHO threshold list")

    # 5. COMPLIANCE: Nasdaq deficiency reclaim
    elif nasdaq_comp == "high":
        tag = "COMPLIANCE"
        reasons.append("Nasdaq compliance risk — reclaim-driven move")
        if nasdaq_desc: reasons.append(nasdaq_desc[:200])

    # 6. RETAIL PUMP
    elif (m.get("float") or 999) < 20 and (m.get("relVol") or 0) > 15 and not active_atm and not active_shelf:
        tag = "RETAIL PUMP"
        reasons.append("No filings or news catalyst — social-driven")
        reasons.append(f"Float {m.get('float')}M + RelVol {m.get('relVol')}x")

    # 7. SYMPATHY
    elif not news_material:
        tag = "SYMPATHY"
        reasons.append("No direct catalyst — sector/sympathy driven")

    else:
        tag = "MIXED"
        reasons.append("Mixed signals — see full research report")

    # Cash runway context
    if cash_months is not None and cash_months < 12:
        reasons.append(f"Cash runway: {cash_months:.1f} months → must raise")

    return {
        "primary_tag":   tag,
        "reasons":       reasons,
        "risk_badges":   risk_badges,
        "cash_months":   cash_months,
        "cash_burn":     cash_burn,
        "overall_risk":  overall_risk,
        "dilution_lvl":  dilution_lvl,
        "nasdaq_comp":   nasdaq_comp,
        "tldr":          tldr,
        "key_sections":  key_sections,
        "insights":      insights,
        "jmt_notes":     jmt_notes,
        "gain_pct":      research.get("gain_percentage"),
    }


EMOJI_MAP = {
    ":red_circle:":    "🔴",
    ":yellow_circle:": "🟡",
    ":green_circle:":  "🟢",
    ":orange_circle:": "🟠",
    ":blue_circle:":   "🔵",
    ":white_circle:":  "⚪",
    ":black_circle:":  "⚫",
}

def clean_discord_emoji(s):
    """Replace Discord emoji shortcodes with actual emoji characters."""
    if not s: return s
    for code, emoji in EMOJI_MAP.items():
        s = s.replace(code, emoji)
    return s


def parse_report_sections(report_text):
    """
    Parse the AskEdgar research report into named sections.
    Report uses markdown headers like:  ****Section Name****  or  ****Section Name**  :red_circle:**
    Returns a dict keyed by normalized section name → list of bullet strings.
    """
    if not report_text: return {}

    import re
    # Match either ****Title****  or  ****Title**  :emoji:** (with optional trailing emoji marker)
    # Capture just the clean title (no asterisks, no emoji shortcode)
    pattern = re.compile(r"\*{4}([^*:\n]+?)(?:\*{2}\s*:?(\w+)?:?\*{2}|\*{4})", re.MULTILINE)

    matches = list(pattern.finditer(report_text))
    if not matches:
        return {}

    sections = {}
    for i, m in enumerate(matches):
        title = m.group(1).strip()
        emoji_code = m.group(2)  # e.g. "red_circle" (no colons from regex)
        # Content runs from end of this header to start of next header (or EOF)
        start = m.end()
        end = matches[i+1].start() if i+1 < len(matches) else len(report_text)
        body = report_text[start:end].strip()
        body = clean_discord_emoji(body)

        # Attach emoji indicator to title if present
        emoji_icon = ""
        if emoji_code:
            emoji_icon = EMOJI_MAP.get(f":{emoji_code}:", "")

        sections[title] = {
            "emoji":   emoji_icon,
            "body":    body,
            "bullets": _extract_bullets(body),
            "prose":   _extract_prose(body),
        }
    return sections


def _extract_bullets(body):
    """Pull bullet-style lines (•, -, *) from a section body."""
    bullets = []
    for ln in body.split("\n"):
        s = ln.strip()
        if not s: continue
        if s.startswith("•") or s.startswith("-") or s.startswith("*"):
            clean = s.lstrip("•-* ").strip()
            clean = clean_discord_emoji(clean)
            if clean:
                bullets.append(clean)
    return bullets


def _extract_prose(body):
    """Pull non-bullet prose lines for sections without bullets."""
    prose = []
    for ln in body.split("\n"):
        s = ln.strip()
        if not s: continue
        if s.startswith("•") or s.startswith("-") or s.startswith("*"): continue
        prose.append(clean_discord_emoji(s))
    return "\n".join(prose)


def extract_tldr(report_text):
    """Pull the TLDR section bullets from the research report markdown."""
    sections = parse_report_sections(report_text)
    tldr = sections.get("TLDR") or sections.get("Overall Takeaway")
    if tldr and tldr["bullets"]:
        # Filter out any accidental header lines that slipped in as bullets
        clean = [b for b in tldr["bullets"]
                 if not b.strip().startswith("TLDR")
                 and not b.strip().endswith("**")
                 and len(b.strip()) > 10]
        return clean[:6]

    # Fallback: the **TLDR** line in FCHL's report is a plain bold header,
    # not the 4x-asterisk pattern my parser expects. Try a direct text search.
    if report_text:
        import re
        # Match "**TLDR**" or "****TLDR****" and grab everything until end or next header
        match = re.search(r"\*{2,}TLDR\*{2,}\s*\n(.+?)(?=\n\*{2,}|\Z)",
                          report_text, re.DOTALL)
        if match:
            import unicodedata
            bullets = []
            for ln in match.group(1).split("\n"):
                s = ln.strip()
                if not s: continue
                first = s[0] if s else ""
                is_bullet = (s.startswith("•") or s.startswith("-") or s.startswith("*")
                             or (first and unicodedata.category(first) in ("So", "Sm", "Sc")))
                if is_bullet:
                    clean = s.lstrip("•-* ").strip()
                    if clean and unicodedata.category(clean[0]) in ("So", "Sm", "Sc"):
                        clean = clean[1:].strip()
                    clean = clean_discord_emoji(clean)
                    if clean and len(clean) > 10:
                        bullets.append(clean)
            return bullets[:8]
    return []


def extract_insights(ae_news, target_date_str=None):
    """
    Pull Grok AI-generated 'why the stock is moving' insights from the news endpoint.
    These come back with form_type='grok' and content in the 'summary' field.
    If target_date_str is provided, prefer insights filed on that date (the trade day).
    Filters out low-signal bullets (individual trader callouts, obvious volume stats,
    sector non-events) and returns only the top substantive drivers.
    """
    if not ae_news: return []

    grok_items = [x for x in ae_news if (x.get("form_type") or "").lower() == "grok"]
    if not grok_items: return []

    # Prefer an item filed on the target date; fall back to most recent
    chosen = None
    if target_date_str:
        for item in grok_items:
            if item.get("filed_at") == target_date_str:
                chosen = item
                break
    if not chosen:
        grok_items.sort(key=lambda x: x.get("filed_at") or "", reverse=True)
        chosen = grok_items[0]

    summary = chosen.get("summary") or ""
    if not summary: return []

    # Patterns that indicate a low-signal bullet we should skip
    skip_patterns = [
        # Individual trader/account callouts
        "@", "follower", "followers", "small account", "small accounts",
        "low-follower", "large-follower", "no influencers", "no major influencers",
        "no high-follower", "commentary from",
        # Social sentiment filler
        "social media sentiment", "x/twitter", "x / twitter", "twitter sentiment",
        "sentiment on x", "bullish momentum hype", "bearish tone",
        "stocktwits", "reddit", "discord", "telegram",
        # Volume / relative volume / momentum restatements (we see these in the tile)
        "relative volume", "elevated vs", "elevated volume", "low-float mania",
        "momentum trading", "momentum traders", "low float squeeze",
        "scalper", "scalpers", "scalp play", "low float momentum",
        "short borrow", "short interest as", "squeeze setup",
        # Catalog misses
        "no upcoming", "no confirmed upcoming", "no earnings", "no catalysts",
        "no major announcement", "no specific news",
    ]

    def is_low_signal(text):
        low = text.lower()
        # Strip leading markdown bold header for matching
        # e.g. "**Social media sentiment on X**: ..." → match "social media sentiment on x"
        header_match = low.lstrip("*").split(":", 1)[0] if ":" in low else low[:120]
        for pat in skip_patterns:
            if pat in header_match:
                return True
        return False

    bullets = []
    for raw in summary.split("\n"):
        s = raw.strip()
        if not s: continue
        if s.startswith("•") or s.startswith("-") or s.startswith("*"):
            clean = s.lstrip("•-* ").strip()
            if clean and len(clean) > 15 and not is_low_signal(clean):
                bullets.append(clean)

    # If no bullets found but there's prose, return it as one block
    if not bullets and summary.strip() and not is_low_signal(summary):
        bullets = [summary.strip()]

    # Cap at top 4 — keeps it tight but allows room for the sector/theme bullet
    return bullets[:4]


def extract_jmt_notes(ae_news, target_date_str=None, days_back=7):
    """
    Pull jmt415 analyst Discord notes from the news endpoint.
    These are dated trader commentary filed with form_type='jmt415'.
    Returns a list of (date, text) tuples.
    """
    if not ae_news: return []
    jmt_items = [x for x in ae_news if (x.get("form_type") or "").lower() == "jmt415"]
    if not jmt_items: return []

    # Limit to the past `days_back` days from the target date
    if target_date_str:
        try:
            cutoff = str(date.fromisoformat(target_date_str) - timedelta(days=days_back))
            jmt_items = [x for x in jmt_items if (x.get("filed_at") or "") >= cutoff]
        except:
            pass

    jmt_items.sort(key=lambda x: x.get("filed_at") or "", reverse=True)
    notes = []
    for item in jmt_items[:4]:
        txt = item.get("summary") or ""
        d   = item.get("filed_at") or ""
        if txt:
            notes.append({"date": d, "text": txt.strip()})
    return notes


def extract_key_sections(report_text):
    """
    Return a curated list of (title, emoji, bullets, prose) tuples
    for sections most relevant to the recap tile.
    Handles numbered prefixes and emoji in section headers e.g.
    "1) Recent News & Filings 🟡" -> matches "Recent News & Filings"
    """
    import re, unicodedata
    sections = parse_report_sections(report_text)
    if not sections: return []

    def normalize_title(t):
        # Strip leading number+paren like "1) " or "2. "
        t = re.sub(r"^\d+[\)\.]\s*", "", t.strip())
        # Strip trailing/leading emoji characters
        t = t.strip()
        while t and unicodedata.category(t[-1]) in ("So", "Sm", "Sc"):
            t = t[:-1].strip()
        while t and unicodedata.category(t[0]) in ("So", "Sm", "Sc"):
            t = t[1:].strip()
        return t.lower()

    # Build normalized lookup
    normalized_sections = {normalize_title(k): v for k, v in sections.items()}

    # Sections we want to surface, in display order
    wanted = [
        ("News / Why it's running", ["Recent News & Filings", "Recent News", "News", "News / Why it's running", "Recent News Filings"]),
        ("Theme",                    ["Theme"]),
        ("Dilution Risk",            ["Dilution Risk", "Dilution", "Offering Risk, Ability & Frequency", "Offering Risk"]),
        ("Chart History",            ["Chart History"]),
        ("Compliance",               ["Compliance", "Compliance Risk"]),
        ("Debt & Liabilities",       ["Debt & Liabilities", "Debt Liabilities", "Debt and Liabilities"]),
        ("Analyst Notes",            ["Jmt415 Analyst Notes", "Jmt415 Historical Commentary", "Analyst Notes"]),
        ("Other Catalysts",          ["Other Catalysts", "Upcoming Catalysts", "Upcoming Events"]),
    ]

    out = []
    for display_title, aliases in wanted:
        for alias in aliases:
            sec = normalized_sections.get(normalize_title(alias))
            if sec and (sec["bullets"] or sec["prose"]):
                out.append({
                    "title":   display_title,
                    "emoji":   sec["emoji"],
                    "bullets": sec["bullets"][:5],
                    "prose":   sec["prose"][:500] if sec["prose"] else "",
                })
                break
    return out

# ---------------------------------------------------------------------------
# Main pull
# ---------------------------------------------------------------------------

def get_day_movers(target_date):
    prev_date = get_prev_trading_date(target_date)
    date_str  = str(target_date)
    prev_str  = str(prev_date)

    print(f"\n  Fetching Polygon grouped bars ({date_str} / prev {prev_str})...")
    today_bars = fetch_grouped(date_str)
    prev_bars  = fetch_grouped(prev_str)
    if not today_bars:
        return [], []

    prev_map = {r["T"]: r["c"] for r in prev_bars if r.get("c")}



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
        gap_pct = round((r.get("o", 0) - pc) / pc * 100, 2) if pc else 0
        if hod_pct <= 0: continue

        all_movers.append({
            "ticker": ticker, "hodPct": hod_pct, "gapPct": gap_pct,
            "fadePct":   round((hod - r.get("c",0)) / hod * 100, 2) if hod else 0,
            "prevClose": round(pc, 4),
            "open":      round(r.get("o",0), 4),
            "high":      round(hod, 4),
            "low":       round(r.get("l",0), 4),
            "close":     round(r.get("c",0), 4),
            "vwap":      round(r.get("vw",0), 4),
            "vsVwap":    "above" if r.get("c",0) > r.get("vw",0) else "below",
            "vol":       int(r.get("v",0)),
        })

    all_movers.sort(key=lambda x: x["hodPct"], reverse=True)

    # Split top N (post float filter) from near-misses
    top, near_miss = [], []
    detail_cache = {}

    print(f"  {len(all_movers)} raw candidates. Enriching...")

    for c in all_movers:
        if len(top) >= TOP_N and c["hodPct"] < NEAR_MISS_PCT:
            break
        ticker = c["ticker"]
        details = detail_cache.setdefault(ticker, fetch_ticker_details(ticker))
        time.sleep(0.05)
        if not details: continue
        float_shares = details.get("share_class_shares_outstanding")
        float_m = float_shares/1e6 if float_shares else None

        # Skip reverse splits that occurred on this exact trading day
        if fetch_reverse_split(ticker, date_str):
            print(f"    [SKIP] {ticker} — reverse split on {date_str}")
            time.sleep(0.03)
            continue
        time.sleep(0.03)

        # Near-miss logic: gapped >= NEAR_MISS_PCT but float too high or not top N
        if float_m and float_m > MAX_FLOAT_M:
            if c["hodPct"] >= NEAR_MISS_PCT:
                near_miss.append({**c, "name": details.get("name", ticker),
                                  "float": round(float_m,1) if float_m else None,
                                  "reason_missed": f"Float {float_m:.0f}M > {MAX_FLOAT_M}M cap"})
            continue

        if len(top) >= TOP_N:
            # already full; this is a near-miss (below top N but still gapped big)
            if c["hodPct"] >= NEAR_MISS_PCT:
                near_miss.append({**c, "name": details.get("name", ticker),
                                  "float": round(float_m,1) if float_m else None,
                                  "reason_missed": f"Ranked #{len(top)+len(near_miss)+1} by HOD %"})
            continue

        print(f"    [{len(top)+1}/{TOP_N}] {ticker}...")
        bars = fetch_intraday_minute(ticker, date_str)
        hod_time, session, pm_high = analyze_intraday(bars)
        time.sleep(0.05)
        avg_vol = fetch_avg_volume(ticker, date_str)
        rel_vol = round(c["vol"]/avg_vol, 1) if avg_vol else None
        time.sleep(0.05)
        headlines = fetch_news(ticker, date_str)
        time.sleep(0.05)

        print(f"      → AskEdgar lookup...")
        # Debug only the first ticker so we don't spam the terminal
        ae = fetch_ae_bundle(ticker, debug=(DEBUG_MODE and len(top) == 0))

        # Reset per-ticker AE fields — prevents bleedover when AE is blocked
        audited_float_m = None
        audited_country = (details.get("locale") or "us").upper()
        audited_sector  = details.get("sic_description", "Unknown")
        audited_mc      = details.get("market_cap") or 0

        # Prefer AskEdgar's audited share structure data when available
        ae_float_out = ae["float_out"][0] if ae["float_out"] else {}
        if ae_float_out.get("float"):
            audited_float_m = round(ae_float_out["float"]/1e6, 2)
        if ae_float_out.get("country"):
            audited_country = ae_float_out["country"].upper()
        if ae_float_out.get("sector") or ae_float_out.get("industry"):
            audited_sector = ae_float_out.get("sector") or ae_float_out.get("industry")
        if ae_float_out.get("market_cap_final"):
            audited_mc = ae_float_out["market_cap_final"]

        # Pre-extract Grok insights so classify_runner can use them for tagging
        pre_insights = extract_insights(ae.get("news", []), target_date_str=date_str)

        enriched = {
            **c,
            "name":      details.get("name", ticker),
            "sector":    audited_sector,
            "country":   audited_country.upper(),
            "float":     audited_float_m if audited_float_m is not None else (round(float_m, 1) if float_m else None),
            "float_src": "AE" if audited_float_m is not None else "Polygon",
            "marketCap": audited_mc,
            "hodTime":   hod_time,
            "session":   session,
            "pmHigh":    round(pm_high, 4) if pm_high else None,
            "relVol":    rel_vol,
            "avgVol":    round(avg_vol/1e6, 1) if avg_vol else None,
            "headlines": headlines,
            "ae":        ae,
            "insights":  pre_insights,
            "insider_pct":       ae_float_out.get("insider_percent"),
            "institutions_pct":  ae_float_out.get("institutions_percent"),
        }
        enriched["classification"] = classify_runner(enriched, ae, date_str)
        top.append(enriched)

    return top, near_miss

# ---------------------------------------------------------------------------
# Output: Markdown
# ---------------------------------------------------------------------------

def render_markdown(target, movers, near_miss):
    lines = []
    lines.append(f"# Small Cap Evening Rundown — {target.strftime('%A %B %d, %Y')}")
    lines.append(f"Top {len(movers)} HOD runners + {len(near_miss)} near-misses\n")

    for i, m in enumerate(movers):
        c = m["classification"]
        fade_note = "strong fade" if m["fadePct"] > 50 else "moderate fade" if m["fadePct"] > 25 else "held well"
        lines.append(f"## #{i+1}  {m['ticker']}  +{m['hodPct']}% HOD  — [{c['primary_tag']}]")
        lines.append(f"{m['name']} | {m['sector']} | {m['country']} | Float: {m['float']}M ({m.get('float_src','?')}) | MktCap: {fmt_mc(m['marketCap'])}")
        lines.append("")
        lines.append(f"Risk badges: {', '.join(c['risk_badges']) if c['risk_badges'] else '—'}")
        lines.append("")
        insights = c.get("insights") or []
        if insights:
            lines.append("**Why it's moving (grok):**")
            for ins in insights:
                lines.append(f"  - {ins}")
        else:
            lines.append("**Why it ran:**")
            for r in c["reasons"]:
                lines.append(f"  - {r}")
        lines.append("")
        for sec in c.get("key_sections", []):
            header = f"{sec['title']} {sec['emoji']}".strip()
            lines.append(f"**{header}:**")
            if sec["bullets"]:
                for b in sec["bullets"]:
                    lines.append(f"  - {b}")
            elif sec["prose"]:
                lines.append(f"  {sec['prose']}")
            lines.append("")
        jmt_notes = c.get("jmt_notes") or []
        if jmt_notes:
            lines.append("**jmt415 Live Notes (discord):**")
            for n in jmt_notes:
                lines.append(f"  - [{n['date']}] {n['text']}")
            lines.append("")
        if c.get("tldr"):
            lines.append("**AskEdgar TLDR:**")
            for t in c["tldr"]:
                lines.append(f"  - {t}")
            lines.append("")
        lines.append("**Price action:**")
        lines.append(f"  Prev Close : ${m['prevClose']}")
        lines.append(f"  Open       : ${m['open']}  (Gap: {m['gapPct']:+.2f}%)")
        lines.append(f"  HOD        : ${m['high']} @ {m['hodTime'] or '?'} ({m['session'] or ''})")
        lines.append(f"  Close      : ${m['close']}  (Fade: {m['fadePct']}% — {fade_note})")
        lines.append(f"  VWAP       : ${m['vwap']} (closed {m['vsVwap']} VWAP)")
        if m.get("pmHigh"): lines.append(f"  PM High    : ${m['pmHigh']}")
        lines.append("")
        lines.append(f"**Volume:** {fmt_vol(m['vol'])}"
                     + (f" | RelVol {m['relVol']}x vs {m['avgVol']}M avg" if m.get("relVol") else ""))
        lines.append("")
        if m["headlines"]:
            lines.append("**Headlines:**")
            for h in m["headlines"][:3]:
                lines.append(f"  - {h['title']} ({h['publisher']})")
        else:
            lines.append("**Headlines:** none found")
        lines.append("")
        lines.append("-"*60)
        lines.append("")

    if near_miss:
        lines.append(f"## Near-misses: gapped ≥{NEAR_MISS_PCT}% but didn't make top {TOP_N}")
        lines.append("")
        for m in near_miss:
            lines.append(f"- **{m['ticker']}**  +{m['hodPct']}% HOD, Float {m.get('float','?')}M — {m['reason_missed']}")
        lines.append("")

    lines.append("_Paste into Claude for deeper TA review and sector theme analysis._")
    return "\n".join(lines)

# ---------------------------------------------------------------------------
# Output: HTML tiles
# ---------------------------------------------------------------------------

TAG_COLORS = {
    # (tile background, border/accent color, text color for tag pill)
    "RIG":               ("#f0fdf4", "#16a34a", "#ffffff"),
    "FUNDAMENTAL":       ("#ecfdf5", "#059669", "#ffffff"),
    "NEWS-DRIVEN":       ("#fefce8", "#ca8a04", "#ffffff"),
    "UNDERWRITER MANIP": ("#fef2f2", "#dc2626", "#ffffff"),
    "DILUTION BAIT":     ("#fff7ed", "#ea580c", "#ffffff"),
    "RETAIL PUMP":       ("#fdf4ff", "#c026d3", "#ffffff"),
    "COMPLIANCE":        ("#fefce8", "#ca8a04", "#ffffff"),
    "SYMPATHY":          ("#eff6ff", "#2563eb", "#ffffff"),
    "MIXED":             ("#f9fafb", "#6b7280", "#ffffff"),
}

def render_html(target, movers, near_miss):
    def esc(s): return html.escape(str(s) if s is not None else "")

    tiles = []
    for i, m in enumerate(movers):
        c = m["classification"]
        bg, border, tag_text = TAG_COLORS.get(c["primary_tag"], TAG_COLORS["MIXED"])

        # risk badges
        badges = "".join(
            f'<span class="badge">{esc(b)}</span>' for b in c["risk_badges"]
        )

        # headlines
        hl_html = ""
        if m["headlines"]:
            hl_items = "".join(
                f'<li>{esc(h["title"])} <span class="pub">({esc(h["publisher"])})</span></li>'
                for h in m["headlines"][:3]
            )
            hl_html = f'<div class="section-lbl">Headlines</div><ul class="hl">{hl_items}</ul>'

        # "Why it's moving": prefer Grok insights, fall back to rule-based reasons
        insights = c.get("insights") or []
        if insights:
            why_label = "Why it's moving"
            # Convert **bold** markers to <strong> so Grok's headers pop
            def grok_format(s):
                import re
                # Escape first, then swap **text** for bold
                s_escaped = esc(s)
                return re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s_escaped)
            why_body = "<ul class='reasons'>" + "".join(
                f"<li><span class='grok-tag'>grok</span> {grok_format(ins)}</li>"
                for ins in insights
            ) + "</ul>"
        else:
            why_label = "Why it ran"
            why_body = "<ul class='reasons'>" + "".join(
                f"<li>{esc(r)}</li>" for r in c["reasons"]
            ) + "</ul>"

        # Parsed research report sections (News / Dilution / Compliance / Analyst / Catalysts)
        sections_html = ""
        for sec in c.get("key_sections", []):
            body_html = ""
            if sec["bullets"]:
                body_html = "<ul class='sec-body'>" + "".join(
                    f"<li>{esc(b)}</li>" for b in sec["bullets"]
                ) + "</ul>"
            elif sec["prose"]:
                body_html = f"<div class='sec-prose'>{esc(sec['prose'])}</div>"
            sections_html += (
                f'<div class="sec"><div class="sec-head">{esc(sec["title"])} '
                f'<span class="sec-emoji">{sec["emoji"]}</span></div>{body_html}</div>'
            )

        # jmt415 Discord commentary (if any, separate from report's Analyst Notes)
        jmt_html = ""
        jmt_notes = c.get("jmt_notes") or []
        if jmt_notes:
            rows = "".join(
                f'<li><span class="jmt-date">{esc(n["date"])}</span> {esc(n["text"])}</li>'
                for n in jmt_notes
            )
            jmt_html = (
                f'<div class="sec"><div class="sec-head">jmt415 Live Notes '
                f'<span class="jmt-badge">discord</span></div>'
                f'<ul class="sec-body jmt-list">{rows}</ul></div>'
            )

        tldr_html = ""
        if c.get("tldr"):
            tldr_items = "".join(f"<li>{esc(t)}</li>" for t in c["tldr"])
            tldr_html = f'<div class="section-lbl">AskEdgar TLDR</div><ul class="tldr">{tldr_items}</ul>'

        tiles.append(f"""
        <div class="tile" style="border-left: 4px solid {border}; background: {bg};">
          <div class="tile-head">
            <div class="tile-rank">#{i+1}</div>
            <div class="tile-ticker">{esc(m['ticker'])}</div>
            <div class="tile-tag" style="background:{border};color:{tag_text};">{esc(c['primary_tag'])}</div>
            <div class="tile-hod">+{m['hodPct']}% HOD</div>
          </div>
          <div class="tile-sub">
            <span>Float {esc(m.get('float','?'))}M <span class="src">({esc(m.get('float_src','?'))})</span></span>
            <span>•</span>
            <span>{esc(m.get('sector',''))}</span>
            <span>•</span>
            <span>{esc(m.get('country',''))}</span>
            <span>•</span>
            <span>MktCap {esc(fmt_mc(m.get('marketCap',0)))}</span>
          </div>
          <div class="badges">{badges}</div>
          <div class="section-lbl">{esc(why_label)}</div>
          {why_body}
          {sections_html}
          {jmt_html}
          {tldr_html}
          <div class="pa">
            <div><span>Prev</span><b>${m['prevClose']}</b></div>
            <div><span>Open</span><b>${m['open']}</b> <i>({m['gapPct']:+.1f}%)</i></div>
            <div><span>HOD</span><b>${m['high']}</b> <i>{esc(m.get('hodTime') or '')}</i></div>
            <div><span>Close</span><b>${m['close']}</b> <i>(fade {m['fadePct']}%)</i></div>
            <div><span>VWAP</span><b>${m['vwap']}</b> <i>({m['vsVwap']})</i></div>
            <div><span>Vol</span><b>{esc(fmt_vol(m['vol']))}</b>{f" <i>RelVol {m['relVol']}x</i>" if m.get('relVol') else ''}</div>
          </div>
          {hl_html}
        </div>
        """)

    nm_html = ""
    if near_miss:
        rows = "".join(
            f"<tr><td><b>{esc(m['ticker'])}</b></td>"
            f"<td>+{m['hodPct']}%</td>"
            f"<td>{esc(m.get('float','?'))}M</td>"
            f"<td>{esc(m['reason_missed'])}</td></tr>"
            for m in near_miss
        )
        nm_html = f"""
        <h2 class="section">Near-misses: gapped ≥{NEAR_MISS_PCT}% but didn't make top {TOP_N}</h2>
        <table class="nm"><thead><tr><th>Ticker</th><th>HOD %</th><th>Float</th><th>Reason</th></tr></thead>
        <tbody>{rows}</tbody></table>
        """

    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8">
<title>Evening Rundown — {target}</title>
<style>
  body {{ background: #ffffff; color: #1f2937;
          font-family: -apple-system, 'Segoe UI', Roboto, sans-serif;
          max-width: 1100px; margin: 0 auto; padding: 24px;
          line-height: 1.5; }}
  h1 {{ font-size: 22px; margin: 0 0 4px; color: #111827; font-weight: 600; }}
  .phase {{ background: #eff6ff; color: #1e40af; padding: 8px 14px; border-radius: 6px;
            font-size: 13px; margin-bottom: 24px; display: inline-block;
            border: 1px solid #dbeafe; }}
  .tile {{ border-radius: 10px; padding: 16px 20px; margin-bottom: 14px;
           border: 1px solid #e5e7eb; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }}
  .tile-head {{ display: flex; align-items: center; gap: 12px; margin-bottom: 6px; }}
  .tile-rank {{ color: #9ca3af; font-size: 13px; font-weight: 600; }}
  .tile-ticker {{ font-size: 19px; font-weight: 700; letter-spacing: 0.5px; color: #111827; }}
  .tile-tag {{ padding: 3px 10px; border-radius: 4px; font-size: 11px; font-weight: 700;
               text-transform: uppercase; letter-spacing: 0.3px; }}
  .tile-hod {{ margin-left: auto; font-size: 15px; font-weight: 600; color: #059669; }}
  .tile-sub {{ color: #6b7280; font-size: 12px; display: flex; gap: 6px; flex-wrap: wrap;
               margin-bottom: 10px; }}
  .badges {{ display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }}
  .badge {{ background: #ffffff; padding: 3px 9px; border-radius: 12px;
            font-size: 11px; color: #4b5563; border: 1px solid #e5e7eb; }}
  .section-lbl {{ color: #6b7280; font-size: 11px; text-transform: uppercase;
                  letter-spacing: 0.5px; margin: 10px 0 4px; font-weight: 600; }}
  .reasons, .hl, .tldr {{ margin: 0 0 8px; padding-left: 20px; font-size: 13px; line-height: 1.6; }}
  .reasons li {{ margin-bottom: 3px; color: #1f2937; }}
  .grok-tag {{ display: inline-block; background: #eef2ff; color: #4338ca; padding: 1px 6px;
               border-radius: 3px; font-size: 10px; font-weight: 600; text-transform: lowercase;
               margin-right: 4px; letter-spacing: 0.3px; }}
  .jmt-badge {{ display: inline-block; background: #f3e8ff; color: #7c3aed; padding: 1px 6px;
                border-radius: 3px; font-size: 10px; font-weight: 600; text-transform: lowercase;
                margin-left: 4px; letter-spacing: 0.3px; }}
  .jmt-list li {{ margin-bottom: 6px; }}
  .jmt-date {{ color: #9ca3af; font-size: 11px; font-family: monospace; margin-right: 6px; }}
  .sec {{ margin: 10px 0 6px; }}
  .sec-head {{ font-weight: 600; font-size: 12px; color: #374151; margin-bottom: 3px;
               display: flex; align-items: center; gap: 6px; }}
  .sec-emoji {{ font-size: 13px; }}
  .sec-body {{ margin: 2px 0 4px; padding-left: 20px; font-size: 12.5px; line-height: 1.55; color: #1f2937; }}
  .sec-body li {{ margin-bottom: 2px; }}
  .sec-prose {{ font-size: 12.5px; line-height: 1.55; color: #1f2937; }}
  .tldr {{ font-size: 12px; color: #4b5563; background: #ffffff;
           padding: 10px 10px 10px 28px; border-radius: 6px; margin-top: 4px;
           border: 1px solid #e5e7eb; }}
  .tldr li {{ margin-bottom: 4px; }}
  .src {{ color: #9ca3af; font-size: 10px; }}
  .pa {{ display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px 18px;
         font-size: 12px; margin-top: 8px; padding-top: 10px;
         border-top: 1px solid #e5e7eb; }}
  .pa div span {{ color: #6b7280; margin-right: 6px; }}
  .pa div b {{ color: #111827; }}
  .pa div i {{ color: #6b7280; font-style: normal; }}
  .hl li {{ color: #1f2937; }}
  .hl .pub {{ color: #9ca3af; font-size: 11px; }}
  .section {{ margin-top: 40px; color: #111827; font-size: 16px;
              border-bottom: 1px solid #e5e7eb; padding-bottom: 6px; font-weight: 600; }}
  .nm {{ width: 100%; border-collapse: collapse; font-size: 13px; }}
  .nm th {{ text-align: left; color: #6b7280; font-weight: 500; padding: 8px;
           border-bottom: 1px solid #e5e7eb; }}
  .nm td {{ padding: 8px; border-bottom: 1px solid #f3f4f6; color: #1f2937; }}
</style></head>
<body>
  <div class="phase">Evening Rundown — {target.strftime('%A %B %d, %Y')} — Top {len(movers)} HOD runners</div>
  <h1>Small Cap Evening Recap</h1>
  {''.join(tiles)}
  {nm_html}
</body></html>"""

# ---------------------------------------------------------------------------
# Heat-gauge JSON output (heat-gauge.v1 schema for data2.json merge)
# ---------------------------------------------------------------------------

THRESHOLDS = {
    "hodHot":       150,
    "hodNeutralLo": 100,
    "fadeHot":      25,
    "fadeCold":     40,
}

def build_heat_gauge_entry(target_date, movers, near_miss):
    """
    Convert one day's movers into a heat-gauge.v1 entry dict.
    Mirrors the schema used by historical_heatgauge.py so merge.py
    can fold it straight into data2.json.
    """
    date_str = str(target_date)
    runners  = []

    for m in movers:
        c    = m["classification"]
        news = [h["title"] for h in (m.get("headlines") or []) if h.get("title")]

        # Build sections from classification key_sections + reasons
        sections = []
        for sec in c.get("key_sections", []):
            sections.append({
                "title":   sec["title"],
                "emoji":   sec.get("emoji"),
                "bullets": sec.get("bullets", []),
                "prose":   sec.get("prose"),
            })
        if not sections and c.get("reasons"):
            sections.append({
                "title":   "Why it ran",
                "emoji":   None,
                "bullets": c["reasons"],
                "prose":   None,
            })

        runner = {
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
            "insights":     c.get("insights", []),
            "jmtNotes":     c.get("jmt_notes", []),
            "tldr":         c.get("tldr", []),
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
        }
        runners.append(runner)

    # Day-level summary fields
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

    news_note = ""
    for r in runners:
        if r["news"]:
            news_note = f" news: {r['sym']} — \"{r['news'][0]}\"."
            break

    note = (
        f"{lead.get('sym','')} led +{lead.get('hodExact',0)}% "
        f"({lead.get('fade',0)}% fade). "
        f"{sum(1 for r in runners if r['fade'] < 20)}/{len(runners)} "
        f"held <20% fade.{news_note}"
    ) if runners else "No qualifying runners."

    return {
        "date":    date_str,
        "runners": runners,
        "hod":     lead.get("hod", 0),
        "fade":    avg_fad,
        "hodTime": lead.get("time", "session"),
        "theme":   theme,
        "note":    note,
    }


def render_heat_gauge_json(target_date, movers, near_miss):
    """Build the full heat-gauge.v1 wrapper for a single day."""
    entry = build_heat_gauge_entry(target_date, movers, near_miss)
    return {
        "schema":     "heat-gauge.v1",
        "exportedAt": datetime.utcnow().isoformat() + "Z",
        "count":      len(movers),
        "thresholds": THRESHOLDS,
        "entries":    [entry],
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    global POLYGON_API_KEY, ASKEDGAR_API_KEY, DEBUG_MODE

    print("📊 Small Cap Evening Rundown Generator")
    print("=" * 50)

    print("\nPaste your Polygon API key and press Enter:")
    POLYGON_API_KEY = input("> ").strip()

    print("\nPaste your AskEdgar API key and press Enter:")
    ASKEDGAR_API_KEY = input("> ").strip()

    print("\nEnable debug mode? Dumps raw AskEdgar JSON for the first ticker (y/N):")
    DEBUG_MODE = input("> ").strip().lower() in ("y", "yes")
    if DEBUG_MODE:
        print("  🔍 Debug mode ON — first ticker's raw response will be saved.")

    while True:
        print("\nEnter date to pull (YYYY-MM-DD), or press Enter for most recent trading day:")
        date_input = input("> ").strip()
        if not date_input:
            target = date.today()
            while not is_trading_day(target):
                target -= timedelta(days=1)
            break
        try:
            parts = date_input.split("-")
            target = date(int(parts[0]), int(parts[1]), int(parts[2]))
            if not is_trading_day(target):
                print(f"  {date_input} not a trading day.")
                continue
            if target > date.today():
                print("  Date cannot be in the future.")
                continue
            break
        except:
            print("  Invalid format. Use YYYY-MM-DD.")

    date_str = str(target)
    print(f"\nRunning rundown for {date_str}...")

    movers, near_miss = get_day_movers(target)
    if not movers:
        print("No movers found.")
        input("\nPress Enter to close...")
        return

    hg_json  = render_heat_gauge_json(target, movers, near_miss)

    # Resolve output directory — fall back to current folder if OUTPUT_DIR missing
    out_dir = OUTPUT_DIR if OUTPUT_DIR and os.path.isdir(OUTPUT_DIR) else os.getcwd()
    if out_dir != os.getcwd():
        print(f"\n  Output directory: {out_dir}")
    else:
        print(f"\n  ⚠  OUTPUT_DIR not found — saving to current folder instead.")

    hg_file = os.path.join(out_dir, f"heat-gauge-{date_str}.json")

    with open(hg_file, "w", encoding="utf-8") as f:
        json.dump(hg_json, f, indent=2, ensure_ascii=False)

    print(f"\n✅ Done!")
    print(f"   Heat-gauge: {hg_file}")
    print(f"\n→ Run merge.py in {out_dir} to fold into data2.json, then push via GitHub Desktop.")

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"\nERROR: {e}")
        import traceback; traceback.print_exc()
    input("\nPress Enter to close...")
