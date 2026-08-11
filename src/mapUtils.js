import countryList from 'world-countries';

export const countryIndex = countryList.map((country) => ({
  iso: country.cca3,
  iso2: country.cca2,
  name: country.name.common,
  official: country.name.official,
  aliases: [country.name.common, country.name.official, country.cca2, country.cca3, ...(country.altSpellings || [])].filter(Boolean),
}));

export function findCountry(query) {
  const q = String(query || '').replace(/\s*\([A-Z]{2,3}\)\s*$/i, '').trim().toLowerCase();
  if (!q) return null;
  return countryIndex.find((country) => country.aliases.some((alias) => String(alias).toLowerCase() === q))
    || countryIndex.find((country) => country.aliases.some((alias) => String(alias).toLowerCase().includes(q)))
    || null;
}

export function toggleCountry(list, country) {
  return list.some((item) => item.iso === country.iso)
    ? list.filter((item) => item.iso !== country.iso)
    : [...list, { iso: country.iso, name: country.name }];
}

export function applyMapAction({ selected, opposition }, action) {
  if (action.type === 'target') return { selected: toggleCountry(selected, action.country), opposition };
  if (action.type === 'opposition') return { selected: selected.some((item) => item.iso === action.country.iso) ? selected : [...selected, action.country], opposition: toggleCountry(opposition, action.country) };
  if (action.type === 'clear') return { selected: [], opposition: [] };
  return { selected, opposition };
}
