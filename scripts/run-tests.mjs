import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
// --restricted runs the Restricted Mode tests in an untrusted workspace.
const restricted = process.argv.includes('--restricted');
// --vscode=<version> runs against that release rather than the installed one,
// so the version engines promises can be tested.
const version = process.argv.find((argument) => argument.startsWith('--vscode='))?.slice('--vscode='.length);
const testDataDirectory = await mkdtemp(join(tmpdir(), 'showdocx-vscode-test-'));
const installedCode = process.platform === 'win32' && process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe')
  : undefined;

const extensionTestsPath = join(repositoryRoot, 'dist-test', 'test', 'integration', 'suite', 'index.js');
const launchArgs = [
  join(repositoryRoot, 'test', 'workspace'),
  '--disable-extensions',
  '--skip-welcome',
  '--skip-release-notes',
  '--disable-gpu',
  '--disable-updates',
  `--user-data-dir=${join(testDataDirectory, 'user-data')}`,
  `--extensions-dir=${join(testDataDirectory, 'extensions')}`,
];

async function executable() {
  if (version) {
    return downloadAndUnzipVSCode({ version });
  }
  if (installedCode && existsSync(installedCode)) {
    return installedCode;
  }
  return downloadAndUnzipVSCode({});
}

/**
 * runTests always adds --disable-workspace-trust, which makes every folder
 * trusted, so Restricted Mode cannot be reached through it. This starts VS
 * Code the same way, without that one argument.
 */
function runUntrusted(codePath) {
  const args = [
    ...launchArgs,
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--no-cached-data',
    `--extensionTestsPath=${extensionTestsPath}`,
    `--extensionDevelopmentPath=${repositoryRoot}`,
  ];
  const env = { ...process.env, SHOWDOCX_RESTRICTED: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve, reject) => {
    const child = spawn(codePath, args, { env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Restricted Mode tests failed (exit ${code ?? signal}).`));
      }
    });
  });
}

try {
  const codePath = await executable();
  if (restricted) {
    await runUntrusted(codePath);
  } else {
    await runTests({
      vscodeExecutablePath: codePath,
      extensionDevelopmentPath: repositoryRoot,
      extensionTestsPath,
      launchArgs: [...launchArgs, '--disable-workspace-trust'],
    });
  }
} catch (error) {
  console.error('VS Code integration tests failed.');
  console.error(error);
  process.exitCode = 1;
} finally {
  await rm(testDataDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}
