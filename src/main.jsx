import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { WorldMap } from './map.jsx';
import { loadStoredKey, saveApiKey, clearStoredKey } from './state.js';
import { generateFollowUp, generateMission, regenerateChit } from './generation.js';
import { discoverGeminiModels, refreshModelCapabilities, MODEL_SELECTION_MODES } from './gemini.js';
import { validateMissionInputs } from './validation.js';
import { downloadBrief } from './export.js';
import { renderMarkdownBold } from './format.js';

const defaultSliders = { aggression: 0, controversy: 0, diplomacy: 0, length: 0 };
const modes = [
  ['hybrid', 'Hybrid', 'AI recommends targets; you can approve/remove map selections.'],
  ['automatic', 'Automatic', 'AI chooses agenda-relevant targets when none are selected.'],
  ['manual', 'Manual', 'Use only countries selected on the real world map.'],
];
const progressStages = ['RESEARCHING PORTFOLIO', 'ANALYZING TARGETS', 'IDENTIFYING PRESSURE POINTS', 'GENERATING POIs', 'VALIDATING EVIDENCE', 'FINALIZING TACTICAL BRIEF'];

function App() {
  const stored = useMemo(() => loadStoredKey(), []);
  const [form, setForm] = useState({ committee: '', agenda: '', portfolio: '', apiKey: stored.key, rememberKey: stored.rememberKey });
  const [showKey, setShowKey] = useState(false);
  const [sliders, setSliders] = useState(defaultSliders);
  const [poiCount, setPoiCount] = useState(5);
  const [selected, setSelected] = useState([]);
  const [mode, setMode] = useState('hybrid');
  const [includeFollowUp, setIncludeFollowUp] = useState(false);
  const [portfolioProfile, setPortfolioProfile] = useState(null);
  const [recommendations, setRecommendations] = useState([]);
  const [chits, setChits] = useState([]);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [modelMode, setModelMode] = useState(MODEL_SELECTION_MODES.BEST);
  const [manualModelId, setManualModelId] = useState('');
  const [modelCatalog, setModelCatalog] = useState(null);
  const [modelInfo, setModelInfo] = useState(null);
  const [modelLoading, setModelLoading] = useState(false);

  const updateForm = (key, value) => {
    const next = { ...form, [key]: value };
    setForm(next);
    if (key === 'apiKey' || key === 'rememberKey') saveApiKey(next.apiKey, next.rememberKey);
    if (key === 'apiKey') { setModelCatalog(null); setManualModelId(''); setModelInfo(null); }
  };

  const showError = (err) => setError({ message: err.message || 'Generation failed. Please try again.', diagnostic: err.diagnostic, status: err.status, category: err.category });

  const modelSelection = { modelMode, manualModelId };
  const refreshModels = async (verify = false) => {
    if (!form.apiKey.trim()) { setError({ message: 'Missing Gemini API key. Enter your key and try again.' }); return; }
    setModelLoading(true); setError(null);
    try {
      const catalog = verify ? await refreshModelCapabilities(form.apiKey, { force: true }) : await discoverGeminiModels(form.apiKey, { force: true });
      setModelCatalog(catalog);
      if (!manualModelId && catalog.compatible[0]) setManualModelId(catalog.compatible[0].id);
    } catch (err) { showError(err); }
    finally { setModelLoading(false); }
  };

  const runGeneration = async () => {
    const validation = validateMissionInputs({ ...form, poiCount });
    setError(validation ? { message: validation } : null);
    if (validation) return;
    setBusy(true);
    setChits([]);
    setRecommendations([]);
    try {
      const result = await generateMission({ form, sliders, selectedTargets: selected, targetingMode: mode, includeFollowUp, poiCount, onProgress: setStatus, modelSelection });
      setPortfolioProfile(result.portfolioProfile);
      setRecommendations(result.recommendedTargets || []);
      setChits(result.chits);
      setModelInfo(result.modelInfo || null);
      if (result.chits.length < poiCount && mode !== 'manual') setError({ message: `${result.chits.length} / ${poiCount} POIs generated. Gemini did not return enough distinct, defensible POIs after retry attempts. No duplicates were inserted.` });
      if (!result.chits.length) setError({ message: mode === 'manual' && !selected.length ? 'Manual mode needs at least one selected target. Zero selected targets is valid in Hybrid or Automatic mode.' : 'No defensible targets were discovered. Try Hybrid or Manual mode, or refine the agenda.' });
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
      setStatus(null);
    }
  };

  const addFollowUp = async (index) => {
    setBusy(true);
    try {
      const updated = await generateFollowUp({ form, sliders, chit: chits[index], apiKey: form.apiKey, onProgress: setStatus, modelSelection });
      setChits((items) => items.map((item, i) => (i === index ? updated : item)));
    } catch (err) { showError(err); }
    finally { setBusy(false); setStatus(null); }
  };

  const regenerateOne = async (index) => {
    setBusy(true);
    try {
      const updated = await regenerateChit({ form, sliders, chit: chits[index], existingChits: chits.filter((_, i) => i !== index), apiKey: form.apiKey, includeFollowUp, onProgress: setStatus, modelSelection });
      setChits((items) => items.map((item, i) => (i === index ? updated : item)));
    } catch (err) { showError(err); }
    finally { setBusy(false); setStatus(null); }
  };

  const copyText = (text) => navigator.clipboard?.writeText(text).catch(() => setError({ message: 'Clipboard access was blocked by the browser.' }));
  const copyAll = () => copyText(chits.map((chit, index) => `POI ${index + 1} — ${chit.target}\n${chit.poi}`).join('\n\n'));
  const exportBrief = (items = chits) => {
    try { downloadBrief({ form, sliders, portfolioProfile, chits: items, poiCount, selectedTargets: selected }); }
    catch { setError({ message: 'DOCX export failed. Please try again in a modern browser.' }); }
  };

  return <>
    <header className="hero">
      <div><span className="eyebrow">Diplomatic Intelligence Terminal</span><h1>ChitForge</h1><p>Portfolio intelligence → pressure-point discovery → defensible MUN POI arrays.</p></div>
      <button onClick={() => exportBrief()} disabled={!chits.length}>Download Tactical Brief (.docx)</button>
    </header>
    <main className="layout">
      <section className="panel controls">
        <h2>Mission Parameters</h2>
        <label>Committee<input value={form.committee} onChange={(e) => updateForm('committee', e.target.value)} placeholder="e.g. ECOFIN" /></label>
        <label>Agenda / Topic<textarea value={form.agenda} onChange={(e) => updateForm('agenda', e.target.value)} placeholder="e.g. Sovereign debt restructuring and development finance" /></label>
        <label>Portfolio / Country<input value={form.portfolio} onChange={(e) => updateForm('portfolio', e.target.value)} placeholder="e.g. Indonesia or IDN" /></label>
        <label>Gemini API Key<div className="keyRow"><input type={showKey ? 'text' : 'password'} autoComplete="off" value={form.apiKey} onChange={(e) => updateForm('apiKey', e.target.value)} placeholder="Stored for this session by default" /><button type="button" onClick={() => setShowKey(!showKey)}>{showKey ? 'Hide' : 'Show'}</button></div></label>
        <div className="row"><label className="check"><input type="checkbox" checked={form.rememberKey} onChange={(e) => updateForm('rememberKey', e.target.checked)} /> Save beyond this session</label><button onClick={() => { clearStoredKey(); setForm({ ...form, apiKey: '', rememberKey: false }); }}>Clear Key</button></div>

        <h2>AI Model</h2>
        <div className="modelBox" onFocus={() => !modelCatalog && form.apiKey.trim() && refreshModels(false)}>
          <select value={modelMode} onChange={(e) => setModelMode(e.target.value)}>
            <option value={MODEL_SELECTION_MODES.BEST}>✨ Best Available</option>
            <option value={MODEL_SELECTION_MODES.ROTATION}>Smart Rotation</option>
            <option value={MODEL_SELECTION_MODES.MANUAL}>Manual</option>
          </select>
          {modelMode === MODEL_SELECTION_MODES.MANUAL && <select value={manualModelId} onChange={(e) => setManualModelId(e.target.value)} onFocus={() => !modelCatalog && refreshModels(false)}>
            {(modelCatalog?.compatible || []).map((m) => <option key={m.id} value={m.id}>{m.displayName} — ✓ Structured JSON {m.verified ? 'Verified' : 'API Verified'}</option>)}
          </select>}
          <div className="row"><button type="button" onClick={() => refreshModels(false)} disabled={modelLoading}>{modelLoading ? 'Refreshing…' : 'Refresh Models'}</button><button type="button" onClick={() => refreshModels(true)} disabled={modelLoading}>Refresh Model Capabilities</button></div>
          <ModelStatus modelInfo={modelInfo} modelCatalog={modelCatalog} modelMode={modelMode} />
        </div>
        <h2>Targeting Mode</h2>
        <div className="modes">{modes.map(([id, label, help]) => <label key={id} className="mode"><input type="radio" checked={mode === id} onChange={() => setMode(id)} /> <b>{label}</b><small>{help}</small></label>)}</div>
        <label>POIs to Generate<input type="number" min="1" max="20" value={poiCount} onChange={(e) => setPoiCount(Math.max(1, Math.min(20, Number(e.target.value) || 1)))} /></label>
        <label className="check"><input type="checkbox" checked={includeFollowUp} onChange={(e) => setIncludeFollowUp(e.target.checked)} /> Generate Follow-Up</label>
        <div className="notice"><b>TARGETS: OPTIONAL</b><br />{selected.length ? `${selected.length} manual target(s) selected.` : 'AUTO-DISCOVERY ENABLED when Automatic or Hybrid mode is used.'}</div>
        {Object.keys(sliders).map((key) => <label key={key} className="slider"><span>{key}<b>{sliders[key]}%</b></span><input type="range" min="0" max="100" value={sliders[key]} onChange={(e) => setSliders({ ...sliders, [key]: Number(e.target.value) })} /></label>)}
        <button className="primary" onClick={runGeneration} disabled={busy}>{busy ? 'Synthesizing Tactical POIs…' : 'Generate Tactical POI Array'}</button>
        {error && <ErrorBox error={error} />}
      </section>
      <section className="panel mapPanel"><h2>Real World Target Map</h2><WorldMap selected={selected} setSelected={setSelected} portfolio={form.portfolio} /></section>
      <aside className="panel queue"><h2>Selected Targets</h2>{selected.length ? selected.map((c) => <button key={c.iso} className="pill" onClick={() => setSelected(selected.filter((x) => x.iso !== c.iso))}>{c.name}<span>{c.iso}</span>×</button>) : <p className="muted">No manual targets selected. Auto-discovery can generate anyway.</p>}<button onClick={() => setSelected([])}>Clear selections</button>{recommendations.length > 0 && <><h2>AI Recommended Targets</h2>{recommendations.map((target) => <div className="recommendation" key={`${target.name}-${target.reason}`}><b>{target.name}</b><small>{target.reason}</small></div>)}</>}{(busy || status) && <ProgressPanel status={status} poiCount={poiCount} />}</aside>
    </main>
    {portfolioProfile && <section className="panel intel"><h2>Portfolio Intelligence Summary</h2><p>{portfolioProfile.summary}</p><div className="intelGrid">{(portfolioProfile.interests || []).map((item) => <span key={item}>{item}</span>)}</div></section>}
    {chits.length > 0 && <section className="poiWindow"><div className="arrayHeader"><div><span className="eyebrow">CHITFORGE</span><h2>TACTICAL POI ARRAY</h2><strong>{chits.length} / {poiCount} POIs GENERATED</strong></div><div className="actions"><button onClick={copyAll}>Copy All</button><button onClick={() => exportBrief()}>Download DOCX</button><button onClick={runGeneration} disabled={busy}>Regenerate All</button></div></div><div className="chits">{chits.map((chit, i) => <ChitCard key={`${chit.target}-${i}-${chit.poi}`} chit={chit} number={i + 1} onCopy={copyText} onExport={() => exportBrief([chit])} onFollowUp={() => addFollowUp(i)} onRegenerate={() => regenerateOne(i)} />)}</div></section>}
  </>;
}

