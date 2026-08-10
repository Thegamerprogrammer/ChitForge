import React, { useMemo, useState } from 'react';
import { createLiquidGlassMap } from './liquidGlass.js';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { WorldMap } from './map.jsx';
import { loadStoredKey, saveApiKey, clearStoredKey } from './state.js';
import { generateFollowUp, generateMission, regenerateChit, lengthInfo } from './generation.js';
import { discoverGeminiModels, refreshModelCapabilities, MODEL_SELECTION_MODES } from './gemini.js';
import { validateMissionInputs } from './validation.js';
import { downloadBrief } from './export.js';
import { renderMarkdownBold } from './format.js';
import { POI_TYPES } from './validation.js';
import { domainFromUrl } from './sourceValidation.js';

const defaultSliders = { aggression: 0, controversy: 0, diplomacy: 0, length: 0 };
const modes = [
  ['selected_global', 'Selected + Global Research', 'Selected countries are primary targets; AI may add stronger agenda-relevant targets.'],
  ['selected_only', 'Selected Targets Only', 'Use only countries selected on the real world map.'],
];
const progressStages = ['INITIALIZING', 'READING AGENDA', 'ANALYZING PORTFOLIO', 'ANALYZING FOREIGN POLICY', 'MAPPING TARGETS', 'RESEARCHING EVIDENCE', 'ANALYZING LEGAL FRAMEWORKS', 'GENERATING POIs', 'VALIDATING STRUCTURE', 'FACT CHECK PASS 1', 'FACT CHECK PASS 2', 'CALCULATING PRESSURE', 'FINALIZING CHITS', 'PREPARING DOCX'];

