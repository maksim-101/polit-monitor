// Fristen: OpenParlData führt keine Frist als Feld am Geschäft. Sie steckt nur in
// den Ereignistiteln, je Ebene anders codiert (live geprüft 2026-09-03):
//   Stadt 261:  «Überweisung, Frist 24 Monate» (Motion/Postulat, ab Überweisung),
//               «Zustimmung, fakultatives Referendum, Frist 60 Tage»,
//               «Fristverlängerung» (ohne Dauer im Titel; GeschO GR: höchstens 12 Monate)
//   Kanton ZH:  Ereignis «Frist» (Datum = Frist), «Zustimmung (Frist erstreckt bis 29.6.2023)»
//   Bund CHE:   Ereignisse «Frist», «Frist geplant», «Ablauf Sammelfrist» (Datum = Frist),
//               «Fristverlängerung bis zur Herbstsession 2026», «… bis zum 15. Januar 2026»,
//               «… um zwei Jahre»; «Überwiesen an den Bundesrat» (ParlG: 2 Jahre)
// Ohne Ereignis gilt bei der Stadt die Beantwortungsfrist nach Geschäftsart ab
// Einreichung (GeschO GR: Schriftliche Anfrage 3 Monate, Interpellation 6 Monate).
// Reines Modul ohne DOM/DB, damit Listen, Detail und Export dieselbe Frist zeigen.

const MONTHS = ['januar', 'februar', 'märz', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember'];
// Sessionen der Bundesversammlung enden im März/Juni/September/Dezember; als
// Sortierdatum genügt das Monatsende, angezeigt wird der Sessionsname.
const SESSION = {
  fruehjahr: { end: '03-31', name: 'Frühjahrssession' },
  sommer: { end: '06-30', name: 'Sommersession' },
  herbst: { end: '09-30', name: 'Herbstsession' },
  winter: { end: '12-31', name: 'Wintersession' },
};

function day(iso) {
  return iso ? iso.slice(0, 10) : null;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function addMonths(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, d));
  // Monatsende-Überlauf (31.01. + 1 Monat) auf den letzten Tag des Zielmonats ziehen
  if (t.getUTCDate() !== d) t.setUTCDate(0);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

function germanDate(text) {
  let m = text.match(/(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})/);
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  m = text.match(/(\d{1,2})\.\s?([A-Za-zäöü]+)\s?(\d{4})/);
  if (m) {
    const mi = MONTHS.indexOf(m[2].toLowerCase());
    if (mi >= 0) return `${m[3]}-${pad(mi + 1)}-${pad(m[1])}`;
  }
  return null;
}

function sortedEvents(affair) {
  return (affair.events || [])
    .filter((e) => e.title_de)
    .slice()
    .sort((a, b) => (day(a.date) || '').localeCompare(day(b.date) || '') || (a.position || 0) - (b.position || 0));
}

function base(e, patch) {
  return { date: null, display: null, label: '', source: e.title_de, sourceDate: day(e.date), extended: false, approx: false, ...patch };
}

