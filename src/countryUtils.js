import countryList from 'world-countries';

const aliases = new Map([
  ['united states', 'USA'], ['america', 'USA'], ['us', 'USA'], ['u.s.', 'USA'], ['uk', 'GBR'], ['united kingdom', 'GBR'], ['britain', 'GBR'], ['south korea', 'KOR'], ['republic of korea', 'KOR'], ['north korea', 'PRK'], ['russia', 'RUS'], ['iran', 'IRN'], ['syria', 'SYR'], ['vietnam', 'VNM'], ['laos', 'LAO'], ['bolivia', 'BOL'], ['venezuela', 'VEN'], ['tanzania', 'TZA'], ['turkiye', 'TUR'], ['turkey', 'TUR']
]);

export const countryDirectory = countryList.filter((country) => country.cca3).map((country) => ({ iso: country.cca3, iso2: country.cca2, name: country.name.common, officialName: country.name.official }));
const byIso3 = new Map(countryDirectory.map((country) => [country.iso.toLowerCase(), country]));
const byIso2 = new Map(countryDirectory.map((country) => [country.iso2.toLowerCase(), country]));
const byName = new Map(countryDirectory.flatMap((country) => [[country.name.toLowerCase(), country], [country.officialName.toLowerCase(), country]]));

export function findCountryByQuery(query) {
  const key = String(query || '').trim().toLowerCase();
  if (!key) return null;
  return byIso3.get(key) || byIso2.get(key) || byName.get(key) || byIso3.get(aliases.get(key)?.toLowerCase()) || countryDirectory.find((country) => country.name.toLowerCase().includes(key));
}

export function addOrToggleCountry(selected, country, opposition = false) {
  const existing = selected.find((item) => item.iso === country.iso);
  if (existing) {
    return selected.map((item) => item.iso === country.iso ? { ...item, opposition: opposition ? !item.opposition : item.opposition } : item);
  }
  return [...selected, { iso: country.iso, iso2: country.iso2, name: country.name, opposition }];
}

export function removeCountry(selected, iso) {
  return selected.filter((country) => country.iso !== iso);
}
