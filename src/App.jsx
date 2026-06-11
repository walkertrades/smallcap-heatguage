// Main App — wires together gauge, rules, strip, streak.
// Data source: fetches data2.json from the same folder on load.
// Read-only view — no in-app editing, no localStorage for data.
const { useEffect: useEffect_App, useState: useState_App, useMemo: useMemo_App } = React;

const DATA_URL = "./data2.json";

function todayISO() {
  const d = new Date();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mo}-${da}`;
}

function formatDateHeader(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric" }).toUpperCase();
}

// Map runner.time values from the source schema onto the three buckets the
// scoring engine + UI expect: "session" | "premarket" | "mixed".
// Source data uses strings like "regular session", "premarket", "after hours".
function normalizeRunnerTime(raw) {
  if (!raw) return "mixed";
  const s = String(raw).toLowerCase();
  if (s.includes("pre")) return "premarket";
  if (s.includes("session") || s.includes("regular") || s.includes("rth")) return "session";
  return "mixed";
}

// Derive day-level fields (hod/fade/hodTime/theme) from a runners array.
// New schema only carries runners per day; everything else is rolled up.
function normalizeEntry(raw) {
  if (!raw || !raw.date) return null;
  const runners = Array.isArray(raw.runners) ? raw.runners.map((r) => ({
    ...r,
    time: normalizeRunnerTime(r.time),
    // Back-compat alias so calendar's `r.float` path still works.
    float: r.float != null ? r.float : r.floatM,
  })) : [];

  // Headline runner = largest HOD%
  const sortedByHod = [...runners].sort((a, b) => (b.hod || 0) - (a.hod || 0));
  const top = sortedByHod[0];

  // Day HOD / fade = AVERAGE across all runners on that day (tape-wide heat),
  // not the top runner. Always compute from runners — ignore any top-level
  // hod/fade in the source JSON (those are often leftover top-runner values).
  const numericHods = runners.map((r) => Number(r.hod)).filter((v) => Number.isFinite(v));
  const numericFades = runners.map((r) => Number(r.fade)).filter((v) => Number.isFinite(v));
  const avgHod = numericHods.length ? numericHods.reduce((s, v) => s + v, 0) / numericHods.length : null;
  const avgFade = numericFades.length ? numericFades.reduce((s, v) => s + v, 0) / numericFades.length : null;
  const hod = avgHod != null ? Math.round(avgHod) : (raw.hod != null ? raw.hod : null);
  const fade = avgFade != null ? Math.round(avgFade) : (raw.fade != null ? raw.fade : null);

  // Day hodTime: equal-weighted majority vote across runners.
  // Session if ≥ 60% session; Premarket if ≥ 50% premarket; else Mixed.
  let hodTime = raw.hodTime || null;
  if (!hodTime && runners.length) {
    const counts = { session: 0, premarket: 0, mixed: 0 };
    for (const r of runners) counts[r.time] = (counts[r.time] || 0) + 1;
    const total = counts.session + counts.premarket + counts.mixed;
    const sessShare = total ? counts.session / total : 0;
    const pmShare = total ? counts.premarket / total : 0;
    if (sessShare >= 0.6) hodTime = "session";
    else if (pmShare >= 0.5) hodTime = "premarket";
    else hodTime = "mixed";
  }

  // Theme: prefer source, else top runner's tag, else dominant sector.
  let theme = raw.theme || null;
  if (!theme && top) {
    if (top.tag) theme = top.tag.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
    else if (top.sector) theme = String(top.sector).split("-")[0].trim();
  }

  return {
    ...raw,
    runners,
    hod,
    fade,
    hodTime: hodTime || "mixed",
    theme,
    note: raw.note || null,
  };
}

function App({ tweaks }) {
  const [entries, setEntries] = useState_App([]);
  const [status, setStatus] = useState_App("loading"); // "loading" | "ready" | "empty" | "error"
  const [errorMsg, setErrorMsg] = useState_App("");
  const [selectedDate, setSelectedDate] = useState_App(null);
  const [view, setView] = useState_App("dashboard"); // "dashboard" | "calendar"

  const thresholds = useMemo_App(() => ({
    hodHot: tweaks.hodHot,
    hodNeutralLo: tweaks.hodNeutralLo,
    fadeHot: tweaks.fadeHot,
    fadeCold: tweaks.fadeCold,
  }), [tweaks]);

  // Fetch data2.json once on mount.
  useEffect_App(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(DATA_URL, { cache: "no-store" });
        // Missing file → friendly empty state, not an error
        if (res.status === 404) {
          if (cancelled) return;
          setEntries([]);
          setStatus("empty");
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = await res.text();
        // Empty file → friendly empty state
        if (!raw.trim()) {
          if (cancelled) return;
          setEntries([]);
          setStatus("empty");
          return;
        }
        let data;
        try {
          data = JSON.parse(raw);
        } catch (e) {
          throw new Error("data2.json is not valid JSON");
        }
        const list = Array.isArray(data) ? data : (data && Array.isArray(data.entries) ? data.entries : null);
        if (cancelled) return;
        // No array, or empty array → friendly empty state
        if (!list || list.length === 0) {
          setEntries([]);
          setStatus("empty");
          return;
        }
        // Normalize: derive day-level hod/fade/hodTime/theme from runners,
        // and remap runner.time values onto session/premarket/mixed.
        const normalized = list.map(normalizeEntry).filter(Boolean);
        if (normalized.length === 0) {
          setEntries([]);
          setStatus("empty");
          return;
        }
        setEntries(normalized);
        setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        setErrorMsg(err.message || String(err));
        setStatus("error");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Recompute all entries' scores whenever thresholds change
  const scoredEntries = useMemo_App(() => {
    return entries.map((e) => {
      const r = window.computeHeat(e, thresholds);
      return { ...e, score: r.score, state: r.state, isBlackSwan: r.isBlackSwan || false };
    });
  }, [entries, thresholds]);

  // Most recent entry defines today's reading
  const latest = useMemo_App(() => {
    if (scoredEntries.length === 0) return null;
    return [...scoredEntries].sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  }, [scoredEntries]);

  const streak = useMemo_App(() => window.computeStreak(scoredEntries), [scoredEntries]);

  // Directional banner — driven by the underlying signals (HOD %, fade %,
  // HOD-time mix) trending across the recent 5-day window, not just D-o-D.
  const banner = useMemo_App(() => {
    if (scoredEntries.length < 3) return null;
    const sorted = [...scoredEntries].sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first
    const window_ = sorted.slice(0, Math.min(5, sorted.length));
    const half = Math.floor(window_.length / 2);
    const newer = window_.slice(0, Math.max(1, half));
    const older = window_.slice(half);

    const avg = (arr, k) => arr.reduce((s, e) => s + (e[k] || 0), 0) / arr.length;
    const pmShare = (arr) => {
      let pm = 0, tot = 0;
      for (const e of arr) {
        if (!e.runners) continue;
        for (const r of e.runners) {
          tot++;
          if (r.time === "premarket") pm++;
        }
      }
      return tot === 0 ? null : pm / tot;
    };

    const hodOlder = avg(older, "hod");
    const hodNewer = avg(newer, "hod");
    const fadeOlder = avg(older, "fade");
    const fadeNewer = avg(newer, "fade");
    const pmOlder = pmShare(older);
    const pmNewer = pmShare(newer);

    const hodDelta = hodNewer - hodOlder;
    const fadeDelta = fadeNewer - fadeOlder;
    const pmDelta = pmOlder != null && pmNewer != null ? pmNewer - pmOlder : null;

    const signals = [];
    if (hodDelta >= 40) signals.push({ dir: 1, label: `avg HOD +${Math.round(hodDelta)}pts` });
    else if (hodDelta <= -40) signals.push({ dir: -1, label: `avg HOD ${Math.round(hodDelta)}pts` });

    if (fadeDelta <= -6) signals.push({ dir: 1, label: `fades tightened ${Math.round(-fadeDelta)}pts` });
    else if (fadeDelta >= 6) signals.push({ dir: -1, label: `fades widened +${Math.round(fadeDelta)}pts` });

    if (pmDelta != null) {
      const pct = Math.round(pmDelta * 100);
      if (pct >= 20) signals.push({ dir: -1, label: `PM share +${pct}%` });
      else if (pct <= -20) signals.push({ dir: 1, label: `PM share ${pct}%` });
    }

    // Explicit HOD-time bucket flip on most-recent day
    const latestDay = window_[0], prevDay = window_[1];
    if (prevDay && prevDay.hodTime === "session" && latestDay.hodTime === "premarket") {
      return {
        type: "shift",
        title: "HOD TIME SHIFT",
        msg: `Most recent day broke to PM-led after session-dominant tape. Distribution signature. Size down — treat PM prints as exit liquidity until session confirms.`,
      };
    }

    const windowLabel = `${window_.length}-day`;
    const hot = signals.filter((s) => s.dir === 1);
    const cold = signals.filter((s) => s.dir === -1);

    if (hot.length >= 2 && cold.length === 0) {
      return {
        type: "heating",
        title: "HEATING",
        msg: `Across the ${windowLabel}: ${hot.map((s) => s.label).join(" · ")}. Cycle turning on — ready A+ setups, session confirmation before sizing up.`,
      };
    }
    if (cold.length >= 2 && hot.length === 0) {
      return {
        type: "cooling",
        title: "COOLING",
        msg: `Across the ${windowLabel}: ${cold.map((s) => s.label).join(" · ")}. Tighten stops, no new full-size entries until the tape firms up.`,
      };
    }
    if (hot.length >= 1 && cold.length >= 1) {
      return {
        type: "mixed",
        title: "MIXED SIGNALS",
        msg: `${windowLabel} trend — hot: ${hot.map((s) => s.label).join(", ")}. Cold: ${cold.map((s) => s.label).join(", ")}. Wait for one side to confirm before sizing.`,
      };
    }
    return null;
  }, [scoredEntries]);

  const currentState = latest ? latest.state : "EMPTY";
  const rules = window.RULES[currentState];

  // Loading state
  if (status === "loading") {
    return (
      <div className="app">
        <header className="app-header">
          <div className="brand">
            <span className="brand-dot" />
            <span className="brand-name">SMALL CAP HEAT</span>
            <span className="brand-sub">· gauge</span>
          </div>
          <div className="header-meta">
            <span className="label">LOADING</span>
          </div>
        </header>
        <div className="data-status">
          <div className="label muted">FETCHING {DATA_URL}…</div>
        </div>
      </div>
    );
  }

  // Empty — file missing or has no entries. Friendly, not an error.
  if (status === "empty") {
    return (
      <div className="app">
        <header className="app-header">
          <div className="brand">
            <span className="brand-dot" />
            <span className="brand-name">SMALL CAP HEAT</span>
            <span className="brand-sub">· gauge</span>
          </div>
          <div className="header-meta">
            <span className="label">NO DATA</span>
          </div>
        </header>
        <div className="data-status data-status-empty">
          <div className="data-status-glyph">∅</div>
          <div className="data-status-title">NO DATA LOADED</div>
          <div className="data-status-hint">
            Add entries to <code>data2.json</code> next to this page and reload.
          </div>
        </div>
      </div>
    );
  }

  // Error state
  if (status === "error") {
    return (
      <div className="app">
        <header className="app-header">
          <div className="brand">
            <span className="brand-dot" />
            <span className="brand-name">SMALL CAP HEAT</span>
            <span className="brand-sub">· gauge</span>
          </div>
          <div className="header-meta">
            <span className="label">ERROR</span>
          </div>
        </header>
        <div className="data-status data-status-error">
          <div className="label">COULD NOT LOAD {DATA_URL}</div>
          <div className="data-status-msg">{errorMsg}</div>
          <div className="data-status-hint">
            Make sure <code>data2.json</code> sits next to this HTML file and is served over http(s).
            Opening the page with <code>file://</code> will block fetch — run a local server
            (e.g. <code>python3 -m http.server</code>) or deploy it.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-dot" />
          <span className="brand-name">SMALL CAP HEAT</span>
          <span className="brand-sub">· gauge</span>
        </div>
        <div className="view-switch">
          <button className={`view-btn ${view === "dashboard" ? "active" : ""}`} onClick={() => setView("dashboard")}>Dashboard</button>
          <button className={`view-btn ${view === "calendar" ? "active" : ""}`} onClick={() => setView("calendar")}>Calendar</button>
        </div>
        <div className="header-meta">
          <span className="label">{formatDateHeader(todayISO())}</span>
        </div>
      </header>

      {view === "calendar" ? (
        <window.CalendarView entries={scoredEntries} thresholds={thresholds} onDeleteRunner={null} />
      ) : (
      <>
      <section className="hero">
        <div className="hero-left">
          <Gauge score={latest ? latest.score : null} state={currentState} />
        </div>
        <div className="hero-right">
          <StateCard state={currentState} rules={rules} latest={latest} streak={streak} />
        </div>
      </section>

      {banner && (
        <div className={`warn-banner warn-${banner.type}`}>
          <span className="warn-banner-icon">
            {banner.type === "heating" ? "▲" : banner.type === "shift" ? "⚠" : banner.type === "mixed" ? "≈" : "▼"}
          </span>
          <div>
            <div className="warn-banner-title">{banner.title}</div>
            <div className="warn-banner-body">{banner.msg}</div>
          </div>
        </div>
      )}

      <Strip entries={scoredEntries} selectedDate={selectedDate} onSelect={setSelectedDate} thresholds={thresholds} onDeleteRunner={null} />

      <RulesPanel rules={rules} state={currentState} theme={latest?.theme} />

      <HistoryLog entries={scoredEntries} />
      </>
      )}

      <footer className="app-footer">
        <span>{entries.length} {entries.length === 1 ? "day" : "days"} · read-only · source: <code>{DATA_URL}</code></span>
      </footer>
    </div>
  );
}

function StateCard({ state, rules, latest, streak }) {
  const stateLower = state.toLowerCase();
  const warn = streak.state === "HOT" && streak.count >= 3;
  const pmRisk = latest && latest.hodTime === "premarket";
  const blackSwanDay = latest && latest.isBlackSwan;
  return (
    <div className={`state-card state-${stateLower}`}>
      <div className="state-card-top">
        <div>
          <div className="label muted">MARKET STATE</div>
          <div className={`state-big state-text-${stateLower}`}>{state === "EMPTY" ? "NO DATA" : state}</div>
          <div className="state-tagline">{rules.tagline}</div>
          {pmRisk && (
            <span className="pm-chip" title="Premarket-dominant HOD — distribution risk">
              ⚑ PM HOD RISK
            </span>
          )}
          {blackSwanDay && (
            <span className="pm-chip" title="Extreme tape — HOD avg 300%+ with heavy fades. Trap day risk on follow-through." style={{backgroundColor:"var(--hot-dim,#4a1a00)",color:"var(--hot,#ff6b35)",marginTop:"6px"}}>
              ⚡ EXTREME TAPE
            </span>
          )}
        </div>
        <div className="state-card-right">
          <div className="label muted">SCORE</div>
          <div className="state-score">{latest ? latest.score : "—"}</div>
        </div>
      </div>

      <div className="state-card-bottom">
        <div className="streak">
          <div className="label muted">STREAK</div>
          <div className="streak-row">
            <span className="streak-count">{streak.count || 0}</span>
            <span className="streak-unit">{streak.count === 1 ? "DAY" : "DAYS"}</span>
          </div>
          <div className="streak-dots">
            {Array.from({ length: Math.min(5, Math.max(1, streak.count || 1)) }).map((_, i) => (
              <span key={i} className={`streak-dot state-bg-${stateLower}`} />
            ))}
          </div>
        </div>
        {warn && (
          <div className="warn">
            <span className="warn-icon">⚠</span>
            <div>
              <div className="warn-title">REVERSAL RISK</div>
              <div className="warn-body">3+ consecutive HOT days. Watch for cooling.</div>
            </div>
          </div>
        )}
        {blackSwanDay && !warn && (
          <div className="warn" style={{borderColor:"var(--hot,#ff6b35)"}}>
            <span className="warn-icon">⚡</span>
            <div>
              <div className="warn-title">EXTREME TAPE</div>
              <div className="warn-body">Avg HOD 300%+ with heavy fades — watch for trap day on follow-through. Size accordingly.</div>
            </div>
          </div>
        )}
        {!warn && latest && (
          <div className="latest-stats">
            <Stat label="AVG HOD" value={`+${latest.hod}%`} verdict={latest.hod >= 150 ? "hot" : latest.hod >= 100 ? "neutral" : "cold"} />
            <Stat label="TIME" value={latest.hodTime === "premarket" ? "PM" : latest.hodTime === "mixed" ? "MIX" : "SESS"} verdict={latest.hodTime === "session" ? "hot" : latest.hodTime === "premarket" ? "cold" : "neutral"} />
            <Stat label="AVG FADE" value={`${latest.fade}%`} verdict={latest.fade <= 25 ? "hot" : latest.fade <= 40 ? "neutral" : "cold"} />
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, verdict }) {
  return (
    <div className={`stat stat-${verdict || "neutral"}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-val">{value}</div>
      <div className="stat-bar" />
    </div>
  );
}