function stadt(affair) {
  let d = null;
  for (const e of sortedEvents(affair)) {
    const t = e.title_de;
    let m;
    if ((m = t.match(/Frist (\d+) Monate/)) && e.date) {
      d = base(e, { date: addMonths(day(e.date), Number(m[1])), label: 'Bearbeitungsfrist Stadtrat' });
    } else if ((m = t.match(/Frist (\d+) Tage/)) && e.date) {
      d = base(e, { date: addDays(day(e.date), Number(m[1])), label: 'Referendumsfrist' });
    } else if (/^Fristverlängerung/.test(t) && !/nicht erfolgt/.test(t) && d?.date) {
      // Dauer steht nur in den Dokumenten; GeschO GR erlaubt höchstens 12 Monate,
      // was der Stadtrat in der Praxis auch beantragt.
      d = base(e, { date: addMonths(d.date, 12), label: d.label, extended: true, approx: true });
    }
  }
  if (d) return d;
  const begin = day(affair.begin_date);
  if (!begin) return null;
  const months = { 'Schriftliche Anfrage': 3, Interpellation: 6 }[affair.type_name_de];
  if (!months) return null;
  // Der Status bleibt nach der Antwort oft «InBearbeitung»; erfüllt ist die
  // Beantwortungsfrist trotzdem.
  const answer = sortedEvents(affair).find((e) => /^Stadtrat, Antwort/.test(e.title_de || ''));
  return {
    date: addMonths(begin, months),
    display: null,
    label: 'Beantwortungsfrist Stadtrat',
    source: `${affair.type_name_de}: ${months} Monate ab Einreichung` + (answer?.date ? `, beantwortet am ${fmtDay(day(answer.date))}` : ''),
    sourceDate: begin,
    extended: false,
    approx: false,
    answered: !!answer,
    // Ohne geladenen Statusverlauf ist offen, ob schon geantwortet wurde.
    unchecked: !affair.events,
  };
}

function kanton(affair) {
  let d = null;
  for (const e of sortedEvents(affair)) {
    const t = e.title_de;
    if ((e.title_harmonized === 'Frist' || t === 'Frist') && e.date) {
      d = base(e, { date: day(e.date), label: 'Frist' });
    } else if (/erstreckt bis|Fristerstreckung bis/i.test(t) && germanDate(t)) {
      d = base(e, { date: germanDate(t), label: 'Frist (erstreckt)', extended: true });
    } else if (/Fristerstreckung|Frist erstreckt/i.test(t) && /Zustimmung/i.test(t) && !/Ablehnung/i.test(t)) {
      d = base(e, { date: null, label: 'Frist erstreckt, neues Datum nicht bekannt', extended: true });
    }
  }
  return d;
}

function bund(affair) {
  let d = null;
  for (const e of sortedEvents(affair)) {
    const t = e.title_de;
    let m;
    if ((e.title_harmonized === 'Frist' || e.title_harmonized === 'Frist geplant') && e.date) {
      const label = t === 'Ablauf Sammelfrist' ? 'Sammelfrist' : e.title_harmonized === 'Frist geplant' ? 'Frist (geplant)' : 'Frist';
      d = base(e, { date: day(e.date), label });
    } else if (t === 'Überwiesen an den Bundesrat' && e.date) {
      d = base(e, { date: addMonths(day(e.date), 24), label: 'Erfüllungsfrist Bundesrat (2 Jahre)' });
    } else if (/^Fristverlängerung|Frist .*verlängert/.test(t)) {
      if ((m = t.match(/(Frühjahr|Sommer|Herbst|Winter)s?s?ession\s?(\d{4})/i))) {
        const key = m[1].toLowerCase().replace('ü', 'ue');
        d = base(e, { date: `${m[2]}-${SESSION[key].end}`, display: `${SESSION[key].name} ${m[2]}`, label: 'Frist (verlängert)', extended: true, approx: true });
      } else if (germanDate(t)) {
        d = base(e, { date: germanDate(t), label: 'Frist (verlängert)', extended: true });
      } else if ((m = t.match(/um (ein|zwei|drei|\d+) Jahre?/i)) && d?.date) {
        const n = { ein: 1, zwei: 2, drei: 3 }[m[1].toLowerCase()] || Number(m[1]);
        d = base(e, { date: addMonths(d.date, 12 * n), label: 'Frist (verlängert)', extended: true });
      } else if (!d?.extended || d.sourceDate !== day(e.date)) {
        // Titel ohne Datum. Ein gleichentags folgender Titel mit Datum überschreibt dies.
        d = base(e, { date: null, label: 'Frist verlängert, neues Datum nicht bekannt', extended: true });
      }
    }
  }
  return d;
}

const CLOSED = {
  261: /^Abgeschlossen$/,
  ZH: /^(Erledigt|abgeschlossen)$/i,
  CHE: /^(Erledigt|Abgeschlossen|Zurückgezogen)/,
};

