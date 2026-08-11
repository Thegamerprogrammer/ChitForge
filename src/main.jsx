import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { WorldMap } from './map.jsx';
import { loadStoredKey, saveApiKey, clearStoredKey, loadSettings, saveSettings } from './state.js';
import { generateFollowUp, generateMission, regenerateChit } from './generation.js';
import { validateMissionInputs } from './validation.js';
import { downloadBrief } from './export.js';
import { renderMarkdownBold } from './format.js';
import { FALLBACK_MODELS, DEFAULT_MAIN_MODEL, DEFAULT_REVIEW_MODEL, DEFAULT_MAIN_THINKING, DEFAULT_REVIEW_THINKING, THINKING_LEVELS } from './models.js';
import { findCountryByQuery, addOrToggleCountry, removeCountry } from './countryUtils.js';
import { sourceStatusLabel } from './sourceIntegrity.js';

const defaultSliders = { aggression: 0, controversy: 0, diplomacy: 0, length: 0 };
const modes = [
  ['hybrid', 'Hybrid', 'AI recommends targets; you can approve/remove map selections.'],
  ['automatic', 'Automatic', 'AI chooses agenda-relevant targets when none are selected.'],
  ['manual', 'Manual', 'Use only countries selected on the real world map.'],
];
const progressStages = ['RESEARCHING PORTFOLIO', 'ANALYZING TARGETS', 'IDENTIFYING PRESSURE POINTS', 'GENERATING POIs', 'VALIDATING EVIDENCE', 'FINALIZING TACTICAL BRIEF'];

