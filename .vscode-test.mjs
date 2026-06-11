import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'dist-test/test/integration/*.test.js',
  version: 'stable',
  extensionDevelopmentPath: '.',
  workspaceFolder: './test/workspace',
  launchArgs: [
    '--disable-extensions',
    '--skip-welcome',
    '--skip-release-notes',
  ],
  mocha: {
    color: true,
    timeout: 20_000,
    ui: 'bdd',
  },
});
