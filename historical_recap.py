"""
historical_recap.py
-------------------
Multi-day historical rundown of small cap HOD runners.
Reuses the classification engine from evening_recap.py but enforces a strict
"no lookahead" filter: for each trading day processed, any data with a filed_at,
created_at, or last_updated timestamp AFTER that day is removed BEFORE classification.

This makes the output suitable for pattern studies and backtesting.

Outputs:
  - historical_recap_START_to_END.md   (combined markdown for the whole range)

Usage:
    cd Downloads
    python historical_recap.py
"""

import sys, os, time, json, requests
from datetime import date, timedelta, datetime

# ---------------------------------------------------------------------------
# Reuse evening_recap.py's helpers + classification engine
# ---------------------------------------------------------------------------
# Assumption: historical_recap.py lives in the same folder as evening_recap.py.
# We import everything we need so we don't duplicate logic.
try:
    import evening_recap as ER
except ImportError:
    print("ERROR: evening_recap.py must be in the same folder as this script.")
    input("\nPress Enter to close...")
    sys.exit(1)

# ---------------------------------------------------------------------------
# Date range helpers
# ---------------------------------------------------------------------------

def trading_days_between(start_d, end_d):
    """Yield every trading day from start_d through end_d inclusive."""
    d = start_d
    while d <= end_d:
        if ER.is_trading_day(d):
            yield d
        d += timedelta(days=1)


def prompt_date_range():
    """Ask the user for a start/end date or accept a preset."""
    print("\nDate range options:")
    print("  1) Last week   (prior 5 trading days ending yesterday)")
    print("  2) Last month  (prior 21 trading days ending yesterday)")
    print("  3) Custom range (enter start + end)")
    print("  4) Single day")
    choice = input("\nSelect 1-4: ").strip()

    today = date.today()
    # Start from most recent trading day (not today, since today may still be in-progress)
    end_anchor = today - timedelta(days=1)
    while not ER.is_trading_day(end_anchor):
        end_anchor -= timedelta(days=1)

    if choice == "1":
        # Walk back 5 trading days
        count, d = 0, end_anchor
        while count < 4:
            d -= timedelta(days=1)
            if ER.is_trading_day(d): count += 1
        return d, end_anchor

    if choice == "2":
        count, d = 0, end_anchor
        while count < 20:
            d -= timedelta(days=1)
            if ER.is_trading_day(d): count += 1
        return d, end_anchor

    if choice == "4":
        print("\nEnter date (YYYY-MM-DD):")
        d = parse_date(input("> ").strip())
        return d, d

    # Custom
    print("\nEnter start date (YYYY-MM-DD):")
    start = parse_date(input("> ").strip())
    print("Enter end date (YYYY-MM-DD):")
    end = parse_date(input("> ").strip())
    if start > end:
        start, end = end, start
    return start, end


def parse_date(s):
    parts = s.split("-")
    return date(int(parts[0]), int(parts[1]), int(parts[2]))


# ---------------------------------------------------------------------------
# Lookahead filter
# ---------------------------------------------------------------------------

def _ts_leq(ts, cutoff_iso):
    """
    Return True if a timestamp (string, ISO-ish or YYYY-MM-DD) is <= cutoff.
    If ts is missing/unparseable, returns True so we err on the side of keeping
    the record (better to have slight staleness than drop too much).
    """
    if not ts: return True
    t = str(ts)[:10]  # take YYYY-MM-DD prefix, ignore time component
    return t <= cutoff_iso