function App() {
  const stored = useMemo(() => loadStoredKey(), []);
  const [form, setForm] = useState({ committee: '', agenda: '', portfolio: '', apiKey: stored.key, rememberKey: stored.rememberKey });
  const [showKey, setShowKey] = useState(false);
  const [sliders, setSliders] = useState(defaultSliders);
  const [poiCount, setPoiCount] = useState(5);
  const [selected, setSelected] = useState([]);
  const [mode, setMode] = useState('selected_global');
  const [includeFollowUp, setIncludeFollowUp] = useState(false);
  const [poiTypes, setPoiTypes] = useState(['AUTO']);
  const [activity, setActivity] = useState([]);
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
  const [customBackground, setCustomBackground] = useState('');

  const updateForm = (key, value) => {
    const next = { ...form, [key]: value };
    setForm(next);
    if (key === 'apiKey' || key === 'rememberKey') saveApiKey(next.apiKey, next.rememberKey);
    if (key === 'apiKey') { setModelCatalog(null); setManualModelId(''); setModelInfo(null); }
  };

  const showError = (err) => setError({ message: err.message || 'Generation failed. Please try again.', diagnostic: err.diagnostic, status: err.status, category: err.category });
  const pushProgress = (next) => { setStatus(next); setActivity((items) => [{ time: new Date().toLocaleTimeString(), stage: next.stage, detail: next.detail, done: next.done, total: next.total }, ...items].slice(0, 14)); };

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
      setActivity([]);
      const result = await generateMission({ form, sliders, selectedTargets: selected, targetingMode: mode, includeFollowUp, poiCount, poiTypes, onProgress: pushProgress, modelSelection });
      setPortfolioProfile(result.portfolioProfile);
      setRecommendations(result.recommendedTargets || []);
      setChits(result.chits);
      setModelInfo(result.modelInfo || null);
      if (result.chits.length < poiCount && mode !== 'selected_only') setError({ message: `${result.chits.length} / ${poiCount} POIs generated. Gemini did not return enough distinct, defensible POIs after retry attempts. No duplicates were inserted.` });
      if (!result.chits.length) setError({ message: mode === 'selected_only' && !selected.length ? 'Selected Targets Only needs at least one selected target. Zero selected targets is valid in Selected + Global Research mode.' : 'No defensible targets were discovered. Try Selected + Global Research or refine the agenda.' });
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
      const updated = await generateFollowUp({ form, sliders, chit: chits[index], apiKey: form.apiKey, onProgress: pushProgress, modelSelection });
      setChits((items) => items.map((item, i) => (i === index ? updated : item)));
    } catch (err) { showError(err); }
    finally { setBusy(false); setStatus(null); }
  };

  const regenerateOne = async (index) => {
    setBusy(true);
    try {
      const updated = await regenerateChit({ form, sliders, chit: chits[index], existingChits: chits.filter((_, i) => i !== index), apiKey: form.apiKey, includeFollowUp, onProgress: pushProgress, modelSelection });
      setChits((items) => items.map((item, i) => (i === index ? updated : item)));
    } catch (err) { showError(err); }
    finally { setBusy(false); setStatus(null); }
  };

  const copyText = (text) => navigator.clipboard?.writeText(text).catch(() => setError({ message: 'Clipboard access was blocked by the browser.' }));
  const copyAll = () => copyText(chits.map((chit, index) => `POI ${index + 1} — ${chit.target}\n${chit.poi}`).join('\n\n'));
  const exportBrief = (items = chits) => {
    try { pushProgress({ stage: 'PREPARING DOCX', detail: 'Preparing professional DOCX tactical brief.', done: items.length, total: items.length || 1 }); downloadBrief({ form, sliders, portfolioProfile, chits: items, poiCount, selectedTargets: selected, modelInfo, targetMode: mode }); }
    catch { setError({ message: 'DOCX export failed. Please try again in a modern browser.' }); }
  };

  return <>
    <LiquidGlassFilters />
    <div className="ambientBackdrop" style={customBackground ? { '--custom-background': `url(${customBackground})` } : undefined} />
    <header className="hero glass-panel">
      <div><span className="eyebrow">Diplomatic Intelligence Terminal</span><h1>ChitForge</h1><p>Portfolio intelligence → pressure-point discovery → defensible MUN POI arrays.</p></div>
      <div className="heroActions"><label className="backgroundPicker">Custom background<input type="file" accept="image/*" onChange={(e) => { const file = e.target.files?.[0]; if (file) setCustomBackground(URL.createObjectURL(file)); }} /></label><button onClick={() => setCustomBackground('')} disabled={!customBackground}>Reset Background</button><button onClick={() => exportBrief()} disabled={!chits.length}>Download Tactical Brief (.docx)</button></div>
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
            {(modelCatalog?.compatible || []).map((m) => <option key={m.id} value={m.id}>{m.displayName} — ✓ Text generation · JSON recovery</option>)}
          </select>}
          <div className="row"><button type="button" onClick={() => refreshModels(false)} disabled={modelLoading}>{modelLoading ? 'Refreshing…' : 'Refresh Models'}</button><button type="button" onClick={() => refreshModels(true)} disabled={modelLoading}>Refresh Model Capabilities</button></div>
          <ModelStatus modelInfo={modelInfo} modelCatalog={modelCatalog} modelMode={modelMode} />
        </div>
        <h2>Targeting Mode</h2>
        <div className="modes">{modes.map(([id, label, help]) => <label key={id} className="mode"><input type="radio" checked={mode === id} onChange={() => setMode(id)} /> <b>{label}</b><small>{help}</small></label>)}</div>
        <label>POIs to Generate<input type="number" min="1" max="20" value={poiCount} onChange={(e) => setPoiCount(Math.max(1, Math.min(20, Number(e.target.value) || 1)))} /></label>
        <label className="check"><input type="checkbox" checked={includeFollowUp} onChange={(e) => setIncludeFollowUp(e.target.checked)} /> Generate Follow-Up</label>
        <h2>POI Type</h2>
        <div className="typeGrid" role="group" aria-label="POI type selection">{POI_TYPES.map((type) => <label key={type} className={`typeChip ${poiTypes.includes(type) ? 'active' : ''}`}>
          <input type="checkbox" checked={poiTypes.includes(type)} onChange={() => setPoiTypes((current) => {
            if (type === 'AUTO') return ['AUTO'];
            const withoutAuto = current.filter((item) => item !== 'AUTO');
            const next = withoutAuto.includes(type) ? withoutAuto.filter((item) => item !== type) : [...withoutAuto, type];
            return next.length ? next : ['AUTO'];
          })} /> {type}
        </label>)}</div>

        <div className="notice"><b>TARGETS: OPTIONAL</b><br />{selected.length ? `${selected.length} manual target(s) selected.` : 'GLOBAL RESEARCH ENABLED unless Selected Targets Only is used.'}</div>
        {Object.keys(sliders).map((key) => { const info = key === 'length' ? lengthInfo(sliders.length) : null; return <label key={key} className="slider" style={{ '--value': `${sliders[key]}%` }}><span>{key}<b>{sliders[key]}%</b></span>{info && <small>{info.lines}<br />{info.words}</small>}<input type="range" min="0" max="100" value={sliders[key]} onChange={(e) => setSliders({ ...sliders, [key]: Number(e.target.value) })} /></label>; })}
        <button className="primary" onClick={runGeneration} disabled={busy}>{busy ? 'Synthesizing Tactical POIs…' : 'Generate Tactical POI Array'}</button>
        {error && <ErrorBox error={error} />}
      </section>
      <section className="panel mapPanel"><h2>Real World Target Map</h2><WorldMap selected={selected} setSelected={setSelected} portfolio={form.portfolio} /></section>
      <aside className="panel queue glass-sidebar"><details className="settingsPanel" open><summary>Generation Settings</summary><div className="settingsGrid"><span>POI Count<b>{poiCount}</b></span><span>POI Type<b>{poiTypes.join(', ')}</b></span><span>Target Mode<b>{mode}</b></span><span>Follow-ups<b>{includeFollowUp ? 'ON' : 'OFF'}</b></span><span>Model<b>{modelInfo?.model?.displayName || modelMode}</b></span><span>Aggression<b>{sliders.aggression}</b></span><span>Controversy<b>{sliders.controversy}</b></span><span>Diplomacy<b>{sliders.diplomacy}</b></span><span>Length<b>{sliders.length}</b></span></div></details><h2>Selected Targets</h2>{selected.length ? selected.map((c) => <button key={c.iso} className="pill" onClick={() => setSelected(selected.filter((x) => x.iso !== c.iso))}>{c.name}<span>{c.iso}</span>×</button>) : <p className="muted">No manual targets selected. Auto-discovery can generate anyway.</p>}<button onClick={() => setSelected([])}>Clear selections</button>{recommendations.length > 0 && <><h2>AI Recommended Targets</h2>{recommendations.map((target) => <div className="recommendation" key={`${target.name}-${target.reason}`}><b>{target.name}</b><small>{target.reason}</small></div>)}</>}{(busy || status) && <ProgressPanel status={status} poiCount={poiCount} activity={activity} />}</aside>
    </main>
    {portfolioProfile && <PortfolioIntel profile={portfolioProfile} />}
    {chits.length > 0 && <section className="poiWindow"><div className="arrayHeader"><div><span className="eyebrow">CHITFORGE</span><h2>TACTICAL POI ARRAY</h2><strong>{chits.length} / {poiCount} POIs GENERATED</strong>{modelInfo?.model && <strong>MODEL: {modelInfo.model.displayName}</strong>}<strong>FACT CHECK: 2-PASS</strong></div><div className="actions"><button onClick={copyAll}>Copy All</button><button onClick={() => exportBrief()}>Download DOCX</button><button onClick={runGeneration} disabled={busy}>Regenerate All</button></div></div><div className="chits">{chits.map((chit, i) => <ChitCard key={`${chit.target}-${i}-${chit.poi}`} chit={chit} number={i + 1} onCopy={copyText} onExport={() => exportBrief([chit])} onFollowUp={() => addFollowUp(i)} onRegenerate={() => regenerateOne(i)} />)}</div></section>}
  </>;
}

