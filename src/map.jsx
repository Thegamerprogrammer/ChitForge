import { useMemo, useState } from 'react';
import { geoNaturalEarth1, geoPath } from 'd3-geo';
import { feature } from 'topojson-client';
import world from 'world-atlas/countries-110m.json';
import countryList from 'world-countries';
import { applyMapAction, findCountry } from './mapUtils.js';

const numericToCountry = new Map(countryList.filter((c) => c.ccn3).map((c) => [c.ccn3, { iso: c.cca3, name: c.name.common }]));
const aliases = new Map([
  ['United States of America', { iso: 'USA', name: 'United States' }],
  ['Dem. Rep. Congo', { iso: 'COD', name: 'Democratic Republic of the Congo' }],
  ['Congo', { iso: 'COG', name: 'Republic of the Congo' }],
  ['Russia', { iso: 'RUS', name: 'Russia' }],
  ['South Korea', { iso: 'KOR', name: 'Republic of Korea' }],
  ['North Korea', { iso: 'PRK', name: 'North Korea' }],
  ['Iran', { iso: 'IRN', name: 'Iran' }],
  ['Syria', { iso: 'SYR', name: 'Syria' }],
  ['Laos', { iso: 'LAO', name: 'Laos' }],
  ['Vietnam', { iso: 'VNM', name: 'Vietnam' }],
  ['Venezuela', { iso: 'VEN', name: 'Venezuela' }],
  ['Bolivia', { iso: 'BOL', name: 'Bolivia' }],
  ['Tanzania', { iso: 'TZA', name: 'Tanzania' }],
]);

function normalizeCountry(geo) {
  const byId = numericToCountry.get(String(geo.id).padStart(3, '0'));
  const byName = aliases.get(geo.properties.name);
  return byId || byName || { iso: String(geo.id), name: geo.properties.name };
}

export function WorldMap({ selected, setSelected, opposition = [], setOpposition = () => {}, portfolio }) {
  const [tooltip, setTooltip] = useState(null);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const [history, setHistory] = useState([]);
  const [search, setSearch] = useState('');
  const countries = useMemo(() => {
    const fc = feature(world, world.objects.countries);
    const projection = geoNaturalEarth1().fitSize([980, 520], fc);
    const path = geoPath(projection);
    return fc.features.map((geo) => ({ ...normalizeCountry(geo), d: path(geo) })).filter((c) => c.d && c.iso !== '010');
  }, []);
  const selectedIso = new Set(selected.map((c) => c.iso));
  const oppositionIso = new Set(opposition.map((c) => c.iso));
  const portfolioText = portfolio.trim().toLowerCase();
  const commitAction = (action) => {
    setHistory((items) => [{ selected, opposition }, ...items].slice(0, 80));
    const next = applyMapAction({ selected, opposition }, action);
    setSelected(next.selected);
    setOpposition(next.opposition);
  };
  const toggle = (country) => commitAction({ type: 'target', country: { iso: country.iso, name: country.name } });
  const toggleOpposition = (country) => commitAction({ type: 'opposition', country: { iso: country.iso, name: country.name } });
  const undo = () => {
    const previous = history[0];
    if (!previous) return;
    setSelected(previous.selected);
    setOpposition(previous.opposition);
    setHistory(history.slice(1));
  };
  const selectSearch = () => {
    const match = findCountry(search);
    if (!match) return;
    commitAction({ type: 'target', country: { iso: match.iso, name: match.name } });
  };
  return <div className="mapWrap">
    <div className="mapTools"><input aria-label="Search country by name or ISO" list="country-options" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') selectSearch(); }} placeholder="Search country / ISO…" /><datalist id="country-options">{countries.map((c) => <option key={c.iso} value={`${c.name} (${c.iso})`} />)}</datalist><button type="button" onClick={selectSearch}>Select</button><button type="button" onClick={undo} disabled={!history.length}>↶ Undo</button><button type="button" onClick={() => setView((v) => ({ ...v, scale: Math.min(3, v.scale + 0.25) }))}>Zoom +</button><button type="button" onClick={() => setView((v) => ({ ...v, scale: Math.max(1, v.scale - 0.25) }))}>Zoom −</button><button type="button" onClick={() => setView({ scale: 1, x: 0, y: 0 })}>Reset</button><button type="button" onClick={() => commitAction({ type: 'clear' })}>Clear all</button></div><p className="mapHint">Left click: target · Right click: opposition</p>
    <svg viewBox="0 0 980 520" role="img" aria-label="Interactive real world map from Natural Earth geometry via world-atlas">
      <defs><filter id="glow"><feGaussianBlur stdDeviation="3" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter></defs>
      <rect className="ocean" width="980" height="520" />
      <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
      {countries.map((country) => {
        const isPortfolio = portfolioText && (country.iso.toLowerCase() === portfolioText || country.name.toLowerCase() === portfolioText);
        const isSelected = selectedIso.has(country.iso);
        const isOpposition = oppositionIso.has(country.iso);
        return <path key={`${country.iso}-${country.name}`} tabIndex="0" d={country.d} data-iso={country.iso} className={`country ${isSelected ? 'selected' : ''} ${isOpposition ? 'opposition' : ''} ${isPortfolio ? 'portfolio' : ''} ${isPortfolio && isSelected ? 'selfTarget' : ''}`} onClick={() => toggle(country)} onContextMenu={(e) => { e.preventDefault(); toggleOpposition(country); }} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggle(country); }} onMouseMove={(e) => setTooltip({ x: e.nativeEvent.offsetX + 14, y: e.nativeEvent.offsetY + 14, name: country.name, iso: country.iso, selected: isSelected, opposition: isOpposition })} onMouseLeave={() => setTooltip(null)}><title>{country.name} · {country.iso}</title></path>;
      })}
      </g>
    </svg>
    {tooltip && <div className="tooltip show" style={{ left: tooltip.x, top: tooltip.y }}><b>{tooltip.name}</b><br />ISO {tooltip.iso}<br />{tooltip.opposition ? 'Opposition target' : tooltip.selected ? 'Selected target' : 'Click to select · right-click for opposition'}</div>}
    <p className="attribution">Map geometry: Natural Earth via world-atlas/topojson, rendered as SVG.</p>
  </div>;
}
