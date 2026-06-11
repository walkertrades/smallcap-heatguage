// Inline day-detail panel, rendered inside the strip card under the cells.
// Cleaner and more readable than the modal version.

function DayDetailInline({ entry, thresholds, onClose, onDeleteRunner }) {
  if (!entry) return null;
  const stateLower = entry.state.toLowerCase();
  const runners = entry.runners || [];
  const sorted = [...runners].sort((a, b) => b.hod - a.hod);

  // Reasoning bullets — three factor calls with pos/mid/neg signals
  const factors = [];
  if (entry.hod >= thresholds.hodHot) {
    factors.push({ kind: "pos", label: "AVG HOD", detail: `+${entry.hod}% ≥ ${thresholds.hodHot}%`, tag: "HOT" });
  } else if (entry.hod >= thresholds.hodNeutralLo) {
    factors.push({ kind: "mid", label: "AVG HOD", detail: `+${entry.hod}% (${thresholds.hodNeutralLo}–${thresholds.hodHot}%)`, tag: "NEUTRAL" });
  } else {
    factors.push({ kind: "neg", label: "AVG HOD", detail: `+${entry.hod}% < ${thresholds.hodNeutralLo}%`, tag: "COLD" });
  }
  if (entry.fade <= thresholds.fadeHot) {
    factors.push({ kind: "pos", label: "AVG FADE", detail: `${entry.fade}% ≤ ${thresholds.fadeHot}%`, tag: "HOT" });
  } else if (entry.fade <= thresholds.fadeCold) {
    factors.push({ kind: "mid", label: "AVG FADE", detail: `${entry.fade}% (${thresholds.fadeHot}–${thresholds.fadeCold}%)`, tag: "NEUTRAL" });
  } else {
    factors.push({ kind: "neg", label: "AVG FADE", detail: `${entry.fade}% > ${thresholds.fadeCold}%`, tag: "COLD" });
  }
  const timeLabel = entry.hodTime === "session" ? "SESSION" : entry.hodTime === "premarket" ? "PREMARKET" : "MIXED";
  const timeKind = entry.hodTime === "session" ? "pos" : entry.hodTime === "premarket" ? "neg" : "mid";
  const timeTag = entry.hodTime === "session" ? "HOT" : entry.hodTime === "premarket" ? "COLD" : "NEUTRAL";
  factors.push({ kind: timeKind, label: "TIME · MAJORITY", detail: timeLabel, tag: timeTag });

  // PM risk flag — shown when premarket-dominant regardless of state
  const pmFlag = entry.hodTime === "premarket";

  // Heavy fade risk flag — shown when avg fade > 40% regardless of HOD
  const fadeFlag = entry.fade > 40;
  const extremeFade = entry.fade > 55;

  const fmtDate = (iso) => {
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  };

  return (
    <div className={`detail state-${stateLower}`}>
      <div className="detail-header">
        <div className="detail-header-left">
          <div className="label muted">{fmtDate(entry.date)}</div>
          <div className="detail-title-row">
            <span className={`detail-state state-text-${stateLower}`}>{entry.state}</span>
            <span className="detail-divider">·</span>
            <span className="detail-score">{entry.score}</span>
            {entry.theme && <span className="detail-theme">{entry.theme}</span>}
          </div>
        </div>
        <button className="detail-close" onClick={onClose} aria-label="Close">×</button>
      </div>

      {entry.note && (
        <div className="detail-summary">
          <span className="detail-summary-icon">✱</span>
          <p>{entry.note}</p>
        </div>
      )}

      {pmFlag && (
        <div className="pm-flag">
          <span className="pm-flag-icon">⚑</span>
          <div>
            <div className="pm-flag-title">PREMARKET HOD RISK</div>
            <div className="pm-flag-body">
              Dominant HOD hit before 9:30 — classic distribution pattern. State is {entry.state} from HOD/fade, but size down and treat PM prints as exit liquidity, not entries.
            </div>
          </div>
        </div>
      )}

      {fadeFlag && (
        <div className="pm-flag" style={{background: extremeFade ? "oklch(0.22 0.08 0)" : "oklch(0.22 0.06 25)", borderColor: extremeFade ? "oklch(0.55 0.18 0)" : "oklch(0.55 0.14 25)"}}>
          <span className="pm-flag-icon" style={{color: extremeFade ? "oklch(0.75 0.2 0)" : "oklch(0.80 0.18 30)"}}>⚡</span>
          <div>
            <div className="pm-flag-title" style={{color: extremeFade ? "oklch(0.80 0.18 0)" : "oklch(0.85 0.15 30)"}}>
              {extremeFade ? "EXTREME FADE RISK" : "HEAVY FADE TAPE"}
            </div>
            <div className="pm-flag-body">
              {extremeFade
                ? `Avg fade ${entry.fade}% — names gave back most of their move. Classic trap day pattern. Follow-through next session is high risk — size way down and wait for confirmation.`
                : `Avg fade ${entry.fade}% exceeds the cold threshold. Moves ran but didn't hold — take profits early and avoid chasing HOD breaks.`
              }
            </div>
          </div>
        </div>
      )}

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

      {sorted.length > 0 && (
        <RunnersBlock runners={sorted} thresholds={thresholds} entry={entry} onDeleteRunner={onDeleteRunner} />
      )}
    </div>
  );
}