function ModelStatus({ modelInfo, modelCatalog, modelMode }) {
  const active = modelInfo?.model || modelCatalog?.compatible?.[0];
  return <div className="modelStatus"><b>AI ENGINE</b>{active ? <><p>{modelInfo?.fallbackLog?.length ? '↻' : '●'} {active.displayName}</p><small>{modelMode === MODEL_SELECTION_MODES.BEST ? 'BEST AVAILABLE' : modelMode === MODEL_SELECTION_MODES.ROTATION ? 'SMART ROTATION' : 'MANUAL'} · {active.compatibilityStatus}</small>{modelInfo?.fallbackLog?.length > 0 && <small>Fallback from unavailable model</small>}</> : <small>Models are discovered after you enter one Gemini API key.</small>}{modelCatalog?.all?.length > 0 && <details><summary>Compatible models</summary>{modelCatalog.all.map((m) => <p key={m.id} className={m.structuredJson ? 'pass' : 'warn'}>{m.displayName} — {m.compatibilityStatus} — {Math.round(m.priority)} pts</p>)}</details>}</div>;
}

function ErrorBox({ error }) {
  return <div className="error"><b>{error.category ? 'GEMINI ERROR' : 'MISSION ERROR'}</b><p>{error.message}</p>{import.meta.env.DEV && error.diagnostic && <pre>{error.diagnostic}</pre>}</div>;
}

