// MSF (Markdown Small-cap Feed) importer.
// Parses the output of weekly_recap.py — one or more .md files.
// Creates/merges day entries using runner-derived stats so avg HOD, avg fade,
// and dominant HOD-time are computed fresh (consistent with delete-runner logic).

// Heuristic matching the python script's is_valid_ticker — drop warrants & units.
function isValidTicker(t) {
  if (!t) return false;
  t = t.toUpperCase().trim();
  if (t.includes(".")) return false;
  // warrants: common suffixes on nasdaq/nyse 5-char tickers
  if (t.length >= 5 && (t.endsWith("WS") || t.endsWith("WT") || t.endsWith("WW"))) return false;
  if (t.length >= 5 && t.endsWith("W")) return false;   // e.g. HUBCW, ONFOW, RMSGW, RVMDW
  if (t.length === 5 && t.endsWith("Z")) return false;  // e.g. HUBCZ (warrant class)
  if (t.length >= 5 && t.endsWith("R")) return false;   // rights
  if (t.length >= 5 && t.endsWith("U")) return false;   // units
  return true;
}

// Filter by the security description text — ETFs, warrants, units, leveraged products.
// We check BOTH the security name and sector fields if present.
function isRealEquity(runner) {
  if (!isValidTicker(runner.sym)) return false;
  const text = `${runner.name || ""} ${runner.sector || ""}`.toLowerCase();
  if (!text.trim()) return true; // no name — fall back to ticker heuristic only
  const blocked = [
    /\bwarrant(s)?\b/,
    /\brights?\b(?!\s*offering)/,    // "Rights" as security class
    /\bunit(s)?\b/,
    /\betf\b/,
    /\betn\b/,                       // exchange-traded notes
    /\bleverage(d)?\b/,
    /\binverse\b/,
    /\bdaily\s+(long|short|bull|bear)/,
    /\b[23]x\s+(long|short|bull|bear)/,
    /\bultra(short|pro|long)?\b/,
    /\bnotes?\s+due\b/,
    /\bpreferred\b/,
    /\bsubordinat/,                  // subordinated notes
    /\bdebenture/,
    /\bdepositary\s+share/,          // ADRs w/ "Depositary Share" label are often warrants of ADRs
  ];
  // Note: "American Depositary Shares" is common for ADRs and is fine — whitelist that.
  if (/american\s+depositary\s+share/.test(text)) {
    // but still block warrants on ADRs, which would already match /warrant/ above
    return !/warrant|\betf\b|leverage|\b[23]x\b/.test(text);
  }
  return !blocked.some((rx) => rx.test(text));
}

// Extract HH:MM AM/PM time, return a Date for comparison purposes.
function parseHodTime(str) {
  // matches "04:43 PM ET" or "09:01 AM ET"
  const m = str && str.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const mn = parseInt(m[2], 10);
  const pm = m[3].toUpperCase() === "PM";
  if (pm && h !== 12) h += 12;
  if (!pm && h === 12) h = 0;
  return h * 60 + mn; // minutes since midnight
}

// Session = premarket if before 9:30, else regular.
function timeToSession(line) {
  if (/premarket/i.test(line)) return "premarket";
  if (/regular session/i.test(line)) return "session";
  const mins = parseHodTime(line);
  if (mins == null) return null;
  return mins < 9 * 60 + 30 ? "premarket" : "session";
}

// Split a comma-separated badge list like:
//   "Float 6.6M, Best-efforts (Univest Securities, LLC), X1 zero-strike warrants (48.0M sh)"
// — we can't naively split on commas because some badges contain commas in parens.
function splitRiskBadges(s) {
  const out = [];
  let buf = "", depth = 0;
  for (const ch of s) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      const t = buf.trim();
      if (t) out.push(t);
      buf = "";
    } else buf += ch;
  }
  const last = buf.trim();
  if (last) out.push(last);
  return out;
}