function App() {
  const stored = useMemo(() => loadStoredKey(), []);
  const savedSettings = useMemo(() => loadSettings(), []);
  const [form, setForm] = useState({ committee: '', agenda: '', portfolio: '', apiKey: stored.key, rememberKey: stored.rememberKey, mainModel: savedSettings.mainModel || DEFAULT_MAIN_MODEL, reviewModel: savedSettings.reviewModel || DEFAULT_REVIEW_MODEL, mainThinking: savedSettings.mainThinking || DEFAULT_MAIN_THINKING, reviewThinking: savedSettings.reviewThinking || DEFAULT_REVIEW_THINKING, researchDepth: savedSettings.researchDepth || 'standard', extensiveLegalities: savedSettings.extensiveLegalities || false, poisPerCountry: savedSettings.poisPerCountry || 10 });
  const [showKey, setShowKey] = useState(false);
  const [sliders, setSliders] = useState(defaultSliders);
  const [poiCount, setPoiCount] = useState(5);
  const [countryQuery, setCountryQuery] = useState('');
  const [searchFocusIso, setSearchFocusIso] = useState(null);
  const [selectionHistory, setSelectionHistory] = useState([]);
  const [sourceFilter, setSourceFilter] = useState('all');
  const [poiFilter, setPoiFilter] = useState({ text: '', tier: 'all', country: 'all', verifiedOnly: false });
  const [selected, setSelected] = useState([]);
  const [mode, setMode] = useState('hybrid');
  const [includeFollowUp, setIncludeFollowUp] = useState(false);
  const [portfolioProfile, setPortfolioProfile] = useState(null);
  const [recommendations, setRecommendations] = useState([]);
  const [chits, setChits] = useState([]);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const updateForm = (key, value) => {
    const next = { ...form, [key]: value };
    setForm(next);
    if (key === 'apiKey' || key === 'rememberKey') saveApiKey(next.apiKey, next.rememberKey);
    if (['mainModel', 'reviewModel', 'mainThinking', 'reviewThinking', 'researchDepth', 'extensiveLegalities', 'poisPerCountry'].includes(key)) saveSettings({ mainModel: next.mainModel, reviewModel: next.reviewModel, mainThinking: next.mainThinking, reviewThinking: next.reviewThinking, researchDepth: next.researchDepth, extensiveLegalities: next.extensiveLegalities, poisPerCountry: next.poisPerCountry });
  };

  const showError = (err) => setError({ message: err.message || 'Generation failed. Please try again.', diagnostic: err.diagnostic, status: err.status, category: err.category });

  const runGeneration = async () => {
    const totalTarget = selected.length ? Math.min(250, Number(form.poisPerCountry || 10) * selected.length) : poiCount;
    const validation = validateMissionInputs({ ...form, poiCount: totalTarget });
    setError(validation ? { message: validation } : null);
    if (validation) return;
    setBusy(true);
    setChits([]);
    setRecommendations([]);
    try {
      const result = await generateMission({ form: { ...form, selectedCountryCount: selected.length, totalPoiTarget: totalTarget }, sliders, selectedTargets: selected, targetingMode: mode, includeFollowUp, poiCount: totalTarget, onProgress: setStatus });
      setPortfolioProfile(result.portfolioProfile);
      setRecommendations(result.recommendedTargets || []);
      setChits(result.chits);
      if (result.chits.length < totalTarget && mode !== 'manual') setError({ message: `${result.chits.length} / ${totalTarget} POIs generated. Gemini did not return enough distinct, defensible POIs after retry attempts. No duplicates were inserted.` });
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
      const updated = await generateFollowUp({ form, sliders, chit: chits[index], apiKey: form.apiKey, onProgress: setStatus });
      setChits((items) => items.map((item, i) => (i === index ? updated : item)));
    } catch (err) { showError(err); }
    finally { setBusy(false); setStatus(null); }
  };

  const regenerateOne = async (index) => {
    setBusy(true);
    try {
      const updated = await regenerateChit({ form, sliders, chit: chits[index], existingChits: chits.filter((_, i) => i !== index), apiKey: form.apiKey, includeFollowUp, onProgress: setStatus });
      setChits((items) => items.map((item, i) => (i === index ? updated : item)));
    } catch (err) { showError(err); }
    finally { setBusy(false); setStatus(null); }
  };

  const copyText = (text) => navigator.clipboard?.writeText(text).catch(() => setError({ message: 'Clipboard access was blocked by the browser.' }));
  const copyAll = () => copyText(chits.map((chit, index) => `POI ${index + 1} — ${chit.target}\n${chit.poi}`).join('\n\n'));
  const exportBrief = (items = chits) => {
    try { downloadBrief({ form, sliders, portfolioProfile, chits: items, poiCount: selected.length ? Number(form.poisPerCountry || 10) * selected.length : poiCount, selectedTargets: selected }); }
    catch { setError({ message: 'DOCX export failed. Please try again in a modern browser.' }); }
  };


  const totalPoiTarget = selected.length ? Math.min(250, Number(form.poisPerCountry || 10) * selected.length) : poiCount;
  const sources = useMemo(() => uniqueSources(chits), [chits]);
  const filteredSources = useMemo(() => filterSources(sources, sourceFilter), [sources, sourceFilter]);
  const filteredChits = useMemo(() => filterChits(chits, poiFilter), [chits, poiFilter]);
  const countryOptions = useMemo(() => {
    if (!countryQuery.trim()) return [];
    const found = findCountryByQuery(countryQuery);
    return found ? [found] : [];
  }, [countryQuery]);
  const recordSelection = (next) => { setSelectionHistory((items) => [...items.slice(-99), selected]); setSelected(next); };
  const selectCountry = (country, opposition = false) => { setSearchFocusIso(country.iso); recordSelection(addOrToggleCountry(selected, country, opposition)); };
  const undoSelection = () => { const previous = selectionHistory.at(-1); if (previous) { setSelected(previous); setSelectionHistory((items) => items.slice(0, -1)); } };
  const removeSelectedCountry = (iso) => recordSelection(removeCountry(selected, iso));
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
        <h2>Models & Research</h2>
        <label>Main Research / POI Model<select value={form.mainModel} onChange={(e) => updateForm('mainModel', e.target.value)}>{FALLBACK_MODELS.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select></label>
        <label>Source Review Model<select value={form.reviewModel} onChange={(e) => updateForm('reviewModel', e.target.value)}>{FALLBACK_MODELS.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select></label>
        <div className="row"><label>Main Thinking<select value={form.mainThinking} onChange={(e) => updateForm('mainThinking', e.target.value)}>{THINKING_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}</select></label><label>Reviewer Thinking<select value={form.reviewThinking} onChange={(e) => updateForm('reviewThinking', e.target.value)}>{THINKING_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}</select></label></div>
        <label>Research Depth<select value={form.researchDepth} onChange={(e) => updateForm('researchDepth', e.target.value)}><option value="quick">Quick</option><option value="standard">Standard</option><option value="deep">Deep</option><option value="extensive">Extensive</option></select></label>
        <label className="check legalToggle"><input type="checkbox" checked={form.extensiveLegalities} onChange={(e) => updateForm('extensiveLegalities', e.target.checked)} /> Extensive Legalities</label>
        <h2>Targeting Mode</h2>
        <div className="modes">{modes.map(([id, label, help]) => <label key={id} className="mode"><input type="radio" checked={mode === id} onChange={() => setMode(id)} /> <b>{label}</b><small>{help}</small></label>)}</div>
        <label>Fallback POIs when no country is selected<input type="number" min="1" max="250" value={poiCount} onChange={(e) => setPoiCount(Math.max(1, Math.min(250, Number(e.target.value) || 1)))} /></label>
        <label>POIs per Country<input type="number" min="1" max="100" value={form.poisPerCountry} onChange={(e) => updateForm('poisPerCountry', Math.max(1, Math.min(100, Number(e.target.value) || 1)))} /></label>
        <div className="notice"><b>TOTAL TARGET:</b> {selected.length ? `${form.poisPerCountry} × ${selected.length} countries = ${totalPoiTarget} POIs` : `${totalPoiTarget} auto-discovered POIs`}</div>
        <label className="check"><input type="checkbox" checked={includeFollowUp} onChange={(e) => setIncludeFollowUp(e.target.checked)} /> Generate Follow-Up</label>
        <div className="notice"><b>TARGETS: OPTIONAL</b><br />{selected.length ? `${selected.length} manual target(s) selected.` : 'AUTO-DISCOVERY ENABLED when Automatic or Hybrid mode is used.'}</div>
        {Object.keys(sliders).map((key) => <label key={key} className="slider"><span>{key}<b>{sliders[key]}%</b></span><input type="range" min="0" max="100" value={sliders[key]} onChange={(e) => setSliders({ ...sliders, [key]: Number(e.target.value) })} /></label>)}
        <button className="primary" onClick={runGeneration} disabled={busy}>{busy ? 'Synthesizing Tactical POIs…' : 'Generate Tactical POI Array'}</button>
        {error && <ErrorBox error={error} />}
      </section>
      <section className="panel mapPanel"><h2>Real World Target Map</h2><WorldMap selected={selected} setSelected={setSelected} portfolio={form.portfolio} searchFocusIso={searchFocusIso} onCountryAction={(country, kind) => selectCountry(country, kind === 'opposition')} /></section>
      <aside className="panel queue"><h2>Target Countries</h2><label>Search country<input value={countryQuery} onChange={(e) => setCountryQuery(e.target.value)} placeholder="India, IND, United States, USA" list="countryMatches" /></label><datalist id="countryMatches">{countryOptions.map((country) => <option key={country.iso} value={`${country.name} (${country.iso})`} />)}</datalist><div className="row"><button onClick={() => { const country = findCountryByQuery(countryQuery.replace(/\(.*\)/, '')); if (country) selectCountry(country, false); }}>Add Target</button><button onClick={() => { const country = findCountryByQuery(countryQuery.replace(/\(.*\)/, '')); if (country) selectCountry(country, true); }}>Add Opposition</button><button onClick={undoSelection} disabled={!selectionHistory.length}>↶ Undo</button></div>{selected.length ? selected.map((c) => <button key={c.iso} className={`pill ${c.opposition ? 'oppositionPill' : ''}`} onClick={() => removeSelectedCountry(c.iso)}>{c.name}{c.opposition ? ' · Opposition' : ''}<span>{c.iso}</span>×</button>) : <p className="muted">No manual targets selected. Auto-discovery can generate anyway.</p>}<button onClick={() => recordSelection([])}>Clear all</button>{recommendations.length > 0 && <><h2>AI Recommended Targets</h2>{recommendations.map((target) => <div className="recommendation" key={`${target.name}-${target.reason}`}><b>{target.name}</b><small>{target.reason}</small></div>)}</>}{(busy || status) && <ProgressPanel status={status} poiCount={poiCount} />}</aside>
    </main>
    {portfolioProfile && <section className="panel intel"><h2>Portfolio Intelligence Summary</h2><p>{portfolioProfile.summary}</p><div className="intelGrid">{(portfolioProfile.interests || []).map((item) => <span key={item}>{item}</span>)}</div></section>}
    {chits.length > 0 && <section className="poiWindow"><div className="arrayHeader"><div><span className="eyebrow">CHITFORGE</span><h2>TACTICAL POI ARRAY</h2><strong>{filteredChits.length} shown · {chits.length} / {totalPoiTarget} POIs GENERATED</strong></div><div className="actions"><button onClick={copyAll}>Copy All</button><button onClick={() => exportBrief()}>Download DOCX</button><button onClick={runGeneration} disabled={busy}>Regenerate All</button></div></div><FilterBar poiFilter={poiFilter} setPoiFilter={setPoiFilter} chits={chits} /><SourcePanel sources={filteredSources} sourceFilter={sourceFilter} setSourceFilter={setSourceFilter} /><div className="chits">{filteredChits.map((chit, i) => <ChitCard key={`${chit.target}-${i}-${chit.poi}`} chit={chit} number={i + 1} onCopy={copyText} onExport={() => exportBrief([chit])} onFollowUp={() => addFollowUp(i)} onRegenerate={() => regenerateOne(i)} />)}</div></section>}
  </>;
}


function uniqueSources(chits) {
  const map = new Map();
  chits.flatMap((chit) => chit.evidence || []).forEach((evidence) => {
    if (evidence.sourceId && evidence.url && !map.has(evidence.sourceId)) map.set(evidence.sourceId, { id: evidence.sourceId, title: evidence.title, url: evidence.url, domain: evidence.organization, reviewStatus: evidence.status?.toLowerCase().includes('verified') ? 'verified' : evidence.status?.toLowerCase().includes('reported') ? 'reported' : 'pending', sourceType: evidence.sourceClassification, confidence: evidence.confidence || 0, verbatimEvidence: evidence.verbatimEvidence, claimsSupported: [evidence.claim].filter(Boolean) });
  });
  return [...map.values()];
}

function filterSources(sources, filter) {
  if (filter === 'all') return sources;
  if (['verified', 'reported', 'disputed', 'unsupported', 'unavailable'].includes(filter)) return sources.filter((source) => source.reviewStatus === filter);
  return sources.filter((source) => source.sourceType === filter);
}

function filterChits(chits, filter) {
  return chits.filter((chit) => {
    if (filter.country !== 'all' && chit.target !== filter.country) return false;
    if (filter.tier !== 'all' && chit.tier !== filter.tier) return false;
    if (filter.verifiedOnly && !chit.evidence?.some((e) => /verified|reported/i.test(e.status || ''))) return false;
    if (filter.text && !`${chit.poi} ${chit.category} ${chit.target} ${chit.legalPolicyFoundation}`.toLowerCase().includes(filter.text.toLowerCase())) return false;
    return true;
  });
}

function FilterBar({ poiFilter, setPoiFilter, chits }) {
  const countries = [...new Set(chits.map((chit) => chit.target))];
  return <div className="filterBar"><input aria-label="Search POIs" value={poiFilter.text} onChange={(e) => setPoiFilter({ ...poiFilter, text: e.target.value })} placeholder="Search POIs: UN Charter, debt, vote, sanctions..." /><select value={poiFilter.country} onChange={(e) => setPoiFilter({ ...poiFilter, country: e.target.value })}><option value="all">All countries</option>{countries.map((country) => <option key={country} value={country}>{country}</option>)}</select><select value={poiFilter.tier} onChange={(e) => setPoiFilter({ ...poiFilter, tier: e.target.value })}><option value="all">All tiers</option><option value="S">S-Tier</option><option value="A">A-Tier</option><option value="B">B-Tier</option></select><label className="check"><input type="checkbox" checked={poiFilter.verifiedOnly} onChange={(e) => setPoiFilter({ ...poiFilter, verifiedOnly: e.target.checked })} /> Verified only</label></div>;
}

function SourcePanel({ sources, sourceFilter, setSourceFilter }) {
  return <section className="sourcePanel"><div className="sourceHead"><h2>Source Integrity Panel</h2><select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}><option value="all">All</option><option value="verified">Verified</option><option value="reported">Reported</option><option value="disputed">Disputed</option><option value="unsupported">Unsupported</option><option value="unavailable">Unavailable</option><option value="un">UN</option><option value="government">Government</option><option value="major_media">Media</option><option value="academic">Academic</option></select></div>{sources.length ? sources.map((source) => <details key={source.id} className="sourceCard"><summary>{sourceStatusLabel(source.reviewStatus)} · {source.domain} · {Math.round((source.confidence || 0) * 100)}%</summary><h3>{source.title}</h3><p><b>Source ID:</b> {source.id}</p><p><b>Evidence:</b> “{source.verbatimEvidence || 'No verbatim supporting evidence available.'}”</p><p><b>Supports:</b> {(source.claimsSupported || []).join('; ') || 'Pending claim graph'}</p><a href={source.url} target="_blank" rel="noreferrer">Open Source</a></details>) : <p className="muted">No trusted source records attached to the current filtered POIs.</p>}</section>;
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
