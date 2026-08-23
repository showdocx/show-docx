# Changelog

All notable changes to ShowDocx are documented in this file.

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
