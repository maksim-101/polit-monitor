// Leeres Startprofil: die App wird neutral ausgeliefert. Stichwörter und Themen
// konfiguriert jede Organisationseinheit selbst im Einstellungen-Tab — oder sie
// lädt dort eine Profildatei (Beispiele in profiles/, im Release als polit-monitor-profil-*.json).
export const DEFAULT_PROFILE = {
  name: '',
  orgTerms: [],
  orgBonus: 15,
  themes: [],
  excludeTerms: [],
  commissionBonus: { names: [], points: 15 },
  thresholds: { hit: 20, borderline: 10 },
  bodies: { 261: true, ZH: true, CHE: true },
};