function ModelStatus({ modelInfo, modelCatalog, modelMode }) {
  const active = modelInfo?.model || modelCatalog?.compatible?.[0];
  return <div className="modelStatus"><b>AI ENGINE</b>{active ? <><p>{modelInfo?.fallbackLog?.length ? '↻' : '●'} {active.displayName}</p><small>{modelMode === MODEL_SELECTION_MODES.BEST ? 'BEST AVAILABLE' : modelMode === MODEL_SELECTION_MODES.ROTATION ? 'SMART ROTATION' : 'MANUAL'} · {active.compatibilityStatus}</small>{modelInfo?.fallbackLog?.length > 0 && <small>Fallback from unavailable model</small>}</> : <small>Models are discovered after you enter one Gemini API key.</small>}{modelCatalog?.all?.length > 0 && <details><summary>Compatible models</summary>{modelCatalog.all.map((m) => <p key={m.id} className={m.structuredJson ? 'pass' : 'warn'}>{m.displayName} — {m.compatibilityStatus} — {Math.round(m.priority)} pts</p>)}</details>}</div>;
}

function ErrorBox({ error }) {
  return <div className="error"><b>{error.category ? 'GEMINI ERROR' : 'MISSION ERROR'}</b><p>{error.message}</p>{import.meta.env.DEV && error.diagnostic && <pre>{error.diagnostic}</pre>}</div>;
}