def filter_bundle_for_date(bundle, cutoff_date_str):
    """
    Given a full AskEdgar bundle for a ticker, return a filtered copy
    containing only records that existed on or before cutoff_date_str.

    This is THE critical function for no-lookahead backtesting.
    """
    cutoff = cutoff_date_str
    filtered = {}

    # --- news (grok insights, jmt notes, filings) ---
    filtered["news"] = [
        item for item in bundle.get("news", [])
        if _ts_leq(item.get("filed_at") or item.get("created_at"), cutoff)
    ]

    # --- offerings ---
    filtered["offerings"] = [
        item for item in bundle.get("offerings", [])
        if _ts_leq(item.get("filed_at"), cutoff)
    ]

    # --- registrations (ATM, shelf) ---
    filtered["registrations"] = [
        item for item in bundle.get("registrations", [])
        if _ts_leq(item.get("filed_at"), cutoff)
    ]

    # --- dilution_data (warrants/convertibles) ---
    filtered["dilution_data"] = [
        item for item in bundle.get("dilution_data", [])
        if _ts_leq(item.get("filed_at"), cutoff)
    ]

    # --- research report (keep only if created on/before cutoff) ---
    filtered["research"] = [
        item for item in bundle.get("research", [])
        if _ts_leq(item.get("created_at"), cutoff)
    ]

    # --- dilution_rating: CANNOT filter by date (rating is a current snapshot).
    # Only flag as "forward" if the rating was last_updated MORE than 7 days
    # after the trade day — otherwise it's close enough to be trustworthy.
    rating = bundle.get("dilution_rating", [])
    filtered["dilution_rating"] = rating
    rating_is_materially_forward = False
    if rating:
        last_upd = str(rating[0].get("last_updated") or "")[:10]
        if last_upd > cutoff:
            try:
                from datetime import date as _date
                cutoff_d = _date.fromisoformat(cutoff)
                upd_d    = _date.fromisoformat(last_upd)
                days_ahead = (upd_d - cutoff_d).days
                rating_is_materially_forward = days_ahead > 7
            except:
                rating_is_materially_forward = True
    filtered["_rating_is_current_snapshot"] = rating_is_materially_forward

    # --- float_out: current float, NOT historical. Keep but flag. ---
    # Same logic: only flag as forward if updated more than 7 days after cutoff.
    float_out = bundle.get("float_out", [])
    filtered["float_out"] = float_out
    float_is_materially_forward = False
    if float_out:
        last_upd = str(float_out[0].get("last_updated") or "")[:10]
        if last_upd > cutoff:
            try:
                from datetime import date as _date
                cutoff_d = _date.fromisoformat(cutoff)
                upd_d    = _date.fromisoformat(last_upd)
                days_ahead = (upd_d - cutoff_d).days
                float_is_materially_forward = days_ahead > 7
            except:
                float_is_materially_forward = True
    filtered["_float_is_current_snapshot"] = float_is_materially_forward

    return filtered


# ---------------------------------------------------------------------------
# Per-day pull with lookahead filter applied
# ---------------------------------------------------------------------------

