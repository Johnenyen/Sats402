import { rmSync, mkdirSync, cpSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Clean and prepare public directory
rmSync('public', { recursive: true, force: true });
mkdirSync('public/assets', { recursive: true });

// Copy all HTML files from apps/site to public/
for (const file of readdirSync('apps/site')) {
  if (file.endsWith('.html')) {
    cpSync(join('apps/site', file), join('public', file));
  }
}

// home.html is served at the root as index.html
cpSync('apps/site/home.html', 'public/index.html');

// Assets
cpSync('apps/site/assets/style.css', 'public/assets/style.css');

// Metadata and specification files
const files = [
  'favicon.svg',
  'og.svg',
  'run-evidence.json',
  'openapi.json',
  'services.json',
  'llms.txt',
];

for (const file of files) {
  cpSync(join('apps/site', file), join('public', file));
}
