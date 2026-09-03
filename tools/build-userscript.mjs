import { readFile, writeFile } from 'node:fs/promises';

const sourcePath = new URL('../web/teams-green-everywhere.user.js', import.meta.url);
const schedulePath = new URL('../web/schedule.js', import.meta.url);
const outputPath = new URL('../dist/teams-greens-everywhere.user.js', import.meta.url);

const source = await readFile(sourcePath, 'utf8');
const schedule = await readFile(schedulePath, 'utf8');
const metadataEnd = source.indexOf('// ==/UserScript==');

if (metadataEnd === -1) {
  throw new Error('Userscript metadata block is missing.');
}

const metadata = source
  .slice(0, metadataEnd + '// ==/UserScript=='.length)
  .replace(/^\/\/ @require .*\n/m, '');
const body = source.slice(metadataEnd + '// ==/UserScript=='.length).trimStart();
const output = `${metadata}

// Bundled schedule engine. Source: web/schedule.js
${schedule}

${body}`;

await writeFile(outputPath, output, 'utf8');
