// Animated heat gauge — semicircle with tick marks and a spring-tweened needle.
const { useEffect, useState, useRef } = React;

function useSpring(target, { stiffness = 0.12, damping = 0.78 } = {}) {
  const [val, setVal] = useState(target);
  const ref = useRef({ v: target, vel: 0 });
  useEffect(() => {
    let raf;
    const tick = () => {
      const cur = ref.current;
      const force = (target - cur.v) * stiffness;
      cur.vel = (cur.vel + force) * damping;
      cur.v += cur.vel;
      if (Math.abs(target - cur.v) < 0.05 && Math.abs(cur.vel) < 0.05) {
        cur.v = target;
        cur.vel = 0;
        setVal(target);
        return;
      }
      setVal(cur.v);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, stiffness, damping]);
  return val;
}

function Gauge({ score, state }) {
  // Map score 0-100 → angle -90..90 deg. Needle origin at bottom center.
  const targetAngle = score == null ? 0 : (score - 50) * 1.8;
  const angle = useSpring(targetAngle);

  // Arc geometry
  const cx = 200, cy = 180, r = 140;
  const strokeW = 22;

  // Build three colored arcs (cold, neutral, hot)
  const arc = (startDeg, endDeg) => {
    const s = ((startDeg - 180) * Math.PI) / 180;
    const e = ((endDeg - 180) * Math.PI) / 180;
    const x1 = cx + r * Math.cos(s);
    const y1 = cy + r * Math.sin(s);
    const x2 = cx + r * Math.cos(e);
    const y2 = cy + r * Math.sin(e);
    const largeArc = endDeg - startDeg > 180 ? 1 : 0;
    return `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`;
  };

  // Ticks
  const ticks = [];
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    const a = ((180 + t * 180 - 180) * Math.PI) / 180;
    const inner = i % 5 === 0 ? r - 16 : r - 8;
    const outer = r - 2;
    ticks.push({
      x1: cx + inner * Math.cos(a),
      y1: cy + inner * Math.sin(a),
      x2: cx + outer * Math.cos(a),
      y2: cy + outer * Math.sin(a),
      major: i % 5 === 0,
    });
  }

  const isEmpty = score == null;
  const needleColor =
    state === "HOT" ? "var(--hot)" :
    state === "COLD" ? "var(--cold)" :
    state === "NEUTRAL" ? "var(--neutral)" :
    "var(--muted)";

  return (
    <div className="gauge-wrap">
      <svg viewBox="0 0 400 220" className="gauge-svg">
        <defs>
          <filter id="needleGlow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="2.5" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Background arc */}
        <path d={arc(0, 180)} stroke="var(--card-border)" strokeWidth={strokeW + 4} fill="none" strokeLinecap="butt" />

        {/* Three colored zones — bounds match score→state thresholds (COLD <40, NEUTRAL 40-75, HOT ≥75) */}
        <path d={arc(0, 72)} stroke="var(--cold)" strokeWidth={strokeW} fill="none" opacity={isEmpty ? 0.25 : state === "COLD" ? 1 : 0.35} />
        <path d={arc(72, 135)} stroke="var(--neutral)" strokeWidth={strokeW} fill="none" opacity={isEmpty ? 0.25 : state === "NEUTRAL" ? 1 : 0.35} />
        <path d={arc(135, 180)} stroke="var(--hot)" strokeWidth={strokeW} fill="none" opacity={isEmpty ? 0.25 : state === "HOT" ? 1 : 0.35} />

        {/* Zone boundary ticks (stronger) */}
        {[40, 75].map((v) => {
          const a = ((180 + (v / 100) * 180 - 180) * Math.PI) / 180;
          return (
            <line key={v}
              x1={cx + (r - 20) * Math.cos(a)} y1={cy + (r - 20) * Math.sin(a)}
              x2={cx + (r + 4) * Math.cos(a)} y2={cy + (r + 4) * Math.sin(a)}
              stroke="rgba(255,255,255,0.35)" strokeWidth="1" strokeDasharray="2 2" />
          );
        })}

        {/* Ticks */}
        {ticks.map((t, i) => (
          <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2}
            stroke={t.major ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.2)"}
            strokeWidth={t.major ? 1.4 : 0.8} />
        ))}

        {/* Zone labels — positioned at the arc mid-points for each zone */}
        {(() => {
          const labelR = r - 40;
          const mkPos = (degFromLeft) => {
            const a = ((180 + degFromLeft) * Math.PI) / 180;
            return { x: cx + labelR * Math.cos(a), y: cy + labelR * Math.sin(a) };
          };
          const cold = mkPos(36);
          const neutral = mkPos(103);
          const hot = mkPos(157);
          return (
            <>
              <text x={cold.x} y={cold.y + 4} textAnchor="middle" className="gauge-zone-label" fill="var(--cold)">COLD</text>
              <text x={neutral.x} y={neutral.y + 4} textAnchor="middle" className="gauge-zone-label" fill="var(--neutral)">NEUTRAL</text>
              <text x={hot.x} y={hot.y + 4} textAnchor="middle" className="gauge-zone-label" fill="var(--hot)">HOT</text>
            </>
          );
        })()}

        {/* Needle */}
        {!isEmpty && (
          <g transform={`rotate(${angle} ${cx} ${cy})`} filter="url(#needleGlow)">
            <line x1={cx} y1={cy} x2={cx} y2={cy - r + 8} stroke={needleColor} strokeWidth="2.5" strokeLinecap="round" />
            <polygon
              points={`${cx - 5},${cy - 20} ${cx + 5},${cy - 20} ${cx},${cy - r + 4}`}
              fill={needleColor} opacity="0.9" />
          </g>
        )}

        {/* Hub */}
        <circle cx={cx} cy={cy} r="14" fill="var(--bg)" stroke={needleColor} strokeWidth="2" />
        <circle cx={cx} cy={cy} r="4" fill={needleColor} />

        {/* Score readout below hub */}
        <text x={cx} y={cy + 34} textAnchor="middle" className="gauge-score">
          {isEmpty ? "—" : score}
        </text>
      </svg>
    </div>
  );
}

Object.assign(window, { Gauge });
