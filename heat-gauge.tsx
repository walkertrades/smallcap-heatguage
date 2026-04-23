import { useState, useEffect, useMemo } from "react";
import { Flame, Snowflake, Minus, AlertTriangle, Save, Trash2 } from "lucide-react";

// ---- helpers ----
const todayISO = () => {
  const d = new Date();
  return d.toISOString().slice(0, 10);
};

const fmtDate = (iso) => {
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

// classify a single day's inputs
const classify = ({ hod, hodTime, fade }) => {
  // Premarket override: cap at NEUTRAL/COLD
  if (hodTime === "premarket") {
    if (hod < 100 || fade > 40) return "COLD";
    return "NEUTRAL";
  }
  // HOT: all three conditions
  if (hodTime === "session" && hod > 150 && fade < 25) return "HOT";
  // COLD: any one trigger
  if (hod < 100 || fade > 40) return "COLD";
  return "NEUTRAL";
};

// composite heat score 0-100 for needle position
const heatScore = ({ hod, hodTime, fade }) => {
  // HOD contribution: 0-50 pts, caps at 200%
  const hodPts = Math.min(50, (hod / 200) * 50);
  // Fade contribution: inverted, 0-30 pts, 0% fade = 30, 50%+ = 0
  const fadePts = Math.max(0, 30 - (fade / 50) * 30);
  // HOD time: 0-20 pts
  const timePts = hodTime === "session" ? 20 : hodTime === "mixed" ? 10 : 0;
  return Math.max(0, Math.min(100, hodPts + fadePts + timePts));
};

const stateColors = {
  HOT: { bg: "bg-red-500", text: "text-red-400", ring: "ring-red-500/40", hex: "#ef4444" },
  NEUTRAL: { bg: "bg-emerald-500", text: "text-emerald-400", ring: "ring-emerald-500/40", hex: "#10b981" },
  COLD: { bg: "bg-blue-500", text: "text-blue-400", ring: "ring-blue-500/40", hex: "#3b82f6" },
};

// ---- Gauge ----
function Gauge({ score, state }) {
  // arc goes from 180deg (left) to 0deg (right)
  // score 0 -> 180, score 100 -> 0
  const angle = 180 - (score / 100) * 180;
  const cx = 150;
  const cy = 150;
  const r = 110;
  const rad = (angle * Math.PI) / 180;
  const needleX = cx + r * Math.cos(rad);
  const needleY = cy - r * Math.sin(rad);

  // arc segments
  const arcPath = (startAngle, endAngle, radius) => {
    const s = (startAngle * Math.PI) / 180;
    const e = (endAngle * Math.PI) / 180;
    const x1 = cx + radius * Math.cos(s);
    const y1 = cy - radius * Math.sin(s);
    const x2 = cx + radius * Math.cos(e);
    const y2 = cy - radius * Math.sin(e);
    const largeArc = Math.abs(endAngle - startAngle) > 180 ? 1 : 0;
    const sweep = startAngle > endAngle ? 1 : 0;
    return `M ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} ${sweep} ${x2} ${y2}`;
  };

  return (
    <div className="relative w-full flex justify-center">
      <svg viewBox="0 0 300 180" className="w-full max-w-xs">
        {/* COLD zone: 180 -> 120 */}
        <path d={arcPath(180, 120, r)} stroke="#3b82f6" strokeWidth="18" fill="none" strokeLinecap="butt" opacity="0.7" />
        {/* NEUTRAL zone: 120 -> 60 */}
        <path d={arcPath(120, 60, r)} stroke="#10b981" strokeWidth="18" fill="none" strokeLinecap="butt" opacity="0.7" />
        {/* HOT zone: 60 -> 0 */}
        <path d={arcPath(60, 0, r)} stroke="#ef4444" strokeWidth="18" fill="none" strokeLinecap="butt" opacity="0.7" />

        {/* tick marks */}
        {[0, 30, 60, 90, 120, 150, 180].map((t) => {
          const tr = (t * Math.PI) / 180;
          const x1 = cx + (r - 14) * Math.cos(tr);
          const y1 = cy - (r - 14) * Math.sin(tr);
          const x2 = cx + (r + 4) * Math.cos(tr);
          const y2 = cy - (r + 4) * Math.sin(tr);
          return <line key={t} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#4b5563" strokeWidth="1.5" />;
        })}

        {/* labels */}
        <text x="30" y="165" fill="#60a5fa" fontSize="11" fontFamily="ui-monospace, monospace" fontWeight="600">COLD</text>
        <text x="240" y="165" fill="#f87171" fontSize="11" fontFamily="ui-monospace, monospace" fontWeight="600">HOT</text>

        {/* needle */}
        <line
          x1={cx}
          y1={cy}
          x2={needleX}
          y2={needleY}
          stroke={stateColors[state].hex}
          strokeWidth="3"
          strokeLinecap="round"
          style={{ transition: "all 0.6s cubic-bezier(.4,1.4,.6,1)" }}
        />
        {/* hub */}
        <circle cx={cx} cy={cy} r="8" fill="#1f2937" stroke={stateColors[state].hex} strokeWidth="2" />
        <circle cx={cx} cy={cy} r="3" fill={stateColors[state].hex} />
      </svg>
    </div>
  );
}

// ---- Tile for rolling strip ----
function DayTile({ entry, isToday }) {
  if (!entry) {
    return (
      <div className="flex-1 h-14 rounded border border-dashed border-gray-700 flex items-center justify-center">
        <span className="text-[10px] text-gray-600 font-mono">—</span>
      </div>
    );
  }
  const c = stateColors[entry.state];
  return (
    <div className={`flex-1 h-14 rounded border ${isToday ? "border-white" : "border-gray-700"} ${c.bg}/20 flex flex-col items-center justify-center gap-0.5`}>
      <span className={`text-[10px] font-mono font-bold ${c.text}`}>{entry.state[0]}</span>
      <span className="text-[9px] text-gray-400 font-mono">{fmtDate(entry.date)}</span>
    </div>
  );
}

// ---- Rules panel ----
const rules = {
  HOT: {
    icon: Flame,
    title: "PRESS",
    items: ["Press A+ setups", "Allow runners to develop", "Add with structure"],
  },
  NEUTRAL: {
    icon: Minus,
    title: "SELECTIVE",
    items: ["One name, focused", "Take profits quicker", "Tighter stops"],
  },
  COLD: {
    icon: Snowflake,
    title: "DEFEND",
    items: ["A+ setups only", "Minimum size", "Fastest exits", "Consider no trade"],
  },
};

function RulesPanel({ state }) {
  const r = rules[state];
  const Icon = r.icon;
  const c = stateColors[state];
  return (
    <div className={`rounded-lg border border-gray-800 p-4 bg-gray-900/40`}>
      <div className="flex items-center gap-2 mb-3">
        <Icon size={16} className={c.text} />
        <span className={`text-xs font-mono font-bold tracking-widest ${c.text}`}>{r.title}</span>
      </div>
      <ul className="space-y-1.5">
        {r.items.map((item, i) => (
          <li key={i} className="text-sm text-gray-300 flex gap-2">
            <span className={c.text}>›</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---- main ----
export default function HeatGauge() {
  const [entries, setEntries] = useState({}); // { 'YYYY-MM-DD': { date, hod, hodTime, fade, state } }
  const [loading, setLoading] = useState(true);
  const [date, setDate] = useState(todayISO());
  const [hod, setHod] = useState("");
  const [hodTime, setHodTime] = useState("session");
  const [fade, setFade] = useState("");
  const [justSaved, setJustSaved] = useState(false);

  // load
  useEffect(() => {
    (async () => {
      try {
        const res = await window.storage.list("entry:");
        if (res?.keys?.length) {
          const loaded = {};
          for (const k of res.keys) {
            try {
              const v = await window.storage.get(k);
              if (v?.value) {
                const parsed = JSON.parse(v.value);
                loaded[parsed.date] = parsed;
              }
            } catch (e) { /* skip bad entry */ }
          }
          setEntries(loaded);
        }
      } catch (e) {
        console.error("load failed", e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // when date changes, populate the form from saved entry if exists
  useEffect(() => {
    const e = entries[date];
    if (e) {
      setHod(String(e.hod));
      setHodTime(e.hodTime);
      setFade(String(e.fade));
    } else {
      setHod("");
      setHodTime("session");
      setFade("");
    }
  }, [date, entries]);

  // live preview from form inputs
  const preview = useMemo(() => {
    const h = parseFloat(hod);
    const f = parseFloat(fade);
    if (isNaN(h) || isNaN(f)) return null;
    const inputs = { hod: h, hodTime, fade: f };
    return { inputs, state: classify(inputs), score: heatScore(inputs) };
  }, [hod, hodTime, fade]);

  // sorted entries for strip and streak
  const sorted = useMemo(() => {
    return Object.values(entries).sort((a, b) => a.date.localeCompare(b.date));
  }, [entries]);

  // last 5 days strip — show last 5 saved entries with current date highlighted if present
  const stripDays = useMemo(() => {
    return sorted.slice(-5);
  }, [sorted]);

  // current state = last saved entry (or preview if nothing saved)
  const current = useMemo(() => {
    if (sorted.length) {
      const last = sorted[sorted.length - 1];
      return { state: last.state, score: heatScore(last), date: last.date };
    }
    if (preview) return { ...preview, date };
    return { state: "NEUTRAL", score: 50, date: null };
  }, [sorted, preview, date]);

  // streak: consecutive days ending at latest with same state
  const streak = useMemo(() => {
    if (!sorted.length) return { count: 0, state: null };
    const latest = sorted[sorted.length - 1];
    let count = 1;
    for (let i = sorted.length - 2; i >= 0; i--) {
      if (sorted[i].state === latest.state) count++;
      else break;
    }
    return { count, state: latest.state };
  }, [sorted]);

  const save = async () => {
    const h = parseFloat(hod);
    const f = parseFloat(fade);
    if (isNaN(h) || isNaN(f)) return;
    const inputs = { hod: h, hodTime, fade: f };
    const entry = { date, ...inputs, state: classify(inputs) };
    try {
      await window.storage.set(`entry:${date}`, JSON.stringify(entry));
      setEntries((prev) => ({ ...prev, [date]: entry }));
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 1200);
    } catch (e) {
      console.error("save failed", e);
    }
  };

  const del = async () => {
    if (!entries[date]) return;
    try {
      await window.storage.delete(`entry:${date}`);
      setEntries((prev) => {
        const copy = { ...prev };
        delete copy[date];
        return copy;
      });
    } catch (e) {
      console.error("delete failed", e);
    }
  };

  const c = stateColors[current.state];
  const streakWarn = streak.state === "HOT" && streak.count >= 3;

  if (loading) {
    return (
      <div className="min-h-screen bg-black text-gray-500 flex items-center justify-center font-mono text-xs">
        loading…
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-gray-100 p-4 md:p-6" style={{ fontFamily: "ui-sans-serif, system-ui" }}>
      <div className="max-w-md mx-auto space-y-5">
        {/* header */}
        <div className="flex items-baseline justify-between">
          <h1 className="text-sm font-mono tracking-widest text-gray-400">SMALL CAP HEAT</h1>
          <span className="text-xs font-mono text-gray-600">{fmtDate(todayISO())}</span>
        </div>

        {/* gauge with NEUTRAL label above */}
        <div className="space-y-1">
          <div className="flex justify-center">
            <span className="text-[11px] font-mono font-semibold tracking-widest text-emerald-400">NEUTRAL</span>
          </div>
          <Gauge score={current.score} state={current.state} />
        </div>

        {/* state badge */}
        <div className={`rounded-xl border border-gray-800 p-5 bg-gray-900/40 ring-1 ${c.ring}`}>
          <div className="text-[10px] font-mono text-gray-500 tracking-widest mb-1">MARKET STATE</div>
          <div className="flex items-baseline justify-between">
            <div className={`text-5xl font-black tracking-tight ${c.text}`}>{current.state}</div>
            <div className="text-right">
              <div className="text-[10px] font-mono text-gray-500">SCORE</div>
              <div className="text-xl font-mono text-gray-200">{Math.round(current.score)}</div>
            </div>
          </div>
          {streak.count > 0 && (
            <div className="mt-3 pt-3 border-t border-gray-800 flex items-center justify-between">
              <div className="text-xs font-mono text-gray-400">
                STREAK: <span className={c.text}>{streak.count}d {streak.state}</span>
              </div>
              {streakWarn && (
                <div className="flex items-center gap-1 text-xs text-orange-400 font-mono">
                  <AlertTriangle size={12} />
                  <span>reversal risk</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* 5-day strip */}
        <div>
          <div className="text-[10px] font-mono text-gray-500 tracking-widest mb-2">LAST 5 DAYS</div>
          <div className="flex gap-1.5">
            {Array.from({ length: 5 }).map((_, i) => {
              const e = stripDays[i];
              return <DayTile key={i} entry={e} isToday={e?.date === todayISO()} />;
            })}
          </div>
        </div>

        {/* rules */}
        <RulesPanel state={current.state} />

        {/* inputs */}
        <div className="rounded-lg border border-gray-800 p-4 bg-gray-900/40 space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-[10px] font-mono text-gray-500 tracking-widest">DAILY ENTRY</div>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="bg-black border border-gray-800 rounded px-2 py-1 text-xs font-mono text-gray-300 focus:outline-none focus:border-gray-600"
              style={{ colorScheme: "dark" }}
            />
          </div>

          <div>
            <label className="text-[10px] font-mono text-gray-500 block mb-1">AVG HOD %</label>
            <input
              type="number"
              value={hod}
              onChange={(e) => setHod(e.target.value)}
              placeholder="e.g. 197"
              className="w-full bg-black border border-gray-800 rounded px-3 py-2 text-sm font-mono text-gray-100 focus:outline-none focus:border-gray-600"
            />
          </div>

          <div>
            <label className="text-[10px] font-mono text-gray-500 block mb-1">DOMINANT HOD TIME</label>
            <div className="grid grid-cols-3 gap-1.5">
              {[
                ["premarket", "PM"],
                ["mixed", "MIX"],
                ["session", "SESS"],
              ].map(([val, label]) => (
                <button
                  key={val}
                  onClick={() => setHodTime(val)}
                  className={`py-2 rounded text-xs font-mono font-semibold border transition-colors ${
                    hodTime === val
                      ? "bg-gray-200 text-black border-gray-200"
                      : "bg-black text-gray-400 border-gray-800 hover:border-gray-600"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-[10px] font-mono text-gray-500 block mb-1">AVG FADE %</label>
            <input
              type="number"
              value={fade}
              onChange={(e) => setFade(e.target.value)}
              placeholder="e.g. 34"
              className="w-full bg-black border border-gray-800 rounded px-3 py-2 text-sm font-mono text-gray-100 focus:outline-none focus:border-gray-600"
            />
          </div>

          {preview && (
            <div className="text-[10px] font-mono text-gray-500 flex justify-between pt-1">
              <span>PREVIEW</span>
              <span className={stateColors[preview.state].text}>
                {preview.state} · {Math.round(preview.score)}
              </span>
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button
              onClick={save}
              disabled={!preview}
              className="flex-1 bg-white text-black rounded py-2 text-xs font-mono font-bold tracking-widest disabled:bg-gray-800 disabled:text-gray-600 flex items-center justify-center gap-1.5 transition-colors"
            >
              <Save size={12} />
              {justSaved ? "SAVED" : entries[date] ? "UPDATE" : "SAVE"}
            </button>
            {entries[date] && (
              <button
                onClick={del}
                className="px-3 rounded border border-gray-800 text-gray-500 hover:text-red-400 hover:border-red-900 transition-colors"
                aria-label="delete entry"
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        </div>

        <div className="text-[10px] font-mono text-gray-700 text-center pt-2">
          entries stored locally · persists across sessions
        </div>
      </div>
    </div>
  );
}
