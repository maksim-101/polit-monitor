import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';

const result = await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'iife',
  target: 'chrome110',
  define: { __APP_VERSION__: JSON.stringify(JSON.parse(readFileSync('package.json', 'utf8')).version) },
  write: false,
});
const appJs = result.outputFiles[0].text;
const css = readFileSync('src/styles.css', 'utf8');
const vendor = readFileSync('vendor/xlsx.mini.min.js', 'utf8');

// split/join statt replace: Bundle-Inhalte können "$"-Muster enthalten.
const html = readFileSync('src/template.html', 'utf8')
  .split('/*INLINE_CSS*/').join(css)
  .split('/*VENDOR_JS*/').join(vendor)
  .split('/*APP_JS*/').join(appJs);

mkdirSync('dist', { recursive: true });
writeFileSync('dist/polit-monitor.html', html);
console.log(`dist/polit-monitor.html geschrieben (${(html.length / 1024).toFixed(0)} KB)`);

// Beispielprofile zum Laden über «Profildatei laden» in den Einstellungen.
for (const f of readdirSync('profiles').filter((n) => n.endsWith('.json'))) {
  copyFileSync(`profiles/${f}`, `dist/polit-monitor-profil-${f}`);
  console.log(`dist/polit-monitor-profil-${f} geschrieben`);
}
