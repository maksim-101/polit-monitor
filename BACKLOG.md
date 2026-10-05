# Backlog

Bewusst zurückgestellte Punkte. Quelle: Qualitätsreview vom 03.09.2026, sofern nicht
anders vermerkt.

## Entscheid nötig

- **Mehrere Personen an einer Datei:** heute nur Schutz vor Fremdänderung, kein
  Zusammenführen. Optionen: eine Person führt die Datei, die anderen erhalten Exporte;
  geteilte Einstufungsdatei mit Zusammenführen je Geschäft; Datei pro Person mit
  Zusammenführen-Import; echtes Backend.
- **Volltext-Recall:** Ergänzungslauf `search_scope=all` und/oder Volltext-Suchknopf.

## Fachlogik

- `rematchAll` reichert neu matchende Geschäfte nicht an; Kommissionsbonus fehlt bis zum
  nächsten Abgleich.
- `syncSearch` bricht pro Begriff bei Offset 1000 ohne Statushinweis ab.

## Datenhaltung

- Einstufungen laufen nicht unter dem Web-Lock (tab-übergreifend nicht serialisiert).
- `openDb` ohne `onversionchange`/`onblocked`; `schemaVersion` beim Import ungeprüft;
  Profil-Übernahme beim Import ausserhalb der Store-Transaktion; `changelog` ohne Pruning.

- Detailansicht bleibt leer, bis alle drei Abrufe fertig sind (offline rund 7 s), und ein
  langsamer Abruf kann ein inzwischen geöffnetes anderes Geschäft überschreiben (Review 05.10.2026).
- Gewicht oder Schwellenwert 0 wird still durch den Standardwert ersetzt (`Number(x) || 10`).

## UX/Barrierefreiheit

- Randfarbe `--line` (#ddd) unter 3:1 (WCAG 1.4.11).
- Punkte-Tooltip in Listen nur per Maus erreichbar.
- Einzelne Meldungen zeigen rohe Browser-Fehlertexte.
- Exporte enthalten Notizen ohne Weitergabe-Hinweis.