function ProgressPanel({ status, poiCount, activity }) {
  const currentIndex = Math.max(0, progressStages.indexOf(status?.stage));
  const pct = Math.round(((currentIndex + (status?.done && status?.total ? status.done / status.total : 0.35)) / progressStages.length) * 100);
  return <div className="progress glass-progress" aria-live="polite"><span className="eyebrow">CHITFORGE</span><h2>SYNTHESIS ENGINE</h2><strong>{status?.stage || 'INITIALIZING'}</strong><small>{status?.detail || 'Preparing tactical synthesis.'}</small><div className="bar"><i style={{ width: `${Math.min(100, pct)}%` }} /></div><b>{Math.min(100, pct)}%</b><p>POI {Math.min(status?.done || 0, status?.total || poiCount)} / {status?.total || poiCount}</p><div className="stageList">{progressStages.map((stage, index) => <span key={stage} className={index < currentIndex ? 'complete' : index === currentIndex ? 'active' : 'pending'}>{index < currentIndex ? '✓' : index === currentIndex ? '→' : '○'} {String(index + 1).padStart(2, '0')} {stage}</span>)}</div><div className="activityFeed">{activity.map((item, idx) => <p key={`${item.time}-${idx}`}><time>{item.time}</time> <span>{idx === 0 ? '→' : '✓'}</span> {item.detail || item.stage}</p>)}</div></div>;
}

function PortfolioIntel({ profile }) {
  return <section className="panel intel glass-panel"><h2>Portfolio Intelligence</h2><p>{profile.summary}</p>{(profile.statements || []).map((statement, idx) => <div className="sourceCard" key={idx}><StatusBadge status={statement.status || 'MANUAL VERIFICATION'} /><p>{statement.text || statement.claim || statement}</p>{(statement.sources || profile.sources || []).slice(0, 2).map((source, i) => <SourceCard source={source} key={`${source.url}-${i}`} />)}</div>)}<div className="intelGrid">{(profile.interests || []).map((item) => <span key={item}>{item}</span>)}</div></section>;
}


function StatusBadge({ status }) {
  const normalized = String(status || 'PENDING').toUpperCase().replace(/_/g, ' ');
  const symbol = normalized === 'VERIFIED' ? '✓' : normalized === 'FAILED' ? '✕' : normalized === 'PENDING' ? '○' : '⚠';
  return <span className={`statusBadge ${normalized.toLowerCase().replace(/\s+/g, '-')}`}>{symbol} {normalized}</span>;
}

function SourceCard({ source }) {
  const domain = source.domain || domainFromUrl(source.url);
  return <div className="sourceCard glass-source-card"><div><b>SOURCE</b><h3>{source.sourceName || 'Manual verification source'}</h3><p>Organization: {source.organization || 'MANUAL VERIFICATION'}<br />Published: {source.publicationDate || 'MANUAL VERIFICATION'}</p></div><div><b>STATUS</b><StatusBadge status={source.status || 'MANUAL VERIFICATION'} /><p><b>SOURCE QUALITY</b><br />{source.quality || 'LIMITED'}</p></div><p><b>CLAIM SUPPORTED</b><br />{source.claimSupported || source.claim || 'MANUAL VERIFICATION: claim support must be checked.'}</p>{source.url && <a className="sourceLink" href={source.url} target="_blank" rel="noreferrer">OPEN SOURCE ↗ {domain && <small>{domain}</small>}</a>}{source.verificationReason && <small>{source.verificationReason}</small>}</div>;
}

