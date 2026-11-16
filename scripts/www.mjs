// Copies the web app into www/, the folder Capacitor packs into the Android app. The app loads the live site
// (capacitor.config.json server.url), so these files are only its fallback; they're rebuilt on every `npm run sync`.
import { cpSync, rmSync, mkdirSync } from 'node:fs';
const files = ['index.html', 'offline.html', 'styles.css', 'manifest.json', 'sw.js', 'js', 'icons', 'vendor'];
rmSync('www', { recursive: true, force: true });
mkdirSync('www');
for (const f of files) cpSync(f, `www/${f}`, { recursive: true, filter: src => !/(^|\/)(tests|smoke|fake-[^/]*|native-entry)\.js$/.test(src) });
console.log(`www/: ${files.join(', ')}`);
