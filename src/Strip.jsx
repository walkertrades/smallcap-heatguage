// 5-day rolling strip with inline expandable day detail underneath.

function Strip({ entries, selectedDate, onSelect, thresholds, onDeleteRunner }) {
  const sorted = [...entries].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 5);
  const cells = [];
  for (let i = 0; i < 5; i++) cells.push(sorted[i] || null);
  cells.reverse();

  const fmt = (iso) => {
    const d = new Date(iso + "T00:00:00");
    const mo = d.toLocaleString("en-US", { month: "short" }).toUpperCase();
    const day = d.getDate();
    return `${mo} ${day}`;
  };

  const selected = selectedDate ? entries.find((e) => e.date === selectedDate) : null;

  return (
    <div className="strip">
      <div className="strip-header">
        <span className="label">LAST 5 DAYS</span>
        <span className="label muted">CLICK A DAY FOR DETAIL</span>
      </div>
      <div className="strip-cells">
        {cells.map((c, i) => {
          const active = c && selectedDate === c.date;
          return (
            <div key={i}
              className={`strip-cell ${c ? "filled state-" + c.state.toLowerCase() + " clickable" : "empty"} ${active ? "active" : ""}`}
              onClick={() => c && onSelect && onSelect(active ? null : c.date)}
              role={c ? "button" : undefined}
              tabIndex={c ? 0 : undefined}>
              {c ? (
                <>
                  {c.hodTime === "premarket" && (
                    <span
                      title="Premarket-dominant HOD — distribution risk"
                      aria-label="PM HOD risk"
                      style={{
                        position: "absolute",
                        top: "8px",
                        right: "8px",
                        left: "auto",
                        width: "20px",
                        height: "20px",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "oklch(0.80 0.18 55)",
                        zIndex: 2,
                        pointerEvents: "auto",
                      }}>
                      <svg width="18" height="16" viewBox="0 0 14 13" fill="none" aria-hidden="true">
                        <path d="M7 1.2 L13 11.5 L1 11.5 Z"
                          stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" fill="none" />
                        <line x1="7" y1="5.2" x2="7" y2="8.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                        <circle cx="7" cy="9.8" r="0.7" fill="currentColor" />
                      </svg>
                    </span>
                  )}
                  <div className="strip-date">{fmt(c.date)}</div>
                  <div className="strip-score">{c.score}</div>
                  <div className="strip-state">{c.state}</div>
                  <div className="strip-bar">
                    <div className="strip-bar-fill" style={{ width: `${c.score}%` }} />
                  </div>
                </>
              ) : (
                <div className="strip-empty">—</div>
              )}
            </div>
          );
        })}
      </div>

      {selected && (
        <window.DayDetailInline
          entry={selected}
          thresholds={thresholds}
          onClose={() => onSelect(null)}
          onDeleteRunner={onDeleteRunner}
        />
      )}
    </div>
  );
}

Object.assign(window, { Strip });