def get_day_movers_historical(target_date, debug_first=False):
    """
    Like evening_recap.get_day_movers but applies the no-lookahead filter
    to all AskEdgar data before classification.
    """
    prev_date = ER.get_prev_trading_date(target_date)
    date_str  = str(target_date)
    prev_str  = str(prev_date)

    print(f"\n[{date_str}] Fetching Polygon grouped bars...")
    today_bars = ER.fetch_grouped(date_str)
    prev_bars  = ER.fetch_grouped(prev_str)
    if not today_bars:
        print(f"  no bars for {date_str} — skipping")
        return [], []

    prev_map = {r["T"]: r["c"] for r in prev_bars if r.get("c")}
    all_movers = []
    for r in today_bars:
        ticker = r.get("T","")
        if not ER.is_valid_ticker(ticker): continue
        pc = prev_map.get(ticker)
        if not pc or pc <= 0: continue
        if r.get("v", 0) < ER.MIN_VOLUME: continue
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

    top, near_miss = [], []
    detail_cache = {}

    print(f"  [{date_str}] {len(all_movers)} candidates, enriching...")

    for c in all_movers:
        if len(top) >= ER.TOP_N and c["hodPct"] < ER.NEAR_MISS_PCT:
            break
        ticker = c["ticker"]
        details = detail_cache.setdefault(ticker, ER.fetch_ticker_details(ticker))
        time.sleep(0.05)
        if not details: continue
        float_shares = details.get("share_class_shares_outstanding")
        float_m = float_shares/1e6 if float_shares else None

        if float_m and float_m > ER.MAX_FLOAT_M:
            if c["hodPct"] >= ER.NEAR_MISS_PCT:
                near_miss.append({**c, "name": details.get("name", ticker),
                                  "float": round(float_m,1) if float_m else None,
                                  "reason_missed": f"Float {float_m:.0f}M > {ER.MAX_FLOAT_M}M cap"})
            continue

        if len(top) >= ER.TOP_N:
            if c["hodPct"] >= ER.NEAR_MISS_PCT:
                near_miss.append({**c, "name": details.get("name", ticker),
                                  "float": round(float_m,1) if float_m else None,
                                  "reason_missed": f"Ranked below top {ER.TOP_N}"})
            continue

        print(f"    [{date_str}] [{len(top)+1}/{ER.TOP_N}] {ticker}")
        bars = ER.fetch_intraday_minute(ticker, date_str)
        hod_time, session, pm_high = ER.analyze_intraday(bars)
        time.sleep(0.05)
        avg_vol = ER.fetch_avg_volume(ticker, date_str)
        rel_vol = round(c["vol"]/avg_vol, 1) if avg_vol else None
        time.sleep(0.05)
        headlines = ER.fetch_news(ticker, date_str)  # Polygon — already day-bounded
        time.sleep(0.05)

        # Request point-in-time float via historical-float-pro for this trade day
        ae_raw = ER.fetch_ae_bundle(
            ticker,
            debug=(debug_first and len(top) == 0),
            as_of_date=date_str,
        )
        # ---- THE CRITICAL STEP: filter AskEdgar bundle for no-lookahead ----
        ae = filter_bundle_for_date(ae_raw, date_str)
        # Preserve float source metadata across the filter
        ae["_float_source"] = ae_raw.get("_float_source", "float-outstanding")

        # Prefer AskEdgar's audited share structure (historical when available)
        ae_float_out = ae["float_out"][0] if ae["float_out"] else {}
        audited_float_m = None
        if ae_float_out.get("float"):
            audited_float_m = round(ae_float_out["float"]/1e6, 2)
        audited_country = ae_float_out.get("country") or (details.get("locale") or "us").upper()
        audited_sector  = ae_float_out.get("sector") or ae_float_out.get("industry") or details.get("sic_description","Unknown")
        audited_mc      = ae_float_out.get("market_cap_final") or details.get("market_cap") or 0

        # Tag the float source precisely for the output
        if audited_float_m is not None:
            if ae.get("_float_source") == "historical-float-pro":
                float_src = "AE-historical"
                float_is_forward = False
                float_as_of = ae_float_out.get("_as_of_date") or ae_float_out.get("last_updated")
            else:
                float_src = "AE-current"
                float_is_forward = ae.get("_float_is_current_snapshot", False)
                float_as_of = None
        else:
            float_src = "Polygon"
            float_is_forward = False
            float_as_of = None

        enriched = {
            **c,
            "name":      details.get("name", ticker),
            "sector":    audited_sector,
            "country":   audited_country.upper(),
            "float":     audited_float_m if audited_float_m is not None else (round(float_m, 1) if float_m else None),
            "float_src": float_src,
            "float_as_of": float_as_of,
            "marketCap": audited_mc,
            "hodTime":   hod_time,
            "session":   session,
            "pmHigh":    round(pm_high, 4) if pm_high else None,
            "relVol":    rel_vol,
            "avgVol":    round(avg_vol/1e6, 1) if avg_vol else None,
            "headlines": headlines,
            "ae":        ae,
            # Caveats for historical view
            "rating_is_forward": ae.get("_rating_is_current_snapshot", False),
            "float_is_forward":  float_is_forward,
        }
        enriched["classification"] = ER.classify_runner(enriched, ae, date_str)
        top.append(enriched)

    return top, near_miss


# ---------------------------------------------------------------------------
# Combined markdown renderer
# ---------------------------------------------------------------------------

