// Scoring engine for the small-cap heat gauge.
// Exported to window so other Babel scripts can use it.

const DEFAULT_THRESHOLDS = {
  hodHot: 150,        // avg HOD > 150 counts toward HOT
  hodNeutralLo: 100,  // 100-150 is NEUTRAL territory
  fadeHot: 25,        // fade < 25 counts toward HOT
  fadeCold: 40,       // fade > 40 counts toward COLD
};

// Return a 0-100 "heat score" along with the categorical state.
// We compute three subscores (HOD, timing, fade), average them,
// then apply the premarket override per spec.
function computeHeat(entry, thresholds = DEFAULT_THRESHOLDS) {
  if (!entry || entry.hod == null || entry.fade == null || !entry.hodTime) {
    return { score: null, state: "EMPTY", sub: null };
  }

  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const hod = Number(entry.hod);
  const fade = Number(entry.fade);

  // HOD subscore: piecewise — cap raised to hodHot+500 so extreme days get full credit
  let hodScore;
  if (hod >= t.hodHot + 500) hodScore = 100;
  else if (hod >= t.hodHot + 100) hodScore = 85 + ((hod - (t.hodHot + 100)) / 400) * 15;
  else if (hod >= t.hodHot) hodScore = 75 + ((hod - t.hodHot) / 100) * 10;
  else if (hod >= t.hodNeutralLo) hodScore = 40 + ((hod - t.hodNeutralLo) / (t.hodHot - t.hodNeutralLo)) * 35;
  else hodScore = Math.max(0, (hod / t.hodNeutralLo) * 40);

  // Fade subscore (inverse — lower fade = hotter)
  // Weight reduced to 25% — fade matters but shouldn't override extreme HOD tape
  let fadeScore;
  if (fade <= t.fadeHot) fadeScore = 90 + Math.max(0, ((t.fadeHot - fade) / t.fadeHot) * 10);
  else if (fade <= t.fadeCold) fadeScore = 40 + ((t.fadeCold - fade) / (t.fadeCold - t.fadeHot)) * 50;
  else fadeScore = Math.max(0, 40 - ((fade - t.fadeCold) / 40) * 40);

  // Timing subscore
  let timeScore;
  if (entry.hodTime === "session") timeScore = 90;
  else if (entry.hodTime === "mixed") timeScore = 50;
  else timeScore = 15; // premarket

  // Weights: HOD 50%, fade 25%, time 25%
  let score = Math.round((hodScore * 0.50 + fadeScore * 0.25 + timeScore * 0.25));
  score = Math.max(0, Math.min(100, score));

  // Black swan override: avg HOD >= 300% with high fades = still HOT tape,
  // but flag it as a potential trap day. Extreme moves dominate regardless of fade.
  const BLACK_SWAN_HOD = 300;
  const isBlackSwan = hod >= BLACK_SWAN_HOD && fade > t.fadeCold;

  // State logic — premarket is a RISK FLAG, not an auto-downgrade.
  // Category is chosen from HOD + fade; premarket just adds a warning badge.
  let state;
  if (isBlackSwan) {
    // Extreme tape — classify HOT regardless of fades
    state = "HOT";
  } else if (hod >= t.hodHot && fade <= t.fadeHot && entry.hodTime === "session") {
    state = "HOT";
  } else if (hod < t.hodNeutralLo || fade > t.fadeCold) {
    state = "COLD";
  } else if (hod >= t.hodHot && fade <= t.fadeCold) {
    state = entry.hodTime === "premarket" ? "NEUTRAL" : "HOT";
  } else {
    state = "NEUTRAL";
  }

  // Premarket applies a small score penalty but doesn't force COLD
  if (entry.hodTime === "premarket") {
    score = Math.max(0, score - 10);
  }

  return {
    score,
    state,
    isBlackSwan,
    sub: { hodScore: Math.round(hodScore), fadeScore: Math.round(fadeScore), timeScore },
  };
}

// Compute the current streak (consecutive days ending today with same state).
function computeStreak(entries) {
  if (!entries || entries.length === 0) return { state: "EMPTY", count: 0 };
  const sorted = [...entries].sort((a, b) => (a.date < b.date ? 1 : -1));
  const currentState = sorted[0].state;
  let count = 0;
  for (const e of sorted) {
    if (e.state === currentState) count++;
    else break;
  }
  return { state: currentState, count };
}

// Trading rules per state — copy sourced from reviewed reference
const RULES = {
  HOT: {
    label: "AGGRESSIVE",
    tagline: "Press A+ setups with conviction",
    color: "hot",
    bullets: [
      "Press A+ setups with conviction",
      "Allow runners — trail, don't exit early",
      "Add with structure on HOD clearouts",
      "Session HODs are buyable — wait for volume confirm",
    ],
  },
  NEUTRAL: {
    label: "SELECTIVE",
    tagline: "One name, quicker profits",
    color: "neutral",
    bullets: [
      "One name focus only",
      "Take profits quicker at first PT",
      "Tighter stops — no adding into weakness",
      "Check HOD time before any entry",
    ],
  },
  COLD: {
    label: "DEFENSIVE",
    tagline: "A+ only — if it's not obvious, sit out",
    color: "cold",
    bullets: [
      "A+ only — if it's not obvious, sit out",
      "Minimum size on every trade",
      "Fastest exits — no runners today",
      "Premarket HOD = distribution trap, avoid",
    ],
  },
  EMPTY: {
    label: "NO DATA",
    tagline: "Log today's metrics",
    color: "neutral",
    bullets: ["Enter today's readings to calibrate."],
  },
};

Object.assign(window, { computeHeat, computeStreak, RULES, DEFAULT_THRESHOLDS });
