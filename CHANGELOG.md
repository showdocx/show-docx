# Changelog

All notable changes to ShowDocx are documented in this file.

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