function ChitCard({ chit, number, onCopy, onFollowUp, onRegenerate }) {
  const full = JSON.stringify(chit, null, 2);
  return <article className="chit glassCard">
    <div className="chitHead"><b>POI #{number}</b><span>{chit.classification || chit.pressureProfile?.classification}</span></div>
    <p className="targetLine">TARGET: <strong>{chit.target}</strong></p>
    <blockquote className="poiQuestion" dangerouslySetInnerHTML={{ __html: `“${renderMarkdownBold(chit.poi)}”` }} />
    <section className="metrics"><span>{chit.wordCount} WORDS</span><span>{chit.estimatedLines} </span><span>~{chit.estimatedSeconds} SEC</span><span>PRESSURE {chit.pressureScore ?? chit.pressureProfile?.score}/100</span><span>AGGRESSION {chit.pressureProfile?.aggression}%</span><span>CONTROVERSY {chit.pressureProfile?.controversy}%</span><span>DIPLOMACY {chit.pressureProfile?.diplomacy}%</span><span>LENGTH {chit.pressureProfile?.length}%</span></section>
    <div className="accordion"><details><summary>Legal Foundation</summary><p>{chit.legalFoundation || chit.legalPolicyFoundation}</p></details><details><summary>Evidence & Sources</summary>{(chit.evidence || []).map((e, idx) => <SourceCard source={e} key={`${e.url}-${idx}`} />)}</details><details><summary>Documented Issue</summary><p><b>Portfolio position:</b> {chit.pressurePoint?.portfolioPosition}</p><p><b>Target position/action:</b> {chit.pressurePoint?.targetPositionAction}</p><p><b>Conflict:</b> {chit.pressurePoint?.conflict}</p><p><b>Agenda relevance:</b> {chit.pressurePoint?.agendaRelevance}</p></details><details><summary>Tactical Impact</summary><p>{chit.tacticalImpact}</p><div className="tags">{(chit.legalTacticalTypes || []).map((type) => <span key={type}>{type}</span>)}<span>{chit.classificationReason}</span></div></details><details><summary>Verification</summary><StatusBadge status={chit.factCheck?.status || 'PENDING'} /><p><b>Legal:</b> {chit.factCheck?.legalAssessment?.status || 'UNCERTAIN'} — {chit.factCheck?.legalAssessment?.reason}</p><p><b>Classification:</b> {chit.factCheck?.classificationAssessment?.status || 'UNCERTAIN'} — {chit.factCheck?.classificationAssessment?.reason}</p></details><details open={!!chit.followUp}><summary>Follow-up</summary>{chit.followUp ? <><p><b>Expected evasion:</b> {chit.followUp.expectedEvasion}</p><p><b>Follow-up:</b> {chit.followUp.question}</p></> : <p className="muted">No follow-up generated yet.</p>}</details></div>
    <div className="actions"><button onClick={() => onCopy(chit.poi)}>Copy POI</button><button onClick={() => onCopy(full)}>Copy Full</button><button onClick={onRegenerate}>Regenerate</button><button onClick={onFollowUp}>Generate Follow-up</button></div>
  </article>;
}


function LiquidGlassFilters() {
  const filters = useMemo(() => {
    if (typeof document === 'undefined') return [];
    return [
      ['liquid-glass-filter-panel', createLiquidGlassMap({ width: 420, height: 260, bezelWidth: 42, glassThickness: 34, surface: 'convex-squircle', specularSaturation: 6 })],
      ['liquid-glass-filter-button', createLiquidGlassMap({ width: 180, height: 64, bezelWidth: 22, glassThickness: 22, surface: 'convex-squircle', specularSaturation: 8 })],
      ['liquid-glass-filter-input', createLiquidGlassMap({ width: 320, height: 58, bezelWidth: 20, glassThickness: 18, surface: 'convex-squircle', specularSaturation: 5 })],
      ['liquid-glass-filter-switch', createLiquidGlassMap({ width: 72, height: 40, bezelWidth: 18, glassThickness: 18, surface: 'lip', specularSaturation: 7 })],
    ];
  }, []);

  return <svg className="liquidFilterSvg" width="0" height="0" aria-hidden="true" focusable="false" colorInterpolationFilters="sRGB">
    <defs>{filters.map(([id, map]) => <filter key={id} id={id} x="0" y="0" width={map.width} height={map.height} filterUnits="objectBoundingBox" primitiveUnits="userSpaceOnUse">
      <feImage href={map.href} x="0" y="0" width={map.width} height={map.height} preserveAspectRatio="none" result="displacement_map" />
      <feDisplacementMap in="SourceGraphic" in2="displacement_map" scale={map.scale} xChannelSelector="R" yChannelSelector="G" result="refracted" />
      <feImage href={map.href} x="0" y="0" width={map.width} height={map.height} preserveAspectRatio="none" result="specular_map" />
      <feColorMatrix in="specular_map" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 1.9 -0.9 0" result="specular" />
      <feBlend in="refracted" in2="specular" mode="screen" />
    </filter>)}</defs>
  </svg>;
}

createRoot(document.getElementById('root')).render(<App />);