function RulesPanel({ rules, state, theme }) {
  const stateLower = state.toLowerCase();
  return (
    <div className={`rules-card state-${stateLower}`}>
      <div className="rules-header">
        <span className={`rules-tag state-bg-${stateLower}`}>{rules.label}</span>
        <span className="label muted">TODAY'S PLAYBOOK</span>
        {theme && <span className="theme-chip">{theme}</span>}
      </div>
      <ul className="rules-list">
        {rules.bullets.map((b, i) => (
          <li key={i}>
            <span className={`bullet state-text-${stateLower}`}>▸</span>
            <span>{b}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function HistoryLog({ entries }) {
  const sorted = [...entries].sort((a, b) => (a.date < b.date ? 1 : -1));
  if (sorted.length === 0) return null;
  return (
    <div className="history">
      <div className="history-header">
        <span className="label">LOG · {sorted.length} {sorted.length === 1 ? "ENTRY" : "ENTRIES"}</span>
      </div>
      <div className="history-rows">
        {sorted.map((e) => (
          <div key={e.date} className="history-row">
            <span className="history-date">{e.date}</span>
            <span className={`history-state state-text-${e.state.toLowerCase()}`}>{e.state}</span>
            <span className="history-score">{e.score}</span>
            <span className="history-meta">avg HOD {e.hod}% · {e.hodTime.slice(0, 4).toUpperCase()} · avg FADE {e.fade}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

Object.assign(window, { App });