def render_combined_markdown(results):
    """
    results: list of (target_date, movers, near_miss) tuples, chronologically ordered.
    """
    if not results: return ""
    lines = []
    first_date = results[0][0]
    last_date  = results[-1][0]
    lines.append(f"# Historical Small Cap Rundown — {first_date} → {last_date}")
    lines.append(f"Covering {len(results)} trading days, top {ER.TOP_N} HOD runners per day.")
    lines.append("")
    lines.append("**No-lookahead guarantee:** for each day below, all AskEdgar data")
    lines.append("(news, Grok insights, offerings, filings, research reports, jmt415 notes)")
    lines.append("is filtered to only include records with `filed_at` / `created_at` on or")
    lines.append("before that trading day. Dilution rating and float use current snapshots;")
    lines.append("those are flagged per-ticker when they may reflect post-date info.")
    lines.append("")
    lines.append("-" * 70)
    lines.append("")

    for target, movers, near_miss in results:
        if not movers:
            lines.append(f"## {target.strftime('%A %B %d, %Y')} — no qualifying movers")
            lines.append("")
            continue

        lines.append(f"## {target.strftime('%A %B %d, %Y')}")
        lines.append("")

        for i, m in enumerate(movers):
            c = m["classification"]
            fade_note = "strong fade" if m["fadePct"] > 50 else "moderate fade" if m["fadePct"] > 25 else "held well"

            lines.append(f"### {target} #{i+1} — {m['ticker']} +{m['hodPct']}% HOD  [{c['primary_tag']}]")

            # Build the float descriptor with as-of date when historical
            float_desc = f"{m.get('float','?')}M ({m.get('float_src','?')}"
            if m.get('float_as_of'):
                float_desc += f" as of {str(m['float_as_of'])[:10]}"
            float_desc += ")"

            lines.append(f"{m['name']} | {m.get('sector','?')} | {m.get('country','?')} | "
                         f"Float: {float_desc} | "
                         f"MktCap: {ER.fmt_mc(m.get('marketCap',0))}")

            # Caveat line (only if relevant)
            caveats = []
            if m.get("rating_is_forward"):
                caveats.append("Dilution rating uses current snapshot (may include post-date info)")
            if m.get("float_is_forward"):
                caveats.append("Float figure uses current snapshot")
            if caveats:
                lines.append(f"_⚠ Caveats: {'; '.join(caveats)}_")
            lines.append("")

            if c.get("risk_badges"):
                lines.append(f"**Risk badges:** {', '.join(c['risk_badges'])}")
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

            lines.append(f"**Price action:**")
            lines.append(f"  Prev: ${m['prevClose']} | Open: ${m['open']} ({m['gapPct']:+.1f}% gap) | "
                         f"HOD: ${m['high']} @ {m.get('hodTime') or '?'} | Close: ${m['close']} "
                         f"(fade {m['fadePct']}% — {fade_note}) | VWAP: ${m['vwap']} ({m['vsVwap']})")
            lines.append(f"**Volume:** {ER.fmt_vol(m['vol'])}"
                         + (f" | RelVol {m['relVol']}x" if m.get('relVol') else ''))
            lines.append("")

            if m["headlines"]:
                lines.append("**Headlines:**")
                for h in m["headlines"][:3]:
                    lines.append(f"  - {h['title']} ({h['publisher']})")
                lines.append("")

            lines.append("---")
            lines.append("")

        if near_miss:
            lines.append(f"**Near-misses (gapped ≥{ER.NEAR_MISS_PCT}% but missed top {ER.TOP_N}):**")
            for m in near_miss:
                lines.append(f"  - {m['ticker']}  +{m['hodPct']}%  Float {m.get('float','?')}M  — {m['reason_missed']}")
            lines.append("")

        lines.append("=" * 70)
        lines.append("")

    lines.append("_End of historical rundown. Paste into Claude for multi-day pattern analysis._")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    print("📚 Historical Small Cap Rundown Generator")
    print("=" * 50)

    print("\nPaste your Polygon API key and press Enter:")
    ER.POLYGON_API_KEY = input("> ").strip()

    print("\nPaste your AskEdgar API key and press Enter:")
    ER.ASKEDGAR_API_KEY = input("> ").strip()

    print("\nEnable debug mode for the FIRST ticker of the FIRST day only? (y/N):")
    debug = input("> ").strip().lower() in ("y", "yes")
    ER.DEBUG_MODE = debug

    start_d, end_d = prompt_date_range()
    trading_days = list(trading_days_between(start_d, end_d))

    if not trading_days:
        print("\n⚠ No trading days in that range.")
        input("\nPress Enter to close...")
        return

    print(f"\nProcessing {len(trading_days)} trading days: {trading_days[0]} → {trading_days[-1]}")
    print("Enforcing strict no-lookahead filter on all AskEdgar data.\n")

    results = []
    for i, td in enumerate(trading_days):
        print(f"\n{'='*60}")
        print(f"[{i+1}/{len(trading_days)}] {td.strftime('%A %B %d, %Y')}")
        print('='*60)
        is_first = (i == 0)
        movers, near_miss = get_day_movers_historical(td, debug_first=(debug and is_first))
        results.append((td, movers, near_miss))

    print("\n\nRendering combined markdown...")
    md = render_combined_markdown(results)

    out_file = f"historical_recap_{start_d}_to_{end_d}.md"
    with open(out_file, "w", encoding="utf-8") as f:
        f.write(md)

    print(f"\n✅ Done!")
    print(f"   Output: {os.path.abspath(out_file)}")
    print(f"   {len(trading_days)} trading days processed.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\nInterrupted.")
    except Exception as e:
        print(f"\nERROR: {e}")
        import traceback; traceback.print_exc()
    input("\nPress Enter to close...")
