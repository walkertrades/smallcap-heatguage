// Tweaks panel — exposes threshold tuning via the Tweaks toolbar.
const { useState: useState_Tw, useEffect: useEffect_Tw } = React;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "hodHot": 150,
  "hodNeutralLo": 100,
  "fadeHot": 25,
  "fadeCold": 40
}/*EDITMODE-END*/;

function loadTweaks() {
  try {
    const raw = localStorage.getItem("heat_gauge_tweaks_v1");
    if (!raw) return { ...TWEAK_DEFAULTS };
    return { ...TWEAK_DEFAULTS, ...JSON.parse(raw) };
  } catch { return { ...TWEAK_DEFAULTS }; }
}

function TweaksPanel({ visible, tweaks, setTweaks, onClose }) {
  if (!visible) return null;

  const update = (k, v) => {
    const next = { ...tweaks, [k]: Number(v) };
    setTweaks(next);
    localStorage.setItem("heat_gauge_tweaks_v1", JSON.stringify(next));
    window.parent.postMessage({ type: "__edit_mode_set_keys", edits: next }, "*");
  };

  const reset = () => {
    setTweaks({ ...TWEAK_DEFAULTS });
    localStorage.setItem("heat_gauge_tweaks_v1", JSON.stringify(TWEAK_DEFAULTS));
    window.parent.postMessage({ type: "__edit_mode_set_keys", edits: TWEAK_DEFAULTS }, "*");
  };

  return (
    <div className="tweaks-panel">
      <div className="tweaks-header">
        <span className="tweaks-title">TWEAKS · THRESHOLDS</span>
        <button className="linkish" onClick={onClose}>CLOSE</button>
      </div>

      <div className="tweaks-field">
        <label><span>HOT HOD ≥</span><span>{tweaks.hodHot}%</span></label>
        <input type="range" min="80" max="300" step="5" value={tweaks.hodHot}
          onChange={(e) => update("hodHot", e.target.value)} />
      </div>

      <div className="tweaks-field">
        <label><span>NEUTRAL HOD ≥</span><span>{tweaks.hodNeutralLo}%</span></label>
        <input type="range" min="40" max="200" step="5" value={tweaks.hodNeutralLo}
          onChange={(e) => update("hodNeutralLo", e.target.value)} />
      </div>

      <div className="tweaks-field">
        <label><span>HOT FADE ≤</span><span>{tweaks.fadeHot}%</span></label>
        <input type="range" min="10" max="50" step="1" value={tweaks.fadeHot}
          onChange={(e) => update("fadeHot", e.target.value)} />
      </div>

      <div className="tweaks-field">
        <label><span>COLD FADE ≥</span><span>{tweaks.fadeCold}%</span></label>
        <input type="range" min="20" max="70" step="1" value={tweaks.fadeCold}
          onChange={(e) => update("fadeCold", e.target.value)} />
      </div>

      <button className="tweaks-reset" onClick={reset}>RESET DEFAULTS</button>
    </div>
  );
}

function Root() {
  const [tweaks, setTweaks] = useState_Tw(loadTweaks());
  const [tweaksVisible, setTweaksVisible] = useState_Tw(false);

  useEffect_Tw(() => {
    const onMsg = (e) => {
      if (!e.data) return;
      if (e.data.type === "__activate_edit_mode") setTweaksVisible(true);
      else if (e.data.type === "__deactivate_edit_mode") setTweaksVisible(false);
    };
    window.addEventListener("message", onMsg);
    window.parent.postMessage({ type: "__edit_mode_available" }, "*");
    return () => window.removeEventListener("message", onMsg);
  }, []);

  return (
    <>
      <window.App tweaks={tweaks} />
      <TweaksPanel
        visible={tweaksVisible}
        tweaks={tweaks}
        setTweaks={setTweaks}
        onClose={() => setTweaksVisible(false)}
      />
    </>
  );
}

Object.assign(window, { Root });
