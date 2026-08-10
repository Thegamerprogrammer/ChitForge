import { useMemo, useState } from 'react';
import { geoNaturalEarth1, geoPath } from 'd3-geo';
import { feature } from 'topojson-client';
import world from 'world-atlas/countries-110m.json';
import countryList from 'world-countries';

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

export function WorldMap({ selected, setSelected, portfolio }) {
  const [tooltip, setTooltip] = useState(null);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const countries = useMemo(() => {
    const fc = feature(world, world.objects.countries);
    const projection = geoNaturalEarth1().fitSize([980, 520], fc);
    const path = geoPath(projection);
    return fc.features.map((geo) => ({ ...normalizeCountry(geo), d: path(geo) })).filter((c) => c.d && c.iso !== '010');
  }, []);
  const selectedIso = new Set(selected.map((c) => c.iso));
  const portfolioText = portfolio.trim().toLowerCase();
  const toggle = (country) => {
    setSelected(selectedIso.has(country.iso) ? selected.filter((c) => c.iso !== country.iso) : [...selected, { iso: country.iso, name: country.name }]);
  };
  return <div className="mapWrap">
    <div className="mapTools"><button type="button" onClick={() => setView((v) => ({ ...v, scale: Math.min(3, v.scale + 0.25) }))}>Zoom +</button><button type="button" onClick={() => setView((v) => ({ ...v, scale: Math.max(1, v.scale - 0.25) }))}>Zoom −</button><button type="button" onClick={() => setView({ scale: 1, x: 0, y: 0 })}>Reset</button><button type="button" onClick={() => setSelected([])}>Clear all</button></div>
    <svg viewBox="0 0 980 520" role="img" aria-label="Interactive real world map from Natural Earth geometry via world-atlas">
      <defs><filter id="glow"><feGaussianBlur stdDeviation="3" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter></defs>
      <rect className="ocean" width="980" height="520" />
      <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
      {countries.map((country) => {
        const isPortfolio = portfolioText && (country.iso.toLowerCase() === portfolioText || country.name.toLowerCase() === portfolioText);
        const isSelected = selectedIso.has(country.iso);
        return <path key={`${country.iso}-${country.name}`} tabIndex="0" d={country.d} data-iso={country.iso} className={`country ${isSelected ? 'selected' : ''} ${isPortfolio ? 'portfolio' : ''} ${isPortfolio && isSelected ? 'selfTarget' : ''}`} onClick={() => toggle(country)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggle(country); }} onMouseMove={(e) => setTooltip({ x: e.nativeEvent.offsetX + 14, y: e.nativeEvent.offsetY + 14, name: country.name, iso: country.iso })} onMouseLeave={() => setTooltip(null)}><title>{country.name} · {country.iso}</title></path>;
      })}
      </g>
    </svg>
    {tooltip && <div className="tooltip show" style={{ left: tooltip.x, top: tooltip.y }}><b>{tooltip.name}</b><br />ISO {tooltip.iso}</div>}
    <p className="attribution">Map geometry: Natural Earth via world-atlas/topojson, rendered as SVG.</p>
  </div>;
}
