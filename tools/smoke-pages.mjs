import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const root = new URL('../dist/', import.meta.url);
const entries = await readdir(root, { recursive: true, withFileTypes: true });
const site = new URL('https://example.com/rpe-next/');
const names = new Set(entries.filter(entry => entry.isFile()).map(entry => relative(fileURLToPath(root), join(entry.parentPath, entry.name)).replaceAll('\\', '/')));
assert.ok(names.has('LICENSE') && names.has('NOTICE') && names.has('.nojekyll'));
for (const name of names) assert.match(name, /^(?:index\.html|styles\.css|LICENSE|NOTICE|\.nojekyll|assets\/.+|src\/(?:core|application|platform|ui)\/.+)$/);
function checkReference(reference, file) {
  const resolved = new URL(reference, new URL(file, site));
  assert.ok(resolved.href.startsWith(site.href), `${file}: reference escapes site: ${reference}`);
  assert.ok(names.has(decodeURIComponent(resolved.href.slice(site.href.length))), `${file}: missing resource: ${reference}`);
}
for (const name of names) {
  if (!/\.(mjs|html|css)$/.test(name)) continue;
  const source = await readFile(new URL(name, root), 'utf8');
  const expressions = name.endsWith('.mjs') ? [/\bfrom\s*['"]([^'"]+)['"]/g, /\bimport\s*['"]([^'"]+)['"]/g]
    : name.endsWith('.html') ? [/(?:src|href)="([^"#]+)"/g] : [/url\(['"]?([^'"\)]+)['"]?\)/g];
  for (const expression of expressions) for (const match of source.matchAll(expression)) checkReference(match[1], name);
}
console.log(`Pages artifact verified: ${names.size} allowed files; module, HTML and CSS references stay under /rpe-next/.`);
