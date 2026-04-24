// Daily entry form — date + HOD % + HOD time + fade %.
const { useState: useState_EF, useEffect: useEffect_EF, useMemo: useMemo_EF } = React;

function todayISO() {
  const d = new Date();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mo}-${da}`;
}

function EntryForm({ onSave, existing, thresholds }) {
  const [date, setDate] = useState_EF(todayISO());
  const [hod, setHod] = useState_EF("");
  const [hodTime, setHodTime] = useState_EF("");
  const [fade, setFade] = useState_EF("");
  const [theme, setTheme] = useState_EF("");
  const [justSaved, setJustSaved] = useState_EF(false);

  // If an entry already exists for the chosen date, preload it for editing.
  useEffect_EF(() => {
    const match = existing.find((e) => e.date === date);
    if (match) {
      setHod(String(match.hod));
      setHodTime(match.hodTime);
      setFade(String(match.fade));
      setTheme(match.theme || "");
    } else {
      setHod(""); setHodTime(""); setFade(""); setTheme("");
    }
  }, [date, existing]);

  const preview = useMemo_EF(() => {
    if (hod === "" || fade === "" || !hodTime) return null;
    return window.computeHeat({ hod: Number(hod), fade: Number(fade), hodTime }, thresholds);
  }, [hod, fade, hodTime, thresholds]);

  const canSave = hod !== "" && fade !== "" && hodTime !== "";

  const save = () => {
    if (!canSave) return;
    onSave({
      date,
      hod: Number(hod),
      fade: Number(fade),
      hodTime,
      theme: theme.trim() || undefined,
    });
    setJustSaved(true);
    setTimeout(() => setJustSaved(false), 1500);
  };

  const isEditing = existing.some((e) => e.date === date);

  return (
    <div className="card entry-card">
      <div className="entry-header">
        <div className="label">DAILY ENTRY {isEditing && <span className="edit-badge">· EDIT</span>}</div>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="date-input" />
      </div>

      <div className="field">
        <label className="label">AVG HOD %</label>
        <div className="input-row">
          <input type="number" inputMode="decimal" placeholder="e.g. 197" value={hod}
            onChange={(e) => setHod(e.target.value)} className="num-input" />
          <span className="unit">%</span>
        </div>
        <div className="hint">&gt; {thresholds.hodHot}% = HOT · {thresholds.hodNeutralLo}–{thresholds.hodHot}% = NEUTRAL · &lt; {thresholds.hodNeutralLo}% = COLD</div>
      </div>

      <div className="field">
        <label className="label">DOMINANT HOD TIME</label>
        <div className="seg">
          {[
            { v: "premarket", label: "PREMARKET", sub: "pre-9:30" },
            { v: "mixed", label: "MIXED", sub: "split" },
            { v: "session", label: "SESSION", sub: "post-9:30" },
          ].map((o) => (
            <button key={o.v} type="button"
              className={`seg-btn ${hodTime === o.v ? "active" : ""}`}
              onClick={() => setHodTime(o.v)}>
              <span className="seg-label">{o.label}</span>
              <span className="seg-sub">{o.sub}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <label className="label">AVG FADE %</label>
        <div className="input-row">
          <input type="number" inputMode="decimal" placeholder="e.g. 34" value={fade}
            onChange={(e) => setFade(e.target.value)} className="num-input" />
          <span className="unit">%</span>
        </div>
        <div className="hint">&lt; {thresholds.fadeHot}% = HOT · {thresholds.fadeHot}–{thresholds.fadeCold}% = NEUTRAL · &gt; {thresholds.fadeCold}% = COLD</div>
      </div>

      <div className="field">
        <label className="label">THEME <span style={{ color: "var(--text-muted)", letterSpacing: "0.08em" }}>· OPTIONAL</span></label>
        <input type="text" placeholder="e.g. China penny" maxLength={30} value={theme}
          onChange={(e) => setTheme(e.target.value)} className="num-input"
          style={{ borderRadius: 4, width: "100%" }} />
      </div>

      {preview && (
        <div className="preview-row">
          <span className="label muted">PREVIEW</span>
          <span className={`preview-chip state-${preview.state.toLowerCase()}`}>
            {preview.state} · {preview.score}
          </span>
        </div>
      )}

      <button type="button" className={`save-btn ${canSave ? "" : "disabled"} ${justSaved ? "saved" : ""}`}
        onClick={save} disabled={!canSave}>
        {justSaved ? "✓ SAVED" : isEditing ? "UPDATE ENTRY" : "SAVE ENTRY"}
      </button>
    </div>
  );
}

Object.assign(window, { EntryForm, todayISO });