export function isClosed(affair) {
  const re = CLOSED[affair.body_key];
  return !!(re && re.test(affair.state_name_de || ''));
}

// → null oder { date: 'YYYY-MM-DD'|null, display, label, source, sourceDate,
//   extended, approx, closed }
export function deadlineOf(affair) {
  const fn = { 261: stadt, ZH: kanton, CHE: bund }[affair.body_key];
  const d = fn ? fn(affair) : null;
  if (!d) return null;
  d.closed = isClosed(affair) || !!d.answered;
  return d;
}

// Lokales Datum statt UTC: sonst ist «heute» zwischen 00:00 und 02:00 noch gestern.
function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Für Filter und Farbgebung: 'erledigt' | 'abgelaufen' | 'bald' (30 Tage) | 'offen' | 'unbekannt'
export function deadlineStatus(d, today = localToday()) {
  if (!d) return 'unbekannt';
  if (d.closed) return 'erledigt';
  if (!d.date) return 'unbekannt';
  if (d.date < today) return d.unchecked ? 'unbekannt' : 'abgelaufen';
  if (d.date <= addDays(today, 30)) return 'bald';
  return 'offen';
}

// Sortierschlüssel: offene Fristen zuerst (nächste vorn), dann erledigte, dann ohne.
export function deadlineSortKey(d) {
  if (!d || !d.date) return '9999-99-99';
  return (d.closed ? '9' : '0') + d.date;
}

function fmtDay(ymd) {
  const [y, m, d] = ymd.split('-');
  return `${d}.${m}.${y}`;
}

// Anzeigetext ohne Statuswort: '' | '30.03.2024' | 'ca. 24.06.2023' | 'Herbstsession 2026'
export function fmtDeadline(d) {
  if (!d) return '';
  if (d.display) return d.display;
  if (!d.date) return d.extended ? 'verlängert, neues Datum unbekannt' : '';
  return (d.approx ? 'ca. ' : '') + fmtDay(d.date);
}

// Statuswort für Listen: 'abgelaufen' | 'heute' | 'in 12 Tagen' | 'erledigt' | ''
export function deadlineNote(d, today = localToday()) {
  const s = deadlineStatus(d, today);
  if (s === 'abgelaufen') return 'abgelaufen';
  if (s === 'erledigt') return 'erledigt';
  if (s === 'bald') {
    const days = Math.round((Date.parse(d.date) - Date.parse(today)) / 864e5);
    return days <= 0 ? 'heute' : days === 1 ? 'morgen' : `in ${days} Tagen`;
  }
  return '';
}

// Herkunft für Tooltip/Detail: «Bearbeitungsfrist Stadtrat, aus «Überweisung, Frist 24 Monate» vom 30.03.2022»
export function deadlineSource(d) {
  if (!d) return '';
  const from = d.sourceDate ? ` vom ${fmtDay(d.sourceDate)}` : '';
  return `${d.label}, aus «${d.source}»${from}${d.approx ? '. Datum geschätzt' : ''}`;
}

// Listenfilter: '' | 'offen' | 'bald' | 'abgelaufen' | 'ohne'
export function matchesDeadlineFilter(d, key, today) {
  if (!key) return true;
  const s = deadlineStatus(d, today);
  if (key === 'offen') return s === 'offen' || s === 'bald' || s === 'abgelaufen';
  if (key === 'bald') return s === 'bald' || s === 'abgelaufen';
  if (key === 'abgelaufen') return s === 'abgelaufen';
  if (key === 'ohne') return s === 'unbekannt';
  return true;
}

export const DEADLINE_FILTERS = [
  ['', 'Alle Fristen'],
  ['offen', 'Frist offen'],
  ['bald', 'Fällig in 30 Tagen oder abgelaufen'],
  ['abgelaufen', 'Frist abgelaufen'],
  ['ohne', 'Ohne bekannte Frist'],
];
