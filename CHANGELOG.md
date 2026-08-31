# Changelog

All notable changes to ShowDocx are documented in this file.

## [Unreleased]

### Added

- **Compare a DOCX with its committed revision in the diff editor.** Right-click a `.docx` and choose **Compare with HEAD**, or run it from the editor title bar or the Command Palette. Git reports a DOCX as `Binary files differ` and the diff editor cannot open one, so both revisions are converted to readable text and served to the normal diff editor through a virtual read-only `showdocx-diff` document. ([#35](https://github.com/showdocx/show-docx/issues/35))

  The text is normalized for diffing: one line per paragraph and per table row, ordered items all written `1.` so inserting one does not renumber the rest, and embedded images reduced to a digest of their bytes. Word rewrites the whole package on every save, so without this a one-word edit reads as a full rewrite; with it, it is one changed line.

  This is the first feature that needs mammoth in the extension host, which grows `dist/extension.js` from 19 KB to 577 KB. Lazy-loading it is tracked in #30.

### Fixed

- Export as PDF now prints the page layout it renders on screen. It built the printable file from the semantic text view, so page breaks, headers, footers and page geometry were all discarded by the one command whose whole purpose is reproducing them. Starting the export from Text mode renders the page layout for it, and a document Visual mode cannot render still falls back to the text view. ([#34](https://github.com/showdocx/show-docx/issues/34))
- Visual mode uses the viewer's own page styling again. Its rules were written for the `docx` class `docx-preview` uses by default, but the renderer is configured with `showdocx-visual`, so none of them ever matched — including the print rule that breaks a page between sections.

## [1.1.1] - 2026-08-31

### Fixed

- Restored the `engines.vscode` range to `^1.85.0`. v1.1.0 raised it to `^1.93.0` with nothing requiring it, which hid the release from everyone on VS Code 1.85-1.92; they now receive it.
- The webview no longer hangs on "Receiving document..." when a chunked transfer loses a chunk or stalls. Failed transfers show the error state and its retry button.
- The comments sidebar shows one card per annotation with the real reviewer name, instead of a card per popover fragment attributed to "Reviewer".
- Changing any ShowDocx setting no longer resets the zoom level and render mode of every open document.
- The warning shown when Visual mode falls back to Text mode is no longer discarded before it is displayed.
- Search now matches phrases that span bold, italic or any other formatting change, instead of stopping at each run boundary.
- Search no longer reports matches inside content hidden from the reader, such as comment popovers.
- Search is debounced and capped at 2000 matches, so typing in a long document no longer blocks the UI on every keystroke.
- Text mode says when a document contains tracked changes, which mammoth renders as accepted.
- Ctrl/Cmd+P belongs to VS Code Quick Open again. Export as PDF is on Ctrl/Cmd+Alt+P and is rebindable.
- Command palette entries no longer show a doubled "ShowDocx: ShowDocx:" prefix.

### Changed

- macOS Extension Host tests run for real again. They had been failing since VS Code 1.110 renamed the macOS binary, hidden behind `continue-on-error`.
- In a restricted workspace ShowDocx no longer opens links a document points to, which is the restriction its `untrustedWorkspaces: limited` declaration had always claimed. Trust the workspace to enable them.

### Added

- A ShowDocx log channel and a **ShowDocx: Show Log** command. Error notifications now offer **Show Log**, and full diagnostic detail is written there rather than only to the webview console.

## [1.1.0] - 2026-08-23

### Added

- **In-Document Search**: Press `Ctrl/Cmd + F` or click the search button in the toolbar to find text, highlight matches, and navigate results in real-time.
- **Table of Contents / Outline Panel**: Collapsible outline sidebar that detects headings (`Title`, `Subtitle`, `Heading 1-6`) and jumps directly to sections.
- **Comments and Tracked Changes Sidebar**: Dedicated viewer panel for document notes, deletions, and insertions with reviewer counts.
- **Markdown & PDF Export**: Export clean Markdown (`.md`) via mammoth or print/save as PDF with print-optimized styles.
- New toolbar actions for Markdown, PDF, and sidebars, along with full VS Code keybinding and command contributions.

## [1.0.1] - 2026-06-17

### Fixed

- Declared support for VS Code Restricted Mode using the official `untrustedWorkspaces` manifest capability.

## [1.0.0] - 2026-06-11

### Added

- High-fidelity Visual mode powered by `docx-preview`.
- Theme-aware Text mode powered by `mammoth`.
- Sanitized standalone HTML export.
- Zoom controls from 25% to 400% with keyboard shortcuts.
- Persistent mode, zoom, and scroll state.
- Automatic reload when the source DOCX changes.
- Chunked transfer for large documents and a configurable 100 MB default limit.
- Loading progress, rendering warnings, retry UI, and user-friendly error states.
- Strict webview Content Security Policy and restricted external-link handling.
- Unit and VS Code Extension Host integration tests with generated DOCX fixtures.
- Cross-platform CI, VSIX packaging, and tag-based release workflows.
- Browser-level coverage for rendering, mode switching, zoom, export, printing, and chunked transfers.
- Validated automatic reloads that preserve the last valid preview when a file becomes unavailable or invalid.
- Public releases on GitHub and the Visual Studio Marketplace.
