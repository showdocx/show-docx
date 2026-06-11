import { runTests } from '@vscode/test-electron';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const testDataDirectory = await mkdtemp(join(tmpdir(), 'showdocx-vscode-test-'));
const installedCode = process.platform === 'win32' && process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe')
  : undefined;

try {
  await runTests({
    extensionDevelopmentPath: repositoryRoot,
    extensionTestsPath: join(
      repositoryRoot,
      'dist-test',
      'test',
      'integration',
      'suite',
      'index.js',
    ),
    launchArgs: [
      join(repositoryRoot, 'test', 'workspace'),
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      `--user-data-dir=${join(testDataDirectory, 'user-data')}`,
      `--extensions-dir=${join(testDataDirectory, 'extensions')}`,
    ],
    ...(installedCode && existsSync(installedCode)
      ? { vscodeExecutablePath: installedCode }
      : {}),
  });
} catch (error) {
  console.error('VS Code integration tests failed.');
  console.error(error);
  process.exitCode = 1;
} finally {
  await rm(testDataDirectory, { recursive: true, force: true });
}
