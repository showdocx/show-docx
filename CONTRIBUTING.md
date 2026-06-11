# Contributing to ShowDocx

## Requirements

- Node.js 20
- npm
- Visual Studio Code 1.85 or newer
- Chromium installed through Playwright

## Setup

```bash
npm ci
npx playwright install chromium
npm run generate:fixtures
```

Press `F5` in VS Code to launch the Extension Development Host.

## Before a Pull Request

1. Keep changes focused and add fixtures or tests for behavior changes.
2. Keep extension-host code Node-compatible and webview code browser-compatible.
3. Run `npm run verify`.
4. Run `npm run package` when changing packaging, metadata, or build behavior.

Do not commit generated `dist`, `dist-test`, test report, or VSIX files.
