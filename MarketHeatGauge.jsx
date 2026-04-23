import { useState, useEffect, useRef } from "react";

const STATE_COLORS = {
  HOT:     { bg: "#EAF3DE", text: "#3B6D11", border: "#639922", muted: "#97C459" },
  NEUTRAL: { bg: "#FAEEDA", text: "#854F0B", border: "#BA7517", muted: "#EF9F27" },
  COLD:    { bg: "#FCEBEB", text: "#A32D2D", border: "#E24B4A", muted: "#F09595" },
};

const RULES = {
  HOT:     ["Press A+ setups with conviction", "Allow runners — trail, don't exit early", "Add with structure on HOD clearouts", "Session HODs are buyable — wait for volume confirm"],
  NEUTRAL: ["One name focus only", "Take profits quicker at first PT", "Tighter stops — no adding into weakness", "Check HOD time before any entry"],
  COLD:    ["A+ only — if it's not obvious, sit out", "Minimum size on every trade", "Fastest exits — no runners today", "Premarket HOD = distribution trap, avoid"],
};

function calcState(hod, fade, hodtime) {
  if (hodtime === "premarket") return "COLD";
  if (hod >= 150 && fade <= 25 && hodtime === "session") return "HOT";
  if (hod < 100 || fade > 40) return "COLD";
  if (hod >= 150 && hodtime === "session" && fade <= 40) return "HOT";
  return "NEUTRAL";
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function formatDate(iso) {
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("en-US", { month: "numeric", day: "numeric" });
}

function GaugeSVG({ state }) {
  const needleAngles = { COLD: -80, NEUTRAL: 0, HOT: 80 };
  const arcLengths  = { COLD: 52,  NEUTRAL: 172, HOT: 318 };
  const angle = state ? needleAngles[state] : -90;
  const arc   = state ? arcLengths[state]   : 0;
  const c = state ? STATE_COLORS[state] : null;

  return (
    <svg viewBox="0 0 280 160" width="260" height="150" role="img" aria-label="Fuel gauge showing market heat state">
      <defs>
        <linearGradient id="trackGrad" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%"   stopColor="#A32D2D"/>
          <stop offset="40%"  stopColor="#BA7517"/>
          <stop offset="70%"  stopColor="#3B6D11"/>
          <stop offset="100%" stopColor="#0F6E56"/>
        </linearGradient>
      </defs>
      {/* Track background */}
      <path d="M 30 140 A 110 110 0 0 1 250 140" fill="none" stroke="#D3D1C7" strokeWidth="18" strokeLinecap="round"/>
      {/* Filled arc */}
      <path
        d="M 30 140 A 110 110 0 0 1 250 140"
        fill="none"
        stroke="url(#trackGrad)"
        strokeWidth="18"
        strokeLinecap="round"
        strokeDasharray={`${arc} 345`}
        style={{ transition: "stroke-dasharray 0.6s cubic-bezier(0.4,0,0.2,1)" }}
      />
      {/* Labels */}
      <text x="22"  y="156" fontSize="10" fill="#A32D2D" fontFamily="sans-serif" fontWeight="500">COLD</text>
      <text x="114" y="30"  fontSize="10" fill="#3B6D11" fontFamily="sans-serif" fontWeight="500" textAnchor="middle">HOT</text>
      <text x="258" y="156" fontSize="10" fill="#3B6D11" fontFamily="sans-serif" fontWeight="500" textAnchor="end">HOT</text>
      {/* Needle */}
      <line
        x1="140" y1="140" x2="140" y2="48"
        stroke="#2C2C2A" strokeWidth="2.5" strokeLinecap="round"
        transform={`rotate(${angle} 140 140)`}
        style={{ transition: "transform 0.6s cubic-bezier(0.4,0,0.2,1)" }}
      />
      <circle cx="140" cy="140" r="7" fill="#2C2C2A"/>
      <circle cx="140" cy="140" r="3.5" fill="white"/>
      {/* State label */}
      {c && (
        <text x="140" y="118" fontSize="14" fontWeight="500" textAnchor="middle" fill={c.text} fontFamily="sans-serif">
          {state}
        </text>
      )}
    </svg>
  );
}

export default function MarketHeatGauge() {
  const [history, setHistory] = useState([]);
  const [hod, setHod]         = useState("");
  const [fade, setFade]       = useState("");
  const [hodtime, setHodtime] = useState("");
  const [theme, setTheme]     = useState("");
  const [loaded, setLoaded]   = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const r = await window.storage.get("mhg_v1");
        if (r) setHistory(JSON.parse(r.value));
      } catch {}
      setLoaded(true);
    }
    load();
  }, []);

  async function save(days) {
    try { await window.storage.set("mhg_v1", JSON.stringify(days)); } catch {}
  }

  async function logDay() {
    const h = parseInt(hod), f = parseInt(fade);
    if (!h || !f || !hodtime) { alert("Fill in all three required fields."); return; }
    const state = calcState(h, f, hodtime);
    const today = todayISO();
    const entry = { date: today, hod: h, fade: f, hodtime, theme, state };
    const next = [...history.filter(d => d.date !== today), entry].slice(-30);
    setHistory(next);
    await save(next);
    setHod(""); setFade(""); setHodtime(""); setTheme("");
  }

  const latest  = history.length ? history[history.length - 1] : null;
  const state   = latest?.state ?? null;
  const c       = state ? STATE_COLORS[state] : null;
  const last5   = history.slice(-5);

  // Streak
  let streak = 0;
  if (history.length && state) {
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].state === state) streak++;
      else break;
    }
  }

  // Warning: HOD time shifted from session to premarket
  let warning = null;
  if (history.length >= 2) {
    const prev = history[history.length - 2];
    const curr = history[history.length - 1];
    if (prev.hodtime === "session" && curr.hodtime === "premarket") {
      warning = { type: "shift", msg: "HOD time shifted session → premarket. Cycle cooling. Size down — treat premarket entries as distribution traps until session confirms." };
    } else if (prev.state === "HOT" && curr.state === "COLD") {
      warning = { type: "flip", msg: "Cycle flipped HOT → COLD. Minimum size. No anticipation trades. Wait for session structure before any entry." };
    }
  }

  const warnColors = {
    shift: { bg: "#FAEEDA", border: "#BA7517", text: "#854F0B" },
    flip:  { bg: "#FCEBEB", border: "#E24B4A", text: "#A32D2D" },
  };

  if (!loaded) return <div style={{ padding: "2rem", color: "#888", fontSize: 14 }}>Loading...</div>;

  return (
    <div style={{ fontFamily: "sans-serif", maxWidth: 640, padding: "1.25rem 1rem" }}>

      {/* Gauge */}
      <div style={{ display: "flex", justifyContent: "center", marginBottom: "0.75rem" }}>
        <GaugeSVG state={state} />
      </div>

      {/* Warning banner */}
      {warning && (
        <div style={{
          background: warnColors[warning.type].bg,
          border: `0.5px solid ${warnColors[warning.type].border}`,
          color: warnColors[warning.type].text,
          borderRadius: 8, padding: "10px 14px", fontSize: 13, marginBottom: "1rem"
        }}>
          {warning.msg}
        </div>
      )}

      {/* Meta cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, marginBottom: "1rem" }}>
        {[
          { label: "Avg HOD", val: latest ? `+${latest.hod}%` : "—" },
          { label: "HOD time", val: latest ? latest.hodtime.charAt(0).toUpperCase() + latest.hodtime.slice(1) : "—" },
          { label: "Avg fade", val: latest ? `${latest.fade}%` : "—" },
        ].map(({ label, val }) => (
          <div key={label} style={{ background: "#F1EFE8", borderRadius: 8, padding: "10px 12px" }}>
            <div style={{ fontSize: 11, color: "#888780", marginBottom: 2 }}>{label}</div>
            <div style={{ fontSize: 17, fontWeight: 500 }}>{val}</div>
          </div>
        ))}
      </div>

      {/* Streak */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#5F5E5A", marginBottom: "1rem" }}>
        <span style={{ fontSize: 22, fontWeight: 500, color: "#2C2C2A" }}>{streak}</span>
        <span>consecutive days in current state</span>
        {state === "HOT" && streak >= 3 && (
          <span style={{ fontSize: 12, color: "#BA7517" }}>⚠ reversal risk</span>
        )}
      </div>

      {/* Rules */}
      {c && (
        <div style={{
          background: c.bg, border: `0.5px solid ${c.border}`,
          borderRadius: 12, padding: "1rem 1.25rem", marginBottom: "1rem"
        }}>
          <div style={{ fontSize: 12, fontWeight: 500, color: c.text, marginBottom: 8 }}>
            {state}{latest?.theme ? ` — ${latest.theme}` : " — today's playbook"}
          </div>
          {RULES[state].map((r, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: c.text, padding: "3px 0" }}>
              <div style={{ width: 5, height: 5, borderRadius: "50%", background: c.text, flexShrink: 0 }}/>
              {r}
            </div>
          ))}
        </div>
      )}

      <hr style={{ border: "none", borderTop: "0.5px solid #D3D1C7", margin: "1.25rem 0" }}/>

      {/* Form */}
      <div style={{ fontSize: 11, fontWeight: 500, letterSpacing: "0.06em", textTransform: "uppercase", color: "#888780", marginBottom: 8 }}>
        Log today
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: "0.75rem" }}>
        {[
          { label: "Avg HOD %", placeholder: "e.g. 197", val: hod, set: setHod, type: "number" },
          { label: "Avg fade %", placeholder: "e.g. 28",  val: fade, set: setFade, type: "number" },
        ].map(({ label, placeholder, val, set, type }) => (
          <div key={label}>
            <div style={{ fontSize: 12, color: "#5F5E5A", marginBottom: 4 }}>{label}</div>
            <input type={type} placeholder={placeholder} value={val} min="0"
              onChange={e => set(e.target.value)}
              style={{ width: "100%", fontSize: 14, padding: "8px 10px", border: "0.5px solid #B4B2A9", borderRadius: 8, background: "transparent", color: "inherit", outline: "none" }}
            />
          </div>
        ))}
        <div>
          <div style={{ fontSize: 12, color: "#5F5E5A", marginBottom: 4 }}>HOD time</div>
          <select value={hodtime} onChange={e => setHodtime(e.target.value)}
            style={{ width: "100%", fontSize: 14, padding: "8px 10px", border: "0.5px solid #B4B2A9", borderRadius: 8, background: "transparent", color: "inherit", outline: "none" }}>
            <option value="">Select...</option>
            <option value="session">Session (after 9:30am)</option>
            <option value="premarket">Premarket (before 9:30am)</option>
            <option value="mixed">Mixed</option>
          </select>
        </div>
        <div>
          <div style={{ fontSize: 12, color: "#5F5E5A", marginBottom: 4 }}>Theme (optional)</div>
          <input type="text" placeholder="e.g. China penny" value={theme} maxLength={30}
            onChange={e => setTheme(e.target.value)}
            style={{ width: "100%", fontSize: 14, padding: "8px 10px", border: "0.5px solid #B4B2A9", borderRadius: 8, background: "transparent", color: "inherit", outline: "none" }}
          />
        </div>
      </div>

      <button onClick={logDay} style={{
        width: "100%", padding: "10px", fontSize: 14, fontWeight: 500,
        cursor: "pointer", borderRadius: 8,
        background: "transparent", border: "0.5px solid #888780", color: "inherit",
      }}>
        Log today ↗
      </button>

      <hr style={{ border: "none", borderTop: "0.5px solid #D3D1C7", margin: "1.25rem 0" }}/>

      {/* History strip */}
      <div style={{ fontSize: 11, fontWeight: 500, letterSpacing: "0.06em", textTransform: "uppercase", color: "#888780", marginBottom: 8 }}>
        Last 5 days
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        {last5.length === 0
          ? <div style={{ fontSize: 13, color: "#888780", padding: "8px 0" }}>No history yet — log your first day above.</div>
          : [...Array(Math.max(0, 5 - last5.length)).fill(null), ...last5].map((d, i) => {
              if (!d) return (
                <div key={i} style={{ flex: 1, borderRadius: 8, border: "0.5px solid #D3D1C7", padding: 8, textAlign: "center", opacity: 0.3 }}>
                  <div style={{ fontSize: 11, color: "#888" }}>—</div>
                </div>
              );
              const dc = STATE_COLORS[d.state];
              return (
                <div key={d.date} style={{ flex: 1, borderRadius: 8, border: `0.5px solid ${dc.border}`, padding: 8, textAlign: "center", background: dc.bg }}>
                  <div style={{ fontSize: 11, color: dc.text, opacity: 0.7, marginBottom: 3 }}>{formatDate(d.date)}</div>
                  <div style={{ fontSize: 12, fontWeight: 500, color: dc.text }}>{d.state}</div>
                  <div style={{ fontSize: 11, color: dc.text, opacity: 0.8, marginTop: 2 }}>+{d.hod}%</div>
                  {d.hodtime === "premarket" && (
                    <div style={{ fontSize: 9, color: dc.text, opacity: 0.65, marginTop: 2 }}>PM HOD</div>
                  )}
                  {d.theme && (
                    <div style={{ fontSize: 9, color: dc.text, opacity: 0.65, marginTop: 1 }}>{d.theme}</div>
                  )}
                </div>
              );
            })
        }
      </div>
    </div>
  );
}
