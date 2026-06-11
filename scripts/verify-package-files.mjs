import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const output = execFileSync(
  process.execPath,
  [resolve('node_modules', '@vscode', 'vsce', 'vsce'), 'ls', '--no-dependencies'],
  { encoding: 'utf8' },
);
const files = output
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);
const allowedFiles = new Set([
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'package.json',
]);
const allowedPrefixes = ['dist/', 'media/'];
const unexpected = files.filter((file) => (
  !allowedFiles.has(file)
  && !allowedPrefixes.some((prefix) => file.startsWith(prefix))
));

if (unexpected.length > 0) {
  throw new Error(`Unexpected VSIX files:\n${unexpected.join('\n')}`);
}

for (const required of ['dist/extension.js', 'dist/webview/main.js', 'dist/webview/main.css']) {
  if (!files.includes(required)) {
    throw new Error(`Required VSIX file is missing: ${required}`);
  }
}

console.log(`Verified ${files.length} VSIX files.`);