function ProgressPanel({ status, poiCount }) {
  const currentIndex = Math.max(0, progressStages.indexOf(status?.stage));
  return <div className="progress"><h2>SYNTHESIZING TACTICAL POIs...</h2>{progressStages.map((stage, index) => <p key={stage} className={index < currentIndex ? 'pass' : index === currentIndex ? 'activeStage' : ''}>{index < currentIndex ? '✓ ' : ''}{stage}{stage === 'GENERATING POIs' && status?.total ? ` ${status.done || 0} / ${status.total || poiCount}` : ''}</p>)}{status?.detail && <small>{status.detail}</small>}</div>;
}

function ChitCard({ chit, number, onCopy, onFollowUp, onRegenerate }) {
  const full = JSON.stringify(chit, null, 2);
  return <article className="chit glassCard">
    <div className="chitHead"><b>POI {String(number).padStart(2, '0')}</b><span>{chit.pressureProfile?.classification}</span></div>
    <p className="targetLine">TARGET: <strong>{chit.target}</strong></p>
    <blockquote className="poiQuestion" dangerouslySetInnerHTML={{ __html: `“${renderMarkdownBold(chit.poi)}”` }} />
    <section className="metrics"><span>{chit.wordCount} WORDS</span><span>~{chit.estimatedSeconds} SEC</span><span>PRESSURE {chit.pressureProfile?.score}/100</span><span>AGGRESSION {chit.pressureProfile?.aggression}%</span><span>CONTROVERSY {chit.pressureProfile?.controversy}%</span><span>DIPLOMACY {chit.pressureProfile?.diplomacy}%</span><span>LENGTH {chit.pressureProfile?.length}%</span></section>
    <div className="accordion"><details><summary>Evidence</summary>{(chit.evidence || []).map((e, idx) => <div className="evidence" key={`${e.url}-${idx}`}><b>Source:</b> {e.title || e.source}<br /><b>Organization:</b> {e.organization || e.publication || 'VERIFICATION REQUIRED'}<br /><b>Date:</b> {e.date || 'VERIFICATION REQUIRED'}<br /><b>URL:</b> {e.url ? <a href={e.url} target="_blank" rel="noreferrer">{e.url}</a> : 'VERIFICATION REQUIRED'}<br /><b>Classification:</b> {e.sourceClassification || e.status || 'VERIFICATION REQUIRED'}<br /><b>Claim:</b> {e.claim}</div>)}</details><details><summary>Legal Foundation</summary><p>{chit.legalPolicyFoundation}</p></details><details><summary>Contradiction</summary><p><b>Portfolio position:</b> {chit.pressurePoint?.portfolioPosition}</p><p><b>Target position/action:</b> {chit.pressurePoint?.targetPositionAction}</p><p><b>Conflict:</b> {chit.pressurePoint?.conflict}</p><p><b>Agenda relevance:</b> {chit.pressurePoint?.agendaRelevance}</p></details><details><summary>Tactical Impact</summary><p>{chit.tacticalImpact}</p><div className="tags">{(chit.legalTacticalTypes || []).map((type) => <span key={type}>{type}</span>)}</div></details><details open={!!chit.followUp}><summary>Follow-up</summary>{chit.followUp ? <><p><b>Expected evasion:</b> {chit.followUp.expectedEvasion}</p><p><b>Follow-up:</b> {chit.followUp.question}</p></> : <p className="muted">No follow-up generated yet.</p>}</details></div>
    <div className="actions"><button onClick={() => onCopy(chit.poi)}>Copy POI</button><button onClick={() => onCopy(full)}>Copy Full</button><button onClick={onRegenerate}>Regenerate</button><button onClick={onFollowUp}>Generate Follow-up</button></div>
  </article>;
}

createRoot(document.getElementById('root')).render(<App />);