Object.assign(window, { DayDetailInline });

function RunnersBlock({ runners, thresholds, entry, onDeleteRunner }) {
  const [advanced, setAdvanced] = React.useState(false);
  const [expandedSym, setExpandedSym] = React.useState(null);

  const toggleExpand = (sym) => setExpandedSym((prev) => (prev === sym ? null : sym));

  return (
    <div className="runners">
      <div className="runners-head-row">
        <div className="runners-label label">TOP MOVERS · {runners.length}</div>
        <div className="adv-toggle" role="group" aria-label="Detail level">
          <button
            className={`adv-btn ${!advanced ? "active" : ""}`}
            onClick={() => setAdvanced(false)}
            type="button"
          >BASIC</button>
          <button
            className={`adv-btn ${advanced ? "active" : ""}`}
            onClick={() => setAdvanced(true)}
            type="button"
          >ADVANCED</button>
        </div>
      </div>

      {!advanced ? (
        <div className="runners-grid">
          <div className="runners-head">
            <span>TICKER</span>
            <span className="num">HOD</span>
            <span className="num">FADE</span>
            <span className="num">TIME</span>
            <span />
          </div>
          {runners.map((r) => {
            const isExpanded = expandedSym === r.sym;
            return (
              <React.Fragment key={r.sym}>
                <div
                  className={`runners-row runner-row-click ${isExpanded ? "is-expanded" : ""}`}
                  onClick={() => toggleExpand(r.sym)}
                  role="button"
                  tabIndex={0}
                >
                  <span className="runner-sym">
                    <span className="runner-chev" aria-hidden="true">{isExpanded ? "▾" : "▸"}</span> {r.sym}
                  </span>
                  <span className="num runner-hod">+{r.hod}%</span>
                  <span className={`num runner-fade ${r.fade > thresholds.fadeCold ? "fade-bad" : r.fade < thresholds.fadeHot ? "fade-good" : "fade-mid"}`}>
                    {r.fade}%
                  </span>
                  <span className={`num runner-time time-${r.time}`}>
                    {r.time === "premarket" ? "PM" : r.time === "session" ? "SESS" : "MIX"}
                  </span>
                  {onDeleteRunner && (
                    <button
                      className="runner-delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`Remove ${r.sym} from ${entry.date}?`)) {
                          onDeleteRunner(entry.date, r.sym);
                        }
                      }}
                      aria-label={`Remove ${r.sym}`}
                      title={`Remove ${r.sym}`}
                    >×</button>
                  )}
                </div>
                {isExpanded && (
                  <div className="runner-tile-wrap">
                    <RunnerTile r={r} />
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>
      ) : (
        <AdvancedRunnersTable runners={runners} thresholds={thresholds} entry={entry} onDeleteRunner={onDeleteRunner} expandedSym={expandedSym} onToggleExpand={toggleExpand} />
      )}
    </div>
  );
}

function AdvancedRunnersTable({ runners, thresholds, entry, onDeleteRunner, expandedSym, onToggleExpand }) {
  return (
    <div className="adv-table-wrap">
      <table className="adv-table">
        <thead>
          <tr>
            <th className="sticky-col">TICKER</th>
            <th>NAME</th>
            <th>SECTOR</th>
            <th className="num">CTRY</th>
            <th className="num">FLOAT</th>
            <th className="num">MKT CAP</th>
            <th className="num">HOD %</th>
            <th className="num">HOD TIME</th>
            <th className="num">FADE %</th>
            <th className="num">GAP %</th>
            <th className="num">OPEN</th>
            <th className="num">HIGH</th>
            <th className="num">CLOSE</th>
            <th className="num">VWAP</th>
            <th className="num">PM HIGH</th>
            <th className="num">RELVOL</th>
            <th>NEWS</th>
            <th className="num">SESSION</th>
            {onDeleteRunner && <th />}
          </tr>
        </thead>
        <tbody>
          {runners.map((r) => {
            const fadeClass = r.fade > thresholds.fadeCold ? "fade-bad" : r.fade < thresholds.fadeHot ? "fade-good" : "fade-mid";
            const isExpanded = expandedSym === r.sym;
            const colCount = 18 + (onDeleteRunner ? 1 : 0);
            return (
              <React.Fragment key={r.sym}>
                <tr
                  className={`adv-row-click ${isExpanded ? "is-expanded" : ""}`}
                  onClick={() => onToggleExpand && onToggleExpand(r.sym)}
                >
                  <td className="sticky-col adv-t-sym">
                    <span className="runner-chev" aria-hidden="true">{isExpanded ? "▾" : "▸"}</span> {r.sym}
                  </td>
                  <td className="adv-t-name" title={r.name || ""}>{r.name || "—"}</td>
                  <td>{r.sector || "—"}</td>
                  <td className="num">{r.country || "—"}</td>
                  <td className="num">{r.floatM != null ? `${r.floatM}M` : "—"}</td>
                  <td className="num">{r.marketCap || "—"}</td>
                  <td className="num runner-hod">+{r.hodExact != null ? r.hodExact.toFixed(1) : r.hod}%</td>
                  <td className="num adv-t-timeex">{r.hodTimeExact || "—"}</td>
                  <td className={`num ${fadeClass}`}>{r.fade != null ? `${r.fade}%` : "—"}</td>
                  <td className="num">{r.gapPct != null ? `${r.gapPct > 0 ? "+" : ""}${r.gapPct}%` : "—"}</td>
                  <td className="num">{r.open != null ? `$${fmt(r.open)}` : "—"}</td>
                  <td className="num">{r.high != null ? `$${fmt(r.high)}` : "—"}</td>
                  <td className="num">
                    {r.close != null ? `$${fmt(r.close)}` : "—"}
                    {r.vsVwap && <span className="adv-t-sub"> {r.vsVwap === "above" ? "▲" : "▼"}</span>}
                  </td>
                  <td className="num">{r.vwap != null ? `$${fmt(r.vwap)}` : "—"}</td>
                  <td className="num">{r.pmHigh != null ? `$${fmt(r.pmHigh)}` : "—"}</td>
                  <td className="num">{r.relVol != null ? `${r.relVol}×` : "—"}</td>
                  <td className="adv-t-news">
                    {r.news && r.news.length > 0 ? (
                      <span className="adv-t-news-chip" title={r.news.join(" • ")}>
                        <span className="adv-t-news-dot" /> {r.news.length} {r.news[0]}
                      </span>
                    ) : (
                      <span className="adv-t-none">—</span>
                    )}
                  </td>
                  <td className={`num runner-time time-${r.time}`}>
                    {r.time === "premarket" ? "PM" : r.time === "session" ? "SESS" : "MIX"}
                  </td>
                  {onDeleteRunner && (
                    <td>
                      <button
                        className="runner-delete"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`Remove ${r.sym} from ${entry.date}?`)) onDeleteRunner(entry.date, r.sym);
                        }}
                        aria-label={`Remove ${r.sym}`}
                      >×</button>
                    </td>
                  )}
                </tr>
                {isExpanded && (
                  <tr className="adv-tile-row">
                    <td colSpan={colCount}>
                      <RunnerTile r={r} />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AdvancedRunnerCard({ r, thresholds, entry, onDelete }) {
  const fadeClass = r.fade > thresholds.fadeCold ? "fade-bad" : r.fade < thresholds.fadeHot ? "fade-good" : "fade-mid";
  const stats = [
    r.prevClose != null && { k: "PREV CLOSE", v: `$${fmt(r.prevClose)}` },
    r.open != null && { k: "OPEN", v: `$${fmt(r.open)}`, sub: r.gapPct != null ? `${r.gapPct > 0 ? "+" : ""}${r.gapPct}% gap` : null },
    r.high != null && { k: "HOD", v: `$${fmt(r.high)}`, sub: r.hodTimeExact || null },
    r.low != null && { k: "LOW", v: `$${fmt(r.low)}` },
    r.close != null && { k: "CLOSE", v: `$${fmt(r.close)}`, sub: r.vsVwap ? `${r.vsVwap} VWAP` : null },
    r.vwap != null && { k: "VWAP", v: `$${fmt(r.vwap)}` },
    r.pmHigh != null && { k: "PM HIGH", v: `$${fmt(r.pmHigh)}` },
    r.relVol != null && { k: "RELVOL", v: `${r.relVol}×`, sub: r.avgVolM != null ? `avg ${r.avgVolM}M` : null },
  ].filter(Boolean);

  return (
    <div className="adv-card">
      <div className="adv-card-head">
        <div className="adv-card-id">
          <div className="adv-card-symrow">
            <span className="adv-sym">{r.sym}</span>
            <span className="adv-hod">+{r.hodExact != null ? r.hodExact.toFixed(2) : r.hod}%</span>
            <span className={`num runner-fade ${fadeClass} adv-fade`}>{r.fade}% fade</span>
            <span className={`num runner-time time-${r.time} adv-time`}>
              {r.time === "premarket" ? "PM" : r.time === "session" ? "SESS" : "MIX"}
            </span>
          </div>
          {r.name && <div className="adv-name">{r.name}</div>}
          <div className="adv-meta">
            {r.sector && <span className="adv-chip">{r.sector}</span>}
            {r.country && <span className="adv-chip muted">{r.country}</span>}
            {r.floatM != null && <span className="adv-chip muted">Float {r.floatM}M</span>}
            {r.marketCap && <span className="adv-chip muted">MC {r.marketCap}</span>}
          </div>
        </div>
        {onDelete && (
          <button
            className="runner-delete adv-delete"
            onClick={() => {
              if (confirm(`Remove ${r.sym} from ${entry.date}?`)) onDelete(entry.date, r.sym);
            }}
            aria-label={`Remove ${r.sym}`}
          >×</button>
        )}
      </div>

      {stats.length > 0 && (
        <div className="adv-stats">
          {stats.map((s) => (
            <div className="adv-stat" key={s.k}>
              <div className="adv-stat-k">{s.k}</div>
              <div className="adv-stat-v">{s.v}</div>
              {s.sub && <div className="adv-stat-sub">{s.sub}</div>}
            </div>
          ))}
        </div>
      )}

      {r.news && r.news.length > 0 && (
        <div className="adv-news">
          <div className="adv-news-label">NEWS · {r.news.length}</div>
          <ul className="adv-news-list">
            {r.news.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

function fmt(n) {
  if (n == null || Number.isNaN(n)) return "—";
  if (Math.abs(n) < 1) return n.toFixed(3);
  if (Math.abs(n) < 10) return n.toFixed(2);
  return n.toFixed(2);
}

// Classification tag → accent color token for the left-border stripe + pill.
const TAG_ACCENT = {
  "RIG":               "oklch(0.7 0.18 150)",
  "FUNDAMENTAL":       "oklch(0.7 0.16 160)",
  "NEWS-DRIVEN":       "oklch(0.75 0.15 85)",
  "UNDERWRITER MANIP": "oklch(0.65 0.22 25)",
  "DILUTION BAIT":     "oklch(0.7 0.17 50)",
  "RETAIL PUMP":       "oklch(0.7 0.2 320)",
  "COMPLIANCE":        "oklch(0.72 0.15 90)",
  "SYMPATHY":          "oklch(0.7 0.14 240)",
  "MIXED":             "oklch(0.6 0.02 250)",
};
function tagAccent(tag) {
  return TAG_ACCENT[tag && tag.toUpperCase()] || TAG_ACCENT.MIXED;
}

// Strip leading ":red_circle:" / emoji circles and return { dot, text }.
// dot ∈ {"red","yellow","green","orange","blue","none"}
function extractTldrDot(s) {
  if (!s) return { dot: "none", text: "" };
  const map = [
    [/^\s*(?::red_circle:|🔴)\s*/i,    "red"],
    [/^\s*(?::yellow_circle:|🟡)\s*/i, "yellow"],
    [/^\s*(?::green_circle:|🟢)\s*/i,  "green"],
    [/^\s*(?::orange_circle:|🟠)\s*/i, "orange"],
    [/^\s*(?::blue_circle:|🔵)\s*/i,   "blue"],
  ];
  for (const [rx, dot] of map) {
    if (rx.test(s)) return { dot, text: s.replace(rx, "").trim() };
  }
  return { dot: "none", text: s.trim() };
}

// Linkify headline: first word looking like a URL becomes the link target,
// otherwise we build a Google News search for ticker + headline.
function headlineHref(sym, title) {
  const urlMatch = title && title.match(/https?:\/\/\S+/);
  if (urlMatch) return urlMatch[0];
  const q = encodeURIComponent(`${sym} ${title}`);
  return `https://news.google.com/search?q=${q}`;
}

function DottedList({ label, items }) {
  if (!items || items.length === 0) return null;
  return (
    <>
      <div className="rt-lbl">{label}</div>
      <ul className="rt-tldr">
        {items.map((t, i) => {
          const { dot, text } = extractTldrDot(t);
          return (
            <li key={i}>
              {dot !== "none" && <span className={`rt-dot-ic rt-dot-${dot}`} />}
              <span>{linkifyText(text || t)}</span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

// Maps literal stoplight emoji to dot className, e.g. "🔴" → "red"
function emojiToDot(em) {
  if (!em) return null;
  if (em.includes("🔴")) return "red";
  if (em.includes("🟡")) return "yellow";
  if (em.includes("🟢")) return "green";
  if (em.includes("🟠")) return "orange";
  if (em.includes("🔵")) return "blue";
  return null;
}

function DynamicSection({ section }) {
  if (!section) return null;
  const headerDot = emojiToDot(section.emoji);
  const hasBullets = section.bullets && section.bullets.length > 0;
  const hasProse = !hasBullets && section.prose;
  if (!hasBullets && !hasProse) return null;

  return (
    <>
      <div className="rt-lbl rt-lbl-dyn">
        {headerDot && <span className={`rt-dot-ic rt-dot-${headerDot} rt-dot-inline`} />}
        <span>{section.title}</span>
      </div>
      {hasBullets && (
        <ul className="rt-tldr">
          {section.bullets.map((t, i) => {
            const { dot, text } = extractTldrDot(t);
            return (
              <li key={i}>
                {dot !== "none" && <span className={`rt-dot-ic rt-dot-${dot}`} />}
                <span>{linkifyText(text || t)}</span>
              </li>
            );
          })}
        </ul>
      )}
      {hasProse && (
        <div className="rt-prose">{linkifyText(section.prose)}</div>
      )}
    </>
  );
}

// Turn inline URLs into <a> tags. Returns an array of strings + elements.
function linkifyText(s) {
  if (!s) return s;
  const parts = [];
  const rx = /(https?:\/\/[^\s)]+)/g;
  let last = 0, m;
  let i = 0;
  while ((m = rx.exec(s)) !== null) {
    if (m.index > last) parts.push(s.slice(last, m.index));
    parts.push(
      <a key={`ln-${i++}`} href={m[1]} target="_blank" rel="noreferrer" className="rt-link">
        {m[1].replace(/^https?:\/\//, "").replace(/\/$/, "").slice(0, 50)}…
      </a>
    );
    last = m.index + m[1].length;
  }
  if (last < s.length) parts.push(s.slice(last));
  return parts;
}

function RunnerTile({ r }) {
  const tag = (r.tag || "MIXED").toUpperCase();
  const accent = tagAccent(tag);
  const hasTile = r.riskBadges || r.reasons || r.tldr || r.news && r.news.length > 0;

  // If this runner was imported from a weekly/daily recap WITHOUT the evening-recap
  // extras, we still show a clean tile with price action + whatever we have.
  return (
    <div className="runner-tile" style={{ "--tag-accent": accent }}>
      <div className="runner-tile-head">
        <div className="rt-left">
          <span className="rt-sym">{r.sym}</span>
          {r.tag && <span className="rt-tag" style={{ background: accent }}>{tag}</span>}
        </div>
        <div className="rt-hod">+{r.hodExact != null ? r.hodExact.toFixed(2) : r.hod}% <span className="rt-hod-sub">HOD</span></div>
      </div>

      <div className="rt-sub">
        {r.floatM != null && (
          <span>
            Float <b>{r.floatM}M</b>
            {r.floatSrc && <span className="rt-src"> ({r.floatSrc})</span>}
          </span>
        )}
        {r.sector && <><span className="rt-dot">·</span><span>{r.sector}</span></>}
        {r.country && <><span className="rt-dot">·</span><span>{r.country}</span></>}
        {r.marketCap && <><span className="rt-dot">·</span><span>MktCap <b>{r.marketCap}</b></span></>}
      </div>

      {r.riskBadges && r.riskBadges.length > 0 && (
        <div className="rt-badges">
          {r.riskBadges.map((b, i) => <span key={i} className="rt-badge">{b}</span>)}
        </div>
      )}

      {/* Dynamic research-report sections (News / Why it's running, Dilution Risk,
          Compliance, Analyst Notes, Theme, Other Catalysts, etc.) */}
      {r.sections && r.sections.length > 0 && r.sections.map((s, i) => (
        <DynamicSection key={i} section={s} />
      ))}

      {/* Legacy fallback: if the recap used the old **Why it ran** format
          AND there are no dynamic sections */}
      {(!r.sections || r.sections.length === 0) &&
       r.reasons && r.reasons.length > 0 && (
        <>
          <div className="rt-lbl">Why it ran</div>
          <ul className="rt-reasons">
            {r.reasons.map((t, i) => <li key={i}>{t}</li>)}
          </ul>
        </>
      )}

      {r.tldr && r.tldr.length > 0 && (
        <>
          <div className="rt-lbl">AskEdgar TLDR</div>
          <ul className="rt-tldr">
            {r.tldr.map((t, i) => {
              const { dot, text } = extractTldrDot(t);
              return (
                <li key={i}>
                  {dot !== "none" && <span className={`rt-dot-ic rt-dot-${dot}`} />}
                  <span>{text}</span>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <div className="rt-pa">
        {r.prevClose != null && (
          <div><span className="rt-k">Prev</span><b>${fmt(r.prevClose)}</b></div>
        )}
        {r.open != null && (
          <div>
            <span className="rt-k">Open</span>
            <b>${fmt(r.open)}</b>
            {r.gapPct != null && <i>({r.gapPct > 0 ? "+" : ""}{r.gapPct}%)</i>}
          </div>
        )}
        {r.high != null && (
          <div>
            <span className="rt-k">HOD</span>
            <b>${fmt(r.high)}</b>
            {r.hodTimeExact && <i>{r.hodTimeExact}</i>}
          </div>
        )}
        {r.close != null && (
          <div>
            <span className="rt-k">Close</span>
            <b>${fmt(r.close)}</b>
            {r.fade != null && <i>(fade {r.fade}%)</i>}
          </div>
        )}
        {r.vwap != null && (
          <div>
            <span className="rt-k">VWAP</span>
            <b>${fmt(r.vwap)}</b>
            {r.vsVwap && <i>({r.vsVwap})</i>}
          </div>
        )}
        {(r.volRaw || r.relVol != null) && (
          <div>
            <span className="rt-k">Vol</span>
            {r.volRaw && <b>{r.volRaw}</b>}
            {r.relVol != null && <i>RelVol {r.relVol}x</i>}
          </div>
        )}
        {r.pmHigh != null && (
          <div>
            <span className="rt-k">PM High</span>
            <b>${fmt(r.pmHigh)}</b>
          </div>
        )}
        {r.low != null && (
          <div>
            <span className="rt-k">Low</span>
            <b>${fmt(r.low)}</b>
          </div>
        )}
      </div>

      {r.news && r.news.length > 0 && (
        <>
          <div className="rt-lbl">Headlines</div>
          <ul className="rt-headlines">
            {r.news.map((h, i) => (
              <li key={i}>
                <a href={headlineHref(r.sym, h)} target="_blank" rel="noopener noreferrer">
                  {h}
                </a>
              </li>
            ))}
          </ul>
        </>
      )}

      {!hasTile && !r.close && (
        <div className="rt-empty">
          No evening-recap detail on file for this runner. Re-import this day from <code>recap_YYYY-MM-DD.md</code> produced by <code>evening_recap.py</code> to see the full tile.
        </div>
      )}
    </div>
  );
}

Object.assign(window, { RunnersBlock, AdvancedRunnerCard, AdvancedRunnersTable, RunnerTile });