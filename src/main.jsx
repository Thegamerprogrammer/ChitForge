import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { WorldMap } from './map.jsx';
import { loadStoredKey, saveApiKey, clearStoredKey } from './state.js';
import { generateFollowUp, generateMission } from './generation.js';
import { validateMissionInputs } from './validation.js';
import { downloadBrief } from './export.js';

const defaultSliders = { aggression: 0, controversy: 0, diplomacy: 0, length: 0 };
const modes = [
  ['hybrid', 'Hybrid', 'AI recommends targets; you can approve/remove map selections.'],
  ['automatic', 'Automatic', 'AI chooses agenda-relevant targets when none are selected.'],
  ['manual', 'Manual', 'Use only countries selected on the real world map.'],
];

function App() {
  const stored = useMemo(() => loadStoredKey(), []);
  const [form, setForm] = useState({ committee: '', agenda: '', portfolio: '', apiKey: stored.key, rememberKey: stored.rememberKey });
  const [sliders, setSliders] = useState(defaultSliders);
  const [selected, setSelected] = useState([]);
  const [mode, setMode] = useState('hybrid');
  const [includeFollowUp, setIncludeFollowUp] = useState(false);
  const [portfolioProfile, setPortfolioProfile] = useState(null);
  const [recommendations, setRecommendations] = useState([]);
  const [chits, setChits] = useState([]);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const updateForm = (key, value) => {
    const next = { ...form, [key]: value };
    setForm(next);
    if (key === 'apiKey' || key === 'rememberKey') saveApiKey(next.apiKey, next.rememberKey);
  };

  const runGeneration = async () => {
    const validation = validateMissionInputs({ ...form, mode });
    setError(validation);
    if (validation) return;
    setBusy(true);
    setChits([]);
    setRecommendations([]);
    try {
      const result = await generateMission({ form, sliders, selectedTargets: selected, targetingMode: mode, includeFollowUp, onProgress: setStatus });
      setPortfolioProfile(result.portfolioProfile);
      setRecommendations(result.recommendedTargets || []);
      setChits(result.chits);
      if (!result.chits.length) setError('No defensible targets were discovered. Try Hybrid or Manual mode, or refine the agenda.');
    } catch (err) {
      setError(err.message || 'Generation failed. Please try again.');
    } finally {
      setBusy(false);
      setStatus('');
    }
  };

  const addFollowUp = async (index) => {
    setBusy(true);
    try {
      const updated = await generateFollowUp({ form, sliders, chit: chits[index], apiKey: form.apiKey, onProgress: setStatus });
      setChits((items) => items.map((item, i) => (i === index ? updated : item)));
    } catch (err) {
      setError(err.message || 'Could not generate follow-up.');
    } finally {
      setBusy(false);
      setStatus('');
    }
  };

  const copyText = (text) => navigator.clipboard?.writeText(text).catch(() => setError('Clipboard access was blocked by the browser.'));
  const exportBrief = (items = chits) => {
    try { downloadBrief({ form, sliders, portfolioProfile, chits: items }); }
    catch { setError('DOCX export failed. Please try again in a modern browser.'); }
  };

  return <>
    <header className="hero">
      <div><span className="eyebrow">Diplomatic Intelligence Terminal</span><h1>ChitForge</h1><p>Portfolio intelligence → pressure-point discovery → defensible MUN POIs.</p></div>
      <button onClick={() => exportBrief()} disabled={!chits.length}>Download Tactical Brief (.docx)</button>
    </header>
    <main className="layout">
      <section className="panel controls">
        <h2>Mission Parameters</h2>
        <label>Committee<input value={form.committee} onChange={(e) => updateForm('committee', e.target.value)} placeholder="e.g. ECOFIN" /></label>
        <label>Agenda / Topic<textarea value={form.agenda} onChange={(e) => updateForm('agenda', e.target.value)} placeholder="e.g. Sovereign debt restructuring and development finance" /></label>
        <label>Portfolio / Country<input value={form.portfolio} onChange={(e) => updateForm('portfolio', e.target.value)} placeholder="e.g. Indonesia or IDN" /></label>
        <label>Gemini API Key<input type="password" autoComplete="off" value={form.apiKey} onChange={(e) => updateForm('apiKey', e.target.value)} placeholder="Stored locally in this browser only" /></label>
        <div className="row"><label className="check"><input type="checkbox" checked={form.rememberKey} onChange={(e) => updateForm('rememberKey', e.target.checked)} /> Remember key</label><button onClick={() => { clearStoredKey(); setForm({ ...form, apiKey: '', rememberKey: false }); }}>Clear API Key</button></div>
        <h2>Targeting Mode</h2>
        <div className="modes">{modes.map(([id, label, help]) => <label key={id} className="mode"><input type="radio" checked={mode === id} onChange={() => setMode(id)} /> <b>{label}</b><small>{help}</small></label>)}</div>
        <label className="check"><input type="checkbox" checked={includeFollowUp} onChange={(e) => setIncludeFollowUp(e.target.checked)} /> Generate Follow-Up</label>
        <div className="notice"><b>TARGETS: OPTIONAL</b><br />{selected.length ? `${selected.length} manual target(s) selected.` : 'AUTO-DISCOVERY ENABLED when Automatic or Hybrid mode is used.'}</div>
        {Object.keys(sliders).map((key) => <label key={key} className="slider"><span>{key}<b>{sliders[key]}%</b></span><input type="range" min="0" max="100" value={sliders[key]} onChange={(e) => setSliders({ ...sliders, [key]: Number(e.target.value) })} /></label>)}
        <button className="primary" onClick={runGeneration} disabled={busy}>{busy ? 'Synthesizing…' : 'Generate Tactical Chits'}</button>
        {error && <div className="error">{error}</div>}
      </section>
      <section className="panel mapPanel"><h2>Real World Target Map</h2><WorldMap selected={selected} setSelected={setSelected} portfolio={form.portfolio} /></section>
      <aside className="panel queue"><h2>Selected Targets</h2>{selected.length ? selected.map((c) => <button key={c.iso} className="pill" onClick={() => setSelected(selected.filter((x) => x.iso !== c.iso))}>{c.name}<span>{c.iso}</span>×</button>) : <p className="muted">No manual targets selected. Auto-discovery can generate anyway.</p>}<button onClick={() => setSelected([])}>Clear selections</button>{recommendations.length > 0 && <><h2>AI Recommended Targets</h2>{recommendations.map((target) => <div className="recommendation" key={target.name}><b>{target.name}</b><small>{target.reason}</small></div>)}</>}{(busy || status) && <div className="progress"><h2>SYNTHESIZING...</h2><p>{status || 'Validating evidence and pressure logic...'}</p></div>}</aside>
    </main>
    {portfolioProfile && <section className="panel intel"><h2>Portfolio Intelligence Summary</h2><p>{portfolioProfile.summary}</p><div className="intelGrid">{(portfolioProfile.interests || []).map((item) => <span key={item}>{item}</span>)}</div></section>}
    <section className="chits">{chits.map((chit, i) => <ChitCard key={`${chit.target}-${i}`} chit={chit} number={i + 1} onCopy={copyText} onExport={() => exportBrief([chit])} onFollowUp={() => addFollowUp(i)} />)}</section>
  </>;
}

function ChitCard({ chit, number, onCopy, onExport, onFollowUp }) {
  const full = JSON.stringify(chit, null, 2);
  return <article className="chit">
    <div className="chitHead"><b>CHIT #{String(number).padStart(2, '0')}</b><span>TARGET: {chit.target}</span><em>{chit.pressureProfile?.classification}</em></div>
    <section><h3>OBJECTIVE</h3><p><b>TARGET:</b> {chit.target}</p></section>
    <section className="pressure"><h3>PRESSURE PROFILE</h3><p>Aggression {chit.pressureProfile?.aggression}% · Controversy {chit.pressureProfile?.controversy}% · Diplomacy {chit.pressureProfile?.diplomacy}% · Length {chit.pressureProfile?.length}%</p><strong>PRESSURE SCORE: {chit.pressureProfile?.score}/100</strong></section>
    <section><h3>POI</h3><blockquote>“{chit.poi}”</blockquote></section>
    <section><h3>LEGAL / POLICY FOUNDATION</h3><p>{chit.legalPolicyFoundation}</p></section>
    <section><h3>EVIDENCE</h3>{(chit.evidence || []).map((e, idx) => <div className="evidence" key={`${e.url}-${idx}`}><b>Source:</b> {e.title || e.source}<br /><b>Organization:</b> {e.organization || e.publication || 'VERIFICATION REQUIRED'}<br /><b>Date:</b> {e.date || 'VERIFICATION REQUIRED'}<br /><b>URL:</b> {e.url ? <a href={e.url} target="_blank" rel="noreferrer">{e.url}</a> : 'VERIFICATION REQUIRED'}<br /><b>Classification:</b> {e.sourceClassification || e.status || 'VERIFICATION REQUIRED'}<br /><b>Claim:</b> {e.claim}</div>)}</section>
    <section><h3>DOCUMENTED PRESSURE POINT</h3><p><b>Portfolio position:</b> {chit.pressurePoint?.portfolioPosition}</p><p><b>Target position/action:</b> {chit.pressurePoint?.targetPositionAction}</p><p><b>Conflict/contradiction:</b> {chit.pressurePoint?.conflict}</p><p><b>Why this matters to the agenda:</b> {chit.pressurePoint?.agendaRelevance}</p></section>
    <section><h3>LEGAL / TACTICAL TYPE</h3><div className="tags">{(chit.legalTacticalTypes || []).map((type) => <span key={type}>{type}</span>)}</div></section>
    <section><h3>TACTICAL IMPACT</h3><p>{chit.tacticalImpact}</p></section>
    {chit.followUp && <section><h3>OPTIONAL FOLLOW-UP</h3><p><b>Expected evasion:</b> {chit.followUp.expectedEvasion}</p><p><b>Follow-up:</b> {chit.followUp.question}</p></section>}
    <section><h3>VALIDATION</h3><div className="checks">{(chit.validation || []).map((v) => <span key={v.test} className={v.pass ? 'pass' : 'warn'}>{v.pass ? '✓' : '!'} {v.test}</span>)}</div></section>
    <div className="actions"><button onClick={() => onCopy(chit.poi)}>Copy POI</button><button onClick={() => onCopy(full)}>Copy Full Chit</button><button onClick={onFollowUp}>Generate Follow-Up</button><button onClick={onExport}>Export</button></div>
  </article>;
}

createRoot(document.getElementById('root')).render(<App />);