// Parse evening-recap "**Volume:**" inline value.
//   "431.5M | RelVol 84.7x vs 0.1M avg"
function parseVolumeInline(runner, s) {
  const v = s.match(/^\s*([\d.]+[KM]?)/i);
  if (v) runner.volRaw = v[1];
  const rv = s.match(/RelVol\s+([\d.]+)x(?:\s+vs\s+([\d.]+)M)?/i);
  if (rv) {
    runner.relVol = parseFloat(rv[1]);
    if (rv[2]) runner.avgVolM = parseFloat(rv[2]);
  }
}

// Parse historical-recap single-line "Price action:" content.
//   "Prev: $0.0038 | Open: $0.0045 (+18.4% gap) | HOD: $0.0416 @ 12:33 PM ET |
//    Close: $0.0168 (fade 59.62% — strong fade) | VWAP: $0.0202 (below)"
// Also tolerates "PM High: $X" inserted into the pipe list.
function parsePriceInline(runner, s) {
  const prev = s.match(/Prev(?:\s+Close)?\s*:\s*\$?([\d.]+)/i);
  if (prev) runner.prevClose = parseFloat(prev[1]);

  const op = s.match(/Open\s*:\s*\$?([\d.]+)\s*\(\s*([+\-\d.]+)%\s*gap/i);
  if (op) {
    runner.open = parseFloat(op[1]);
    runner.gapPct = parseFloat(op[2]);
  }

  const hod = s.match(/HOD\s*:\s*\$?([\d.]+)\s*@\s*([\d:]+\s*(?:AM|PM)\s*ET)/i);
  if (hod) {
    runner.high = parseFloat(hod[1]);
    runner.hodTimeExact = hod[2];
    const mins = parseHodTime(hod[2]);
    if (mins != null) runner.time = mins < 9 * 60 + 30 ? "premarket" : "session";
  }

  const cl = s.match(/Close\s*:\s*\$?([\d.]+)\s*\(\s*fade\s+([+\-\d.]+)%/i);
  if (cl) {
    runner.close = parseFloat(cl[1]);
    runner.fade = Math.round(parseFloat(cl[2]));
    runner.fadeExact = parseFloat(cl[2]);
  }

  const vw = s.match(/VWAP\s*:\s*\$?([\d.]+)\s*\(\s*(above|below)\s*\)/i);
  if (vw) {
    runner.vwap = parseFloat(vw[1]);
    runner.vsVwap = vw[2].toLowerCase();
  }

  const pm = s.match(/PM\s+High\s*:\s*\$?([\d.]+)/i);
  if (pm) runner.pmHigh = parseFloat(pm[1]);
}

// Convert a prose date like "Monday April 20, 2026" to ISO "2026-04-20".
function proseDateToIso(s) {
  const m = s.match(/(?:\w+\s+)?(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s*(\d{4})/i);
  if (!m) return null;
  const months = { january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12 };
  const mo = months[m[1].toLowerCase()];
  const d = parseInt(m[2], 10);
  const y = parseInt(m[3], 10);
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// Parse one markdown file's content into [{date, runners, note}].
// Supports three formats:
//   1) WEEKLY:     "## Monday 2026-04-13"  (day header) + "### #1 FCHL" (runner)
//   2) DAILY:      "# Small Cap Daily Recap - Monday April 20, 2026" + "## #1 FCHL" (runner)
//   3) HISTORICAL: "# Historical Small Cap Rundown ..." + "## Tuesday April 14, 2026"
//                  (prose dates) + "### 2026-04-14 #1 — HUBCZ +994.74% HOD"
function parseMsfMarkdown(text) {
  const lines = text.split(/\r?\n/);
  const days = [];
  let cur = null;
  let runner = null;
  let mode = null; // "weekly" | "daily" | "historical"

  const finalizeRunner = () => {
    if (!runner || !cur) return;
    if (runner.sym && runner.hod != null && runner.fade != null && runner.time) {
      // keep warrants/units out — mirror the python filter
      if (isValidTicker(runner.sym) && isRealEquity(runner)) cur.runners.push(runner);
    }
    runner = null;
  };

  const finalizeDay = () => {
    finalizeRunner();
    if (cur && cur.runners.length > 0) days.push(cur);
    cur = null;
  };

  // Detect file format from H1.
  for (const raw of lines.slice(0, 10)) {
    const trimmed = raw.trimEnd();
    // Daily/evening: "# Small Cap Daily Recap - Monday April 20, 2026"
    //                "# Small Cap Evening Rundown — Monday April 20, 2026"
    const h1daily = trimmed.match(/^#\s+.*(daily\s+recap|evening\s+rundown|evening\s+recap).*[\-\u2014]\s*(.+)$/i);
    if (h1daily) {
      const iso = proseDateToIso(h1daily[2]);
      if (iso) {
        mode = "daily";
        cur = { date: iso, runners: [] };
      }
      break;
    }
    // Historical: "# Historical Small Cap Rundown — 2026-04-14 → 2026-04-20"
    const h1hist = trimmed.match(/^#\s+.*historical\s+small\s+cap\s+rundown/i);
    if (h1hist) {
      mode = "historical";
      break;
    }
  }

  for (const raw of lines) {
    const line = raw.trimEnd();

    // Weekly day header: "## Monday 2026-04-13 | Avg HOD: +197%"
    if (mode !== "daily" && mode !== "historical") {
      const dayM = line.match(/^##\s+\w+\s+(\d{4}-\d{2}-\d{2})/);
      if (dayM) {
        finalizeDay();
        mode = "weekly";
        cur = { date: dayM[1], runners: [] };
        continue;
      }
    }

    // Historical day header: "## Tuesday April 14, 2026"
    if (mode === "historical") {
      const dayH = line.match(/^##\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+(.+)$/i);
      if (dayH) {
        finalizeDay();
        const iso = proseDateToIso(line.replace(/^##\s+/, ""));
        if (iso) cur = { date: iso, runners: [] };
        continue;
      }
    }
    if (!cur) continue;

    // Runner header — ### in weekly/historical, ## in daily.
    // Weekly/daily:   "## #1 FCHL - +248.77% HOD"
    // Evening:        "## #1  FCHL  +248.77% HOD  — [UNDERWRITER MANIP]"
    // Historical:     "### 2026-04-14 #1 — HUBCZ +994.74% HOD  [RETAIL PUMP]"
    // Dash between ticker and percent is optional (evening recap drops it).
    let runnerRx;
    if (mode === "daily") {
      runnerRx = /^##\s+#\d+\s+([A-Z0-9\-]+)\s+(?:[-\u2014]\s+)?\+?([\d.]+)%\s+HOD(?:\s*[\u2014\-]\s*\[([^\]]+)\])?/i;
    } else if (mode === "historical") {
      // Optional ISO-date prefix, then "#N — TICKER +X% HOD  [TAG]"
      runnerRx = /^###\s+(?:\d{4}-\d{2}-\d{2}\s+)?#\d+\s+(?:[-\u2014]\s+)?([A-Z0-9\-]+)\s+(?:[-\u2014]\s+)?\+?([\d.]+)%\s+HOD(?:\s*[\u2014\-]?\s*\[([^\]]+)\])?/i;
    } else {
      runnerRx = /^###\s+#\d+\s+([A-Z0-9\-]+)\s+(?:[-\u2014]\s+)?\+?([\d.]+)%\s+HOD(?:\s*[\u2014\-]\s*\[([^\]]+)\])?/i;
    }
    const runM = line.match(runnerRx);
    if (runM) {
      finalizeRunner();
      runner = {
        sym: runM[1].toUpperCase(),
        hod: Math.round(parseFloat(runM[2])),
        hodExact: parseFloat(runM[2]),
        news: [],
        _section: null, // "price"|"volume"|"news"|"reasons"|"tldr"|"headlines"|"dynamic"
      };
      if (runM[3]) runner.tag = runM[3].trim().toUpperCase();
      continue;
    }
    if (!runner) continue;

    // "Risk badges: Float 6.6M, Best-efforts (Univest Securities, LLC), ..."
    const rbM = line.match(/^Risk badges:\s*(.+)$/i);
    if (rbM) {
      const txt = rbM[1].trim();
      if (txt && txt !== "—") {
        runner.riskBadges = splitRiskBadges(txt);
      }
      continue;
    }

    // Bold section headers in evening recap:
    //   **Why it ran:**        → reason bullets (legacy)
    //   **AskEdgar TLDR:**     → tldr bullets
    //   **Price action:**      → price fields
    //   **Volume:** <inline>   → volume inline value
    //   **Headlines:** [none found | bullets follow]
    //   **<Any Other Title> <emoji?>:**  → dynamic runner.sections[] entry
    const boldM = line.match(/^\*\*([^*]+):\*\*\s*(.*)$/);
    if (boldM) {
      const rawLabel = boldM[1].trim();
      const label = rawLabel.toLowerCase();
      const inline = boldM[2].trim();

      // Known structural sections — bypass dynamic capture
      if (/^price\s*action$/.test(label)) {
        runner._section = "price";
        // Historical recap inlines the whole thing as pipe-separated fields
        // on the very next line; ALSO some formats put it on the same line.
        if (inline) parsePriceInline(runner, inline);
        continue;
      }
      if (/^volume$/.test(label)) {
        runner._section = "volume";
        if (inline) parseVolumeInline(runner, inline);
        continue;
      }
      if (/^headlines$/.test(label)) {
        runner._section = "headlines";
        if (inline && !/none\s+found/i.test(inline)) runner.news.push(inline);
        continue;
      }
      if (/^askedgar\s*tldr$/.test(label)) {
        runner._section = "tldr"; runner.tldr = [];
        continue;
      }
      if (/^why it ran$/.test(label)) {
        // Legacy format — old recaps. Keep as runner.reasons, don't duplicate into sections.
        runner._section = "reasons"; runner.reasons = [];
        continue;
      }

      // Everything else → dynamic section. Strip trailing stoplight emoji from title.
      const STOP = /(🔴|🟡|🟢|🟠|🔵)/;
      let title = rawLabel;
      let emoji = null;
      const em = title.match(STOP);
      if (em) {
        emoji = em[1];
        title = title.replace(STOP, "").trim();
      }
      const section = { title, emoji, bullets: [], prose: null };
      if (!runner.sections) runner.sections = [];
      runner.sections.push(section);
      runner._section = "dynamic";
      runner._currentSection = section;
      // If there's prose on the same line (inline), stash it
      if (inline) section.prose = inline;
      continue;
    }

    // Metadata line right after runner header:
    //   weekly/daily: "Real Messenger Corporation Ordinary Shares | Unknown | US | Float: 4.8M | MktCap: $25M"
    //   evening:      "Fitness Champs Holdings Limited | Consumer Defensive | US | Float: 6.6M (AE) | MktCap: $2M"
    // Only pick it up before we've set a name yet (first line after ### that has pipes).
    if (runner.name == null && line.includes("|") && !line.startsWith("#")) {
      const parts = line.split("|").map((s) => s.trim());
      if (parts.length >= 3) {
        runner.name = parts[0] || null;
        runner.sector = parts[1] && parts[1] !== "Unknown" ? parts[1] : null;
        runner.country = parts[2] || null;
        for (const p of parts.slice(3)) {
          const fm = p.match(/Float:\s*([\d.]+)M(?:\s*\(([^)]+)\))?/i);
          if (fm) {
            runner.floatM = parseFloat(fm[1]);
            if (fm[2]) runner.floatSrc = fm[2]; // "AE" or "Polygon"
          }
          const mc = p.match(/MktCap:\s*(\$[\d.]+[BM]|N\/A)/i);
          if (mc) runner.marketCap = mc[1];
        }
        continue;
      }
    }

    // Section markers
    if (/^Price Action:/i.test(line)) { runner._section = "price"; continue; }
    if (/^Volume:/i.test(line)) { runner._section = "volume"; continue; }
    if (/^News\s*\/\s*Catalyst:/i.test(line)) {
      runner._section = "news";
      // inline form: "News / Catalyst: None found — ..."
      const inline = line.replace(/^News\s*\/\s*Catalyst:\s*/i, "").trim();
      if (inline && !/None found/i.test(inline)) runner.news.push(inline);
      continue;
    }

    // Price-action fields
    if (runner._section === "price") {
      // Historical format: whole price action on one indented line with pipes.
      if (line.includes("|") && /Prev|Open|HOD|Close|VWAP/i.test(line)) {
        parsePriceInline(runner, line);
        continue;
      }
      const pc = line.match(/Prev Close\s*:\s*\$?([\d.]+)/i);
      if (pc) { runner.prevClose = parseFloat(pc[1]); continue; }
      // Weekly/daily: "Open : $4.2  (Gap Up: +130%)"
      // Evening:      "Open : $0.4665  (Gap: +30.16%)"
      const op = line.match(/Open\s*:\s*\$?([\d.]+)\s*\((?:Gap(?:\s+(?:Up|Down))?)?:?\s*([+\-\d.]+)%\)/i);
      if (op) {
        runner.open = parseFloat(op[1]);
        runner.gapPct = parseFloat(op[2]);
        continue;
      }
      // Weekly/daily: "High (HOD) : $1.39  @ 09:41 AM ET (regular session)"
      // Evening:      "HOD        : $1.25 @ 10:11 AM ET (regular session)"
      if (/^\s*(High\s*\(HOD\)|HOD)\s*:/i.test(line)) {
        const sess = timeToSession(line);
        if (sess) runner.time = sess;
        const hp = line.match(/\$([\d.]+)/);
        if (hp) runner.high = parseFloat(hp[1]);
        const tm = line.match(/@\s*([\d:]+\s*(?:AM|PM)\s*ET)/i);
        if (tm) runner.hodTimeExact = tm[1];
        continue;
      }
      const lo = line.match(/^\s*Low\s*:\s*\$?([\d.]+)/i);
      if (lo) { runner.low = parseFloat(lo[1]); continue; }
      const cl = line.match(/Close\s*:\s*\$?([\d.]+)\s*\(Fade:\s*([\d.\-]+)%/i);
      if (cl) {
        runner.close = parseFloat(cl[1]);
        runner.fade = Math.round(parseFloat(cl[2]));
        runner.fadeExact = parseFloat(cl[2]);
        continue;
      }
      const vw = line.match(/VWAP\s*:\s*\$?([\d.]+)\s*\(closed\s+(above|below)\s+VWAP\)/i);
      if (vw) {
        runner.vwap = parseFloat(vw[1]);
        runner.vsVwap = vw[2].toLowerCase();
        continue;
      }
      const pm = line.match(/PM High\s*:\s*\$?([\d.]+)/i);
      if (pm) { runner.pmHigh = parseFloat(pm[1]); continue; }
    }

    if (runner._section === "volume") {
      const v = line.match(/Today\s*:\s*([\d.]+[KM]?)/i);
      if (v) { runner.volRaw = v[1]; continue; }
      const rv = line.match(/RelVol:\s*([\d.]+)x\s*(?:\(vs\s+([\d.]+)M)?/i);
      if (rv) {
        runner.relVol = parseFloat(rv[1]);
        if (rv[2]) runner.avgVolM = parseFloat(rv[2]);
        continue;
      }
    }

    if (runner._section === "news") {
      // Bullet headlines: "  - Allbirds Stock Soars 670% On Sneaker To AI Pivot"
      const hl = line.match(/^\s*-\s+(.+)/);
      if (hl) runner.news.push(hl[1].trim());
    }

    // Evening recap bullet sections — handle with standard "- bullet" or "• bullet" prefixes
    if (runner._section === "reasons") {
      const b = line.match(/^\s*[-\u2022]\s+(.+)/);
      if (b) { (runner.reasons || (runner.reasons = [])).push(b[1].trim()); continue; }
    }
    if (runner._section === "dynamic" && runner._currentSection) {
      const b = line.match(/^\s*[-\u2022]\s+(.+)/);
      if (b) {
        runner._currentSection.bullets.push(b[1].trim());
        continue;
      }
      // Prose paragraph under a dynamic section (no bullet prefix, just indented text).
      // Only capture if the section has no bullets yet AND the line has real content.
      const prose = line.match(/^\s{2,}(\S.+)$/);
      if (prose && runner._currentSection.bullets.length === 0) {
        runner._currentSection.prose =
          (runner._currentSection.prose ? runner._currentSection.prose + " " : "") + prose[1].trim();
        continue;
      }
    }
    if (runner._section === "tldr") {
      const b = line.match(/^\s*[-\u2022]\s+(.+)/);
      if (b) { (runner.tldr || (runner.tldr = [])).push(b[1].trim()); continue; }
    }
    if (runner._section === "headlines") {
      // Headlines may appear as:
      //   - Title (Publisher)
      //   - Some headline text
      const b = line.match(/^\s*[-\u2022]\s+(.+)/);
      if (b) {
        const text = b[1].trim();
        if (!/^none\s+found/i.test(text)) runner.news.push(text);
        continue;
      }
    }
  }
  finalizeDay();
  // Strip private helper
  for (const d of days) for (const r of d.runners) delete r._section;
  return days;
}

// Roll runners into day-level stats — same formula used by delete-runner.
function rollupDay(runners) {
  if (runners.length === 0) return null;
  const avgHod = Math.round(runners.reduce((s, r) => s + r.hod, 0) / runners.length);
  const avgFade = Math.round(runners.reduce((s, r) => s + r.fade, 0) / runners.length);
  const pm = runners.filter((r) => r.time === "premarket").length;
  const ss = runners.filter((r) => r.time === "session").length;
  const n = runners.length;
  let hodTime;
  if (pm / n > 0.5) hodTime = "premarket";
  else if (ss / n > 0.5) hodTime = "session";
  else hodTime = "mixed";
  return { hod: avgHod, fade: avgFade, hodTime };
}

// Build a short, informative one-liner from the day's runners — replaces
// the generic "Imported from ...md — N valid runners" note.
function buildDayHeadline(runners) {
  if (!runners || runners.length === 0) return "";
  const sorted = [...runners].sort((a, b) => b.hod - a.hod);
  const top = sorted[0];
  const n = runners.length;
  const pmCount = runners.filter((r) => r.time === "premarket").length;
  const bigFadeCount = runners.filter((r) => r.fade >= 40).length;
  const heldCount = runners.filter((r) => r.fade <= 20).length;
  const withNews = runners.filter((r) => r.news && r.news.length > 0);

  const parts = [];
  parts.push(`${top.sym} led +${top.hod}% (${top.fade}% fade${top.time === "premarket" ? ", PM" : ""})`);

  if (pmCount / n > 0.5) {
    parts.push(`${pmCount}/${n} PM-dominant — distribution pattern`);
  } else if (pmCount === 0) {
    parts.push("session-led across the board");
  } else if (pmCount >= n / 3) {
    parts.push(`${pmCount}/${n} PM HODs`);
  }

  if (bigFadeCount >= Math.ceil(n / 2)) {
    parts.push(`${bigFadeCount}/${n} faded ≥40%`);
  } else if (heldCount >= Math.ceil(n / 2)) {
    parts.push(`${heldCount}/${n} held <20% — closing strong`);
  }

  if (withNews.length > 0) {
    const topNews = withNews.find((r) => r === top) || withNews[0];
    const h = topNews.news[0].replace(/\s+/g, " ").trim();
    const short = h.length > 80 ? h.slice(0, 77) + "…" : h;
    parts.push(`news: ${topNews.sym} — "${short}"`);
  }
  return parts.join(". ") + ".";
}

// Short theme label for the day header chip — describes the specific pattern,
// not a generic bucket. Combinations of HOD magnitude, PM/session split, and
// fade behavior produce different calls.
function buildDayTheme(runners, roll) {
  if (!runners || runners.length === 0 || !roll) return "";
  const n = runners.length;
  const pm = runners.filter((r) => r.time === "premarket").length;
  const pmFrac = pm / n;
  const bigFade = runners.filter((r) => r.fade >= 40).length;
  const held = runners.filter((r) => r.fade <= 20).length;
  const heldFrac = held / n;
  const bigFadeFrac = bigFade / n;
  const monster = runners.filter((r) => r.hod >= 300).length;
  const hasNews = runners.some((r) => r.news && r.news.length > 0);

  // Strongest signal wins — most specific first.
  if (pmFrac > 0.5 && bigFadeFrac >= 0.5) return "PM Distribution";
  if (pmFrac > 0.5 && roll.hod >= 200) return "PM Blow-off";
  if (pmFrac > 0.5) return "PM-Led Tape";
  if (roll.hod >= 250 && heldFrac >= 0.5) return "Session Squeeze";
  if (roll.hod >= 250 && bigFadeFrac >= 0.4) return "Fade the Rip";
  if (roll.hod >= 200 && heldFrac >= 0.5) return "Trend Day";
  if (roll.hod >= 200 && monster >= 2) return "Multi-Runner Day";
  if (roll.hod >= 200) return "Active Tape";
  if (bigFadeFrac >= 0.5) return "Heavy Distribution";
  if (heldFrac >= 0.6) return "Strong Closes";
  if (roll.hod < 80 && bigFadeFrac >= 0.3) return "Dead Tape";
  if (roll.hod < 100) return "Thin Tape";
  if (hasNews && roll.hod >= 150) return "News-Driven";
  if (roll.fade >= 40) return "Fade City";
  return "Choppy Mixed";
}

const { useState: useState_Imp, useRef: useRef_Imp } = React;

function ImportCard({ existing, onImport }) {
  const [status, setStatus] = useState_Imp(null); // {kind,msg,days}
  const [dragOver, setDragOver] = useState_Imp(false);
  const [pendingDays, setPendingDays] = useState_Imp(null); // days staged for commit
  const fileRef = useRef_Imp(null);

  const existingDates = new Set(existing.map((e) => e.date));

  const ingestFiles = async (files) => {
    const mdFiles = Array.from(files).filter((f) => /\.md$/i.test(f.name) || f.type === "text/markdown" || f.type === "text/plain");
    if (mdFiles.length === 0) {
      setStatus({ kind: "err", msg: "No .md files found. Drop a recap_*.md file from weekly_recap.py." });
      return;
    }
    const allDays = [];
    for (const f of mdFiles) {
      try {
        const text = await f.text();
        const days = parseMsfMarkdown(text);
        for (const d of days) {
          const roll = rollupDay(d.runners);
          if (!roll) continue;
          allDays.push({
            date: d.date,
            runners: d.runners,
            ...roll,
            theme: buildDayTheme(d.runners, roll),
            note: buildDayHeadline(d.runners),
          });
        }
      } catch (err) {
        console.error("parse failed", f.name, err);
      }
    }
    // Dedupe by date (keep latest file wins if multiple files contain the same day)
    const byDate = new Map();
    for (const d of allDays) byDate.set(d.date, d);
    const parsed = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));

    if (parsed.length === 0) {
      setStatus({ kind: "err", msg: "Parsed 0 valid days. Make sure the file follows the weekly_recap.py format." });
      return;
    }
    setPendingDays(parsed);
    const nNew = parsed.filter((d) => !existingDates.has(d.date)).length;
    const nOverwrite = parsed.length - nNew;
    let msg;
    if (nNew === 0 && nOverwrite > 0) {
      msg = `Parsed ${parsed.length} day${parsed.length === 1 ? "" : "s"} — already in history. Click "Import all (overwrite)" below to refresh.`;
    } else if (nOverwrite === 0) {
      msg = `Parsed ${parsed.length} day${parsed.length === 1 ? "" : "s"} · all new — ready to import below.`;
    } else {
      msg = `Parsed ${parsed.length} day${parsed.length === 1 ? "" : "s"} · ${nNew} new · ${nOverwrite} already in history.`;
    }
    setStatus({ kind: "ok", msg });
    // Scroll the preview into view so the user actually sees the action buttons.
    // Use rAF to wait for the preview DOM to render first.
    requestAnimationFrame(() => {
      const el = document.querySelector(".import-preview");
      if (el) {
        const r = el.getBoundingClientRect();
        const y = (window.pageYOffset || document.documentElement.scrollTop) + r.top - 120;
        window.scrollTo({ top: y, behavior: "smooth" });
      }
    });
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer && e.dataTransfer.files) ingestFiles(e.dataTransfer.files);
  };

  const commit = (mode) => {
    if (!pendingDays) return;
    const toApply = mode === "skip"
      ? pendingDays.filter((d) => !existingDates.has(d.date))
      : pendingDays;
    if (toApply.length === 0) {
      setStatus({ kind: "err", msg: "All parsed days are already in history. Use 'Import all (overwrite)' to refresh them." });
      return;
    }
    onImport(toApply, mode);
    setPendingDays(null);
    setStatus({ kind: "ok", msg: `Imported ${toApply.length} day${toApply.length === 1 ? "" : "s"}.` });
  };

  const cancel = () => {
    setPendingDays(null);
    setStatus(null);
  };

  return (
    <div className="import-card">
      <div className="import-head">
        <span className="label">IMPORT · MSF FILE</span>
        <span className="import-sub">drag a recap_*.md file (daily / evening / weekly) or click to pick</span>
      </div>

      <div
        className={`drop-zone ${dragOver ? "is-over" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => fileRef.current && fileRef.current.click()}
        role="button"
        tabIndex={0}
      >
        <input
          ref={fileRef}
          type="file"
          accept=".md,text/markdown,text/plain"
          multiple
          onChange={(e) => e.target.files && ingestFiles(e.target.files)}
          style={{ display: "none" }}
        />
        <div className="drop-glyph">⇣</div>
        <div className="drop-main">Drop .md files here</div>
        <div className="drop-sub">or click to browse · multiple files OK</div>
      </div>

      {status && (
        <div className={`import-status import-${status.kind}`}>
          {status.msg}
        </div>
      )}

      {pendingDays && pendingDays.length > 0 && (
        <div className="import-preview">
          <div className="import-preview-rows">
            {pendingDays.map((d) => {
              const exists = existingDates.has(d.date);
              return (
                <div key={d.date} className="import-row">
                  <span className="import-date">{d.date}</span>
                  <span className="import-stats">
                    HOD +{d.hod}% · FADE {d.fade}% · {d.hodTime.toUpperCase().slice(0, 4)} · {d.runners.length}×
                  </span>
                  <span className={`import-flag ${exists ? "flag-over" : "flag-new"}`}>
                    {exists ? "OVERWRITE" : "NEW"}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="import-actions">
            <button className="btn-primary" onClick={() => commit("overwrite")}>Import all (overwrite)</button>
            <button className="btn-secondary" onClick={() => commit("skip")}>Import new only</button>
            <button className="btn-ghost" onClick={cancel}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

Object.assign(window, { ImportCard, parseMsfMarkdown, rollupDay });
