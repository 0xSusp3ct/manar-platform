import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const workerPath = path.join(root, 'vercel', 'worker.js');
const worker = fs.readFileSync(workerPath, 'utf8');
const endOfAssets = worker.indexOf('\n');
if (endOfAssets < 0 || !worker.startsWith('const STATIC_ASSETS=')) {
  throw new Error('Unexpected Vercel worker asset format');
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};
function embedded(source) {
  const firstLine = source.slice(0, source.indexOf('\n'));
  return JSON.parse(firstLine.slice('const STATIC_ASSETS='.length, -1));
}
const previous = embedded(worker);
const assets = Object.fromEntries(Object.entries(previous).filter(([key]) => key.startsWith('/vendor/')));
if (!assets['/vendor/html2canvas/html2canvas.min.js'] || !assets['/vendor/jspdf/jspdf.umd.min.js']) {
  const committed = execFileSync('git', ['show', 'HEAD:vercel/worker.js'], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  for (const [key, value] of Object.entries(embedded(committed))) {
    if (key.startsWith('/vendor/')) assets[key] = value;
  }
}
if (!assets['/vendor/html2canvas/html2canvas.min.js'] || !assets['/vendor/jspdf/jspdf.umd.min.js']) {
  throw new Error('PDF vendor assets are missing');
}
function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) { visit(target); continue; }
    if (!entry.isFile()) continue;
    const type = mime[path.extname(entry.name)];
    if (!type) throw new Error(`Unsupported public asset: ${target}`);
    const key = `/${path.relative(publicDir, target).replaceAll(path.sep, '/')}`;
    const binary = path.extname(entry.name) === '.png';
    assets[key] = binary
      ? { body: fs.readFileSync(target).toString('base64'), type, encoding: 'base64' }
      : { body: fs.readFileSync(target, 'utf8'), type };
  }
}
visit(publicDir);
fs.writeFileSync(workerPath, `const STATIC_ASSETS=${JSON.stringify(assets)};${worker.slice(endOfAssets)}`);
console.log(`Embedded ${Object.keys(assets).length} public assets in the Vercel worker.`);
