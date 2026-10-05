// Reines Scoring: (Affair, kompiliertes Profil) → {score, category, matchDetails}.
// Kein DOM, keine DB — dadurch für Re-Matching über den ganzen Bestand nutzbar.

export function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // kombinierende Akzente nach NFD-Zerlegung
    .replace(/[-–—/,()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Term-Notation im Profil-Editor: trailing "*" = Wortanfang (Komposita),
// sonst ganzes Wort bzw. ganze Phrase.
export function parseTerm(raw) {
  const prefix = raw.trim().endsWith('*');
  const t = normalize(raw.replace(/\*\s*$/, ''));
  return { t, mode: prefix ? 'prefix' : 'word', raw: raw.trim() };
}

export function termRe({ t, mode }) {
  return new RegExp(`\\b${escapeRe(t)}${mode === 'prefix' ? '' : '\\b'}`);
}

export function compileProfile(profile) {
  const terms = (list) => list.map(parseTerm).filter((x) => x.t).map((x) => ({ ...x, re: termRe(x) }));
  return {
    profile,
    exclude: terms(profile.excludeTerms || []),
    org: terms(profile.orgTerms || []),
    themes: (profile.themes || []).map((th) => ({
      label: th.label,
      weight: th.weight,
      terms: terms(th.terms || []),
    })),
    commissionNames: (profile.commissionBonus?.names || []).filter(Boolean),
  };
}

export function matchText(affair) {
  return normalize([affair.title_de, affair.title_long_de].filter(Boolean).join(' '));
}

export function scoreAffair(affair, compiled) {
  const text = matchText(affair);
  const details = [];

  for (const ex of compiled.exclude) {
    if (ex.re.test(text)) {
      return { score: 0, category: 'kein', matchDetails: [{ kind: 'ausschluss', term: ex.raw }] };
    }
  }

  let score = 0;
  const orgHit = compiled.org.find((o) => o.re.test(text));
  if (orgHit) {
    score += compiled.profile.orgBonus;
    details.push({ kind: 'organisation', term: orgHit.raw, points: compiled.profile.orgBonus });
  }

  for (const theme of compiled.themes) {
    const hit = theme.terms.find((t) => t.re.test(text));
    if (hit) {
      score += theme.weight;
      details.push({ kind: 'thema', theme: theme.label, term: hit.raw, points: theme.weight });
    }
  }

  const eventText = normalize((affair.events || []).map((e) => e.title_de || '').join(' | '));
  const commissionHit = compiled.commissionNames.find((n) => eventText.includes(normalize(n)));
  if (commissionHit) {
    score += compiled.profile.commissionBonus.points;
    details.push({ kind: 'kommission', term: commissionHit, points: compiled.profile.commissionBonus.points });
  }

  const { hit, borderline } = compiled.profile.thresholds;
  const category = score >= hit ? 'treffer' : score >= borderline ? 'grenzfall' : 'kein';
  return { score, category, matchDetails: details };
}

// Suchbegriffe für die serverseitige Stichwortsuche (Kanton/Bund):
// Wortanfang-Sternchen entfernen, sehr kurze Begriffe (z.B. "kita") auslassen,
// weil search_mode=partial reine Teilstrings findet und Rauschen erzeugt.
export function searchTerms(profile) {
  const all = [...(profile.orgTerms || []), ...(profile.themes || []).flatMap((t) => t.terms || [])];
  const cleaned = all.map((t) => t.replace(/\*\s*$/, '').trim()).filter((t) => t.length >= 5);
  return [...new Set(cleaned)];
}
