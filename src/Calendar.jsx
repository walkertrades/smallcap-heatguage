// Monthly calendar heatmap — shows historical market state cycles.
// Cells colored by state (HOT/NEUTRAL/COLD); click to open the shared day detail.

const { useState: useState_Cal, useMemo: useMemo_Cal } = React;

const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DOW_LABELS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

// Aggregate a week's trading days into a themes summary.
function buildWeekSummary(days) {
  const counts = { HOT: 0, NEUTRAL: 0, COLD: 0 };
  for (const d of days) counts[d.state] = (counts[d.state] || 0) + 1;

  const allRunners = days.flatMap((d) => d.runners || []);
  const n = allRunners.length;
  const avgHod = n ? allRunners.reduce((s, r) => s + r.hod, 0) / n : 0;
  const avgFade = n ? allRunners.reduce((s, r) => s + r.fade, 0) / n : 0;
  const pmCount = allRunners.filter((r) => r.time === "premarket").length;
  const pmFrac = n ? pmCount / n : 0;

  // Mode helper — returns [{key,count}, ...] top-k
  const mode = (arr, k = 2) => {
    const m = new Map();
    for (const v of arr) if (v) m.set(v, (m.get(v) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([key, count]) => ({ key, count }));
  };
  const sectors = mode(allRunners.map((r) => r.sector).filter(Boolean));
  const countries = mode(allRunners.map((r) => r.country).filter(Boolean));

  // Price range
  const prices = allRunners.map((r) => r.close || r.open || r.vwap).filter((p) => p && p > 0);
  const priceLo = prices.length ? Math.min(...prices) : null;
  const priceHi = prices.length ? Math.max(...prices) : null;

  // Float range (in millions)
  const floats = allRunners.map((r) => r.float).filter((f) => f != null);
  const floatLo = floats.length ? Math.min(...floats) : null;
  const floatHi = floats.length ? Math.max(...floats) : null;

  // News themes — extract keywords from headlines
  const allNews = allRunners.flatMap((r) => r.news || []);
  const newsTheme = extractNewsTheme(allNews);

  // Top runner of the week
  const topRunner = [...allRunners].sort((a, b) => b.hod - a.hod)[0];

  // Overall tape call
  let heat;
  if (counts.HOT >= 3) heat = "HOT WEEK";
  else if (counts.COLD >= 3) heat = "COLD WEEK";
  else if (counts.HOT > counts.COLD) heat = "WARM";
  else if (counts.COLD > counts.HOT) heat = "COOLING";
  else heat = "MIXED";

  return {
    heat,
    counts,
    days: days.length,
    avgHod: Math.round(avgHod),
    avgFade: Math.round(avgFade),
    pmFrac,
    sectors,
    countries,
    priceLo, priceHi,
    floatLo, floatHi,
    newsTheme,
    topRunner,
  };
}

// Surface the dominant news theme from a pile of headlines.
function extractNewsTheme(headlines) {
  if (!headlines || headlines.length === 0) return null;
  const text = headlines.join(" ").toLowerCase();
  const themes = [
    { key: "AI/Tech Pivot",    rx: /\b(ai|artificial intelligence|machine learning|pivot)\b/ },
    { key: "Crypto/Blockchain", rx: /\b(crypto|bitcoin|blockchain|ethereum|token)\b/ },
    { key: "Biotech/FDA",       rx: /\b(fda|clinical|trial|phase [123]|approval|biotech|drug|therapy)\b/ },
    { key: "Earnings",          rx: /\b(earnings|revenue|quarter|q[1-4] |beats|guidance)\b/ },
    { key: "M&A/Buyout",        rx: /\b(acquisition|acquire|merger|buyout|takeover|deal)\b/ },
    { key: "Offering/Dilution", rx: /\b(offering|dilution|pricing|registered direct|atm|equity line)\b/ },
    { key: "Reverse Split",     rx: /\breverse (stock )?split\b/ },
    { key: "Short Squeeze",     rx: /\b(squeeze|short interest|borrow|float rotated)\b/ },
    { key: "Regulatory/DOJ",    rx: /\b(sec |doj|lawsuit|probe|investigation|subpoena)\b/ },
    { key: "China Small-Cap",   rx: /\b(china|chinese|ipo|shanghai|shenzhen|hong kong)\b/ },
    { key: "Partnership/Deal",  rx: /\b(partnership|agreement|contract|collaborat)\b/ },
    { key: "EV/Clean Energy",   rx: /\b(ev|electric vehicle|solar|lithium|battery|clean energy)\b/ },
  ];
  const hits = themes.map((t) => ({ key: t.key, count: (text.match(new RegExp(t.rx.source, "gi")) || []).length })).filter((h) => h.count > 0).sort((a, b) => b.count - a.count);
  return hits.slice(0, 2);
}

function CalendarView({ entries, thresholds, onDeleteRunner }) {
  // Default to month of the most-recent entry, else current month.
  const defaultCursor = useMemo_Cal(() => {
    if (entries.length > 0) {
      const iso = [...entries].sort((a, b) => (a.date < b.date ? 1 : -1))[0].date;
      const [y, m] = iso.split("-").map(Number);
      return { year: y, month: m - 1 };
    }
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  }, [entries.length]);

  const [cursor, setCursor] = useState_Cal(defaultCursor);
  const [selectedDate, setSelectedDate] = useState_Cal(null);
  const [selectedWeek, setSelectedWeek] = useState_Cal(null); // { weekIdx, summary, days }

  const byDate = useMemo_Cal(() => {
    const m = new Map();
    for (const e of entries) m.set(e.date, e);
    return m;
  }, [entries]);

  const { year, month } = cursor;
  const firstOfMonth = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const startDow = firstOfMonth.getDay(); // 0=Sun

  // Build 6-week grid with weekly summaries keyed to Saturday cells.
  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    cells.push({ day: d, iso, entry: byDate.get(iso) });
  }
  while (cells.length % 7 !== 0) cells.push(null);

  // For each Saturday position (index 6, 13, 20, 27, 34), compute a week summary
  // from that row's Mon-Fri cells. Attach to the Saturday cell.
  const weekSummaries = [];
  const weekDays = [];
  for (let rowStart = 0; rowStart < cells.length; rowStart += 7) {
    const row = cells.slice(rowStart, rowStart + 7);
    const tradingDays = row.slice(1, 6).filter((c) => c && c.entry).map((c) => c.entry);
    weekSummaries.push(tradingDays.length > 0 ? buildWeekSummary(tradingDays) : null);
    weekDays.push(tradingDays);
  }

  const prevMonth = () => {
    const m = month - 1;
    if (m < 0) setCursor({ year: year - 1, month: 11 });
    else setCursor({ year, month: m });
    setSelectedDate(null);
  };
  const nextMonth = () => {
    const m = month + 1;
    if (m > 11) setCursor({ year: year + 1, month: 0 });
    else setCursor({ year, month: m });
    setSelectedDate(null);
  };

  const selectedEntry = selectedDate ? byDate.get(selectedDate) : null;

  // Quick stats for this month
  const monthEntries = entries.filter((e) => {
    const [y, m] = e.date.split("-").map(Number);
    return y === year && m === month + 1;
  });
  const counts = { HOT: 0, NEUTRAL: 0, COLD: 0 };
  for (const e of monthEntries) counts[e.state] = (counts[e.state] || 0) + 1;

  return (
    <div className="calendar-view">
      <div className="cal-header">
        <div className="cal-title-row">
          <span className="label">CALENDAR · MARKET CYCLES</span>
          <span className="cal-month">{MONTH_NAMES[month]} {year}</span>
        </div>
        <div className="cal-nav">
          <button className="cal-nav-btn" onClick={prevMonth} aria-label="Previous month">‹</button>
          <button className="cal-nav-btn" onClick={() => { setCursor(defaultCursor); setSelectedDate(null); }}>today</button>
          <button className="cal-nav-btn" onClick={nextMonth} aria-label="Next month">›</button>
        </div>
      </div>

      <div className="cal-legend">
        <span className="cal-legend-item"><span className="cal-swatch swatch-cold" />cold</span>
        <span className="cal-legend-item"><span className="cal-swatch swatch-neutral" />neutral</span>
        <span className="cal-legend-item"><span className="cal-swatch swatch-hot" />hot</span>
        {monthEntries.length > 0 && (
          <span className="cal-legend-stats">
            {counts.HOT}h · {counts.NEUTRAL}n · {counts.COLD}c
          </span>
        )}
      </div>

      <div className="cal-grid-head">
        {DOW_LABELS.map((d) => (
          <span key={d} className="cal-dow">{d}</span>
        ))}
      </div>

      <div className="cal-grid">
        {cells.map((c, i) => {
          const dowIdx = i % 7;
          const weekIdx = Math.floor(i / 7);
          const summary = dowIdx === 6 ? weekSummaries[weekIdx] : null;

          // Saturday with a week summary — render the summary card instead of blank
          if (dowIdx === 6 && summary) {
            const isSelected = selectedWeek && selectedWeek.weekIdx === weekIdx;
            return (
              <div
                key={i}
                className={`cal-cell cal-summary heat-${summary.heat.split(" ")[0].toLowerCase()} ${isSelected ? "is-selected" : ""}`}
                onClick={() => {
                  setSelectedDate(null);
                  setSelectedWeek(isSelected ? null : { weekIdx, summary, days: weekDays[weekIdx] });
                }}
                role="button"
                tabIndex={0}
              >
                <div className="cal-sum-head">
                  <span className="cal-sum-heat">{summary.heat}</span>
                  <span className="cal-sum-days">{summary.days}d</span>
                </div>
                <div className="cal-sum-stats">
                  <span className="cal-sum-stat">
                    <span className="cal-sum-val">+{summary.avgHod}%</span>
                    <span className="cal-sum-lbl">avg HOD</span>
                  </span>
                  <span className="cal-sum-stat">
                    <span className="cal-sum-val">{summary.avgFade}%</span>
                    <span className="cal-sum-lbl">avg fade</span>
                  </span>
                  <span className="cal-sum-stat">
                    <span className="cal-sum-val">{Math.round(summary.pmFrac * 100)}%</span>
                    <span className="cal-sum-lbl">PM share</span>
                  </span>
                </div>
                <div className="cal-sum-themes">
                  {summary.sectors.length > 0 && (
                    <div className="cal-sum-line">
                      <span className="cal-sum-tag">sectors</span>
                      <span>{summary.sectors.map((s) => s.key).join(", ")}</span>
                    </div>
                  )}
                  {summary.countries.length > 0 && (
                    <div className="cal-sum-line">
                      <span className="cal-sum-tag">country</span>
                      <span>{summary.countries.map((c) => c.key).join(", ")}</span>
                    </div>
                  )}
                  {summary.priceLo != null && (
                    <div className="cal-sum-line">
                      <span className="cal-sum-tag">price</span>
                      <span>${summary.priceLo.toFixed(2)}–${summary.priceHi.toFixed(2)}</span>
                    </div>
                  )}
                  {summary.floatLo != null && (
                    <div className="cal-sum-line">
                      <span className="cal-sum-tag">float</span>
                      <span>{summary.floatLo.toFixed(1)}M–{summary.floatHi.toFixed(1)}M</span>
                    </div>
                  )}
                  {summary.newsTheme && summary.newsTheme.length > 0 && (
                    <div className="cal-sum-line">
                      <span className="cal-sum-tag">news</span>
                      <span>{summary.newsTheme.map((n) => n.key).join(" · ")}</span>
                    </div>
                  )}
                  {summary.topRunner && (
                    <div className="cal-sum-line cal-sum-top">
                      <span className="cal-sum-tag">top</span>
                      <span><strong>{summary.topRunner.sym}</strong> +{summary.topRunner.hod}%</span>
                    </div>
                  )}
                </div>
              </div>
            );
          }

          if (!c) return <div key={i} className="cal-cell cal-empty" />;
          const e = c.entry;
          const isSelected = c.iso === selectedDate;
          const top = e ? [...(e.runners || [])].sort((a, b) => b.hod - a.hod).slice(0, 3) : [];
          return (
            <div
              key={i}
              className={`cal-cell ${e ? `cal-filled cal-${e.state.toLowerCase()}` : "cal-blank"} ${isSelected ? "is-selected" : ""}`}
              onClick={() => {
                if (!e) return;
                setSelectedWeek(null);
                setSelectedDate(isSelected ? null : c.iso);
              }}
              role={e ? "button" : undefined}
              tabIndex={e ? 0 : -1}
            >
              <div className="cal-cell-head">
                <span className="cal-day">{c.day}</span>
                {e && <span className="cal-score">{e.score}</span>}
              </div>
              {e ? (
                <>
                  <div className={`cal-state state-text-${e.state.toLowerCase()}`}>{e.state}</div>
                  <ul className="cal-runners">
                    {top.map((r) => (
                      <li key={r.sym}>
                        <span className="cal-run-sym">{r.sym}</span>
                        <span className="cal-run-hod">+{r.hod}%</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <div className="cal-placeholder">—</div>
              )}
            </div>
          );
        })}
      </div>

      {selectedEntry && (
        <window.DayDetailInline
          entry={selectedEntry}
          thresholds={thresholds}
          onClose={() => setSelectedDate(null)}
          onDeleteRunner={onDeleteRunner}
        />
      )}

      {selectedWeek && (
        <WeekDetail
          summary={selectedWeek.summary}
          days={selectedWeek.days}
          onClose={() => setSelectedWeek(null)}
          onJumpToDay={(iso) => {
            setSelectedWeek(null);
            setSelectedDate(iso);
          }}
        />
      )}
    </div>
  );
}

function WeekDetail({ summary, days, onClose, onJumpToDay }) {
  const sorted = [...days].sort((a, b) => (a.date < b.date ? -1 : 1));
  const first = sorted[0], last = sorted[sorted.length - 1];
  const fmt = (iso) => {
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };
  const fmtLong = (iso) => {
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  };
  const weekRange = first && last ? `${fmt(first.date)} – ${fmt(last.date)}` : "";

  // Week heat maps to a state tone for header coloring
  const heatKey = summary.heat.split(" ")[0].toLowerCase(); // hot|cold|warm|cooling|mixed
  const stateMap = { hot: "hot", cold: "cold", warm: "neutral", cooling: "cold", mixed: "neutral" };
  const stateLower = stateMap[heatKey] || "neutral";

  // Factor-style grid (3 factors — one per underlying signal)
  const factors = [];
  if (summary.avgHod >= 200) {
    factors.push({ kind: "pos", label: "AVG HOD", detail: `+${summary.avgHod}% (≥200%)`, tag: "HOT" });
  } else if (summary.avgHod >= 100) {
    factors.push({ kind: "mid", label: "AVG HOD", detail: `+${summary.avgHod}% (100–200%)`, tag: "NEUTRAL" });
  } else {
    factors.push({ kind: "neg", label: "AVG HOD", detail: `+${summary.avgHod}% (<100%)`, tag: "COLD" });
  }
  if (summary.avgFade <= 25) {
    factors.push({ kind: "pos", label: "AVG FADE", detail: `${summary.avgFade}% (≤25%)`, tag: "HOT" });
  } else if (summary.avgFade <= 45) {
    factors.push({ kind: "mid", label: "AVG FADE", detail: `${summary.avgFade}% (25–45%)`, tag: "NEUTRAL" });
  } else {
    factors.push({ kind: "neg", label: "AVG FADE", detail: `${summary.avgFade}% (>45%)`, tag: "COLD" });
  }
  const pmPct = Math.round(summary.pmFrac * 100);
  if (pmPct <= 25) {
    factors.push({ kind: "pos", label: "PM SHARE", detail: `${pmPct}% session-led`, tag: "HOT" });
  } else if (pmPct <= 50) {
    factors.push({ kind: "mid", label: "PM SHARE", detail: `${pmPct}% mixed`, tag: "NEUTRAL" });
  } else {
    factors.push({ kind: "neg", label: "PM SHARE", detail: `${pmPct}% PM-dominant`, tag: "COLD" });
  }

  // One-liner summary
  const noteParts = [];
  noteParts.push(`${summary.days}-day window averaged +${summary.avgHod}% HOD with ${summary.avgFade}% fade`);
  if (summary.topRunner) noteParts.push(`${summary.topRunner.sym} led +${summary.topRunner.hod}%`);
  if (summary.sectors.length > 0) noteParts.push(`${summary.sectors[0].key.toLowerCase()} heavy`);
  if (summary.countries.length > 0 && summary.countries[0].count >= 3) noteParts.push(`${summary.countries[0].key} dominant`);
  const summaryNote = noteParts.join(" · ") + ".";

  // All runners for top 10 table
  const allRunners = sorted.flatMap((d) => (d.runners || []).map((r) => ({ ...r, _date: d.date })));
  const topMovers = [...allRunners].sort((a, b) => b.hod - a.hod).slice(0, 10);

  return (
    <div className={`detail state-${stateLower}`}>
      <div className="detail-header">
        <div className="detail-header-left">
          <div className="label muted">WEEK · {weekRange}</div>
          <div className="detail-title-row">
            <span className={`detail-state state-text-${stateLower}`}>{summary.heat}</span>
            <span className="detail-divider">·</span>
            <span className="detail-score">{summary.counts.HOT}H · {summary.counts.NEUTRAL}N · {summary.counts.COLD}C</span>
            <span className="detail-theme">{summary.days} day{summary.days !== 1 ? "s" : ""}</span>
          </div>
        </div>
        <button className="detail-close" onClick={onClose} aria-label="Close">×</button>
      </div>

      <div className="detail-summary">
        <span className="detail-summary-icon">✱</span>
        <p>{summaryNote}</p>
      </div>

      <div className="factor-grid">
        {factors.map((f, i) => (
          <div key={i} className={`factor factor-${f.kind}`}>
            <div className="factor-head">
              <span className="factor-label">{f.label}</span>
              <span className={`factor-tag tag-${f.tag.toLowerCase()}`}>{f.tag}</span>
            </div>
            <div className="factor-detail">{f.detail}</div>
          </div>
        ))}
      </div>

      {/* Themes block — sectors / country / news / ranges */}
      <div className="week-themes-clean">
        {summary.sectors.length > 0 && (
          <div className="week-theme-row">
            <span className="week-theme-label">SECTORS</span>
            <div className="week-theme-chips">
              {summary.sectors.map((s) => (
                <span key={s.key} className="theme-chip">{s.key} <span className="theme-chip-n">×{s.count}</span></span>
              ))}
            </div>
          </div>
        )}
        {summary.countries.length > 0 && (
          <div className="week-theme-row">
            <span className="week-theme-label">COUNTRY</span>
            <div className="week-theme-chips">
              {summary.countries.map((c) => (
                <span key={c.key} className="theme-chip">{c.key} <span className="theme-chip-n">×{c.count}</span></span>
              ))}
            </div>
          </div>
        )}
        {summary.newsTheme && summary.newsTheme.length > 0 && (
          <div className="week-theme-row">
            <span className="week-theme-label">NEWS</span>
            <div className="week-theme-chips">
              {summary.newsTheme.map((n) => (
                <span key={n.key} className="theme-chip">{n.key} <span className="theme-chip-n">×{n.count}</span></span>
              ))}
            </div>
          </div>
        )}
        {summary.priceLo != null && (
          <div className="week-theme-row">
            <span className="week-theme-label">PRICE</span>
            <span className="week-theme-val">${summary.priceLo.toFixed(2)} – ${summary.priceHi.toFixed(2)}</span>
          </div>
        )}
        {summary.floatLo != null && (
          <div className="week-theme-row">
            <span className="week-theme-label">FLOAT</span>
            <span className="week-theme-val">{summary.floatLo.toFixed(1)}M – {summary.floatHi.toFixed(1)}M</span>
          </div>
        )}
      </div>

      {/* Days in week — same visual rhythm as runners table */}
      <div className="runners">
        <div className="runners-label label">DAYS IN WEEK</div>
        <div className="runners-grid runners-grid-5col">
          <div className="runners-head">
            <span>DATE</span>
            <span>STATE</span>
            <span>SCORE</span>
            <span>HOD</span>
            <span>FADE</span>
          </div>
          {sorted.map((d) => {
            const sl = d.state.toLowerCase();
            return (
              <div
                key={d.date}
                className="runner-row runner-row-click"
                onClick={() => onJumpToDay(d.date)}
                role="button"
                tabIndex={0}
              >
                <span className="runner-sym">{fmt(d.date)}</span>
                <span className={`state-text-${sl}`} style={{ fontWeight: 700, letterSpacing: "0.08em" }}>{d.state}</span>
                <span className="runner-hod">{d.score}</span>
                <span className="runner-hod">+{d.hod}%</span>
                <span className="runner-fade">{d.fade}%</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Top 10 runners of the week */}
      {topMovers.length > 0 && (
        <div className="runners">
          <div className="runners-label label">TOP 10 RUNNERS · WEEK</div>
          <div className="runners-grid runners-grid-5col">
            <div className="runners-head">
              <span>TICKER</span>
              <span>DATE</span>
              <span>HOD</span>
              <span>FADE</span>
              <span>SESSION</span>
            </div>
            {topMovers.map((r) => (
              <div key={`${r._date}-${r.sym}`} className="runner-row">
                <span className="runner-sym">{r.sym}</span>
                <span className="runner-date">{fmt(r._date)}</span>
                <span className="runner-hod">+{r.hod}%</span>
                <span className="runner-fade">{r.fade}%</span>
                <span className={`runner-time time-${r.time}`}>{r.time}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

Object.assign(window, { CalendarView });