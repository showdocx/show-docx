# Changelog

All notable changes to ShowDocx are documented in this file.

## [Unreleased]

### Added

- **An `@docx` chat participant.** Ask about the Word document you have open — "summarize this contract", "what does clause 4 say" — in the chat panel the editor already has. ShowDocx calls no model: it hands the document to the model your own chat is already using, so this costs nothing and sends nothing anywhere ShowDocx chose. The participant is told to answer only from the document and to say when the document does not contain the answer; a document too long to fit is cut at a line boundary and the answer says so. ([#47](https://github.com/showdocx/show-docx/issues/47))

- **A right-click menu on selected text**: copy it, find it in this document, or find it in every Word document in the workspace. Every entry is a shortcut into something the viewer already did; "where else does this appear?" no longer means retyping the phrase into the find bar. With nothing selected the editor's own menu is left alone. ([#53](https://github.com/showdocx/show-docx/issues/53))
- **A page indicator** in Visual mode — which page is on screen, updated as you scroll, and a prompt to jump to another. Hidden in Text mode, which has no pages, rather than showing a number that means nothing there. ([#52](https://github.com/showdocx/show-docx/issues/52))

### Changed

- The comments sidebar reads the document's own comments and tracked changes instead of walking the rendered page. It was empty in Text mode, which the README listed as a limitation but which reads as a bug — reviewing comments is often the reason a document is opened at all. Cards now carry the real author and date, say when a comment is resolved or is a reply, and show the text a deletion removed, which Text mode drops entirely. Following a card to its place still needs Visual mode, which is the only mode that renders anchors. ([#45](https://github.com/showdocx/show-docx/issues/45))
- The outline is built from the heading styles the document declares rather than from CSS class names containing "heading" or "title". The old guess both invented entries — a caption or a table-of-contents style counted — and missed real headings in documents whose styles are not named in English. Levels come from `w:outlineLvl`, from the canonical style name Word stores in English, or from the style a heading is based on. ([#46](https://github.com/showdocx/show-docx/issues/46))

### Added

- **A document properties sidebar** — title, author, who last modified it, created and modified dates, revision, and what produced the file. A property the document does not state is left out rather than shown blank. ([#49](https://github.com/showdocx/show-docx/issues/49))
- **Pages, words and reading time in the status bar** while a document is open, and clicking it opens the properties. The page count is the pages the viewer actually rendered, falling back to what Word recorded — which is absent from documents written by anything else. ([#51](https://github.com/showdocx/show-docx/issues/51))
- **Extract Images**, which writes every picture in a document to a folder. The pictures are already stored in the package as ordinary files, so they are copied rather than decoded, and a picture stored twice is written once. ([#50](https://github.com/showdocx/show-docx/issues/50))

### Changed

- A hidden tab no longer keeps its document and rendered page in memory. `retainContextWhenHidden` was set on every panel, so memory grew with each open document for content nobody was looking at — VS Code's own documentation calls that overhead high. Returning to a tab now re-renders it, measured at about 190ms for a document of 4,000 paragraphs, and the reading position is restored either way. `showDocx.retainHiddenTabs` turns the old behaviour back on. ([#13](https://github.com/showdocx/show-docx/issues/13))

### Added

- **Search inside every Word document in the workspace.** VS Code's own search skips these files because they are binary, so a folder of forty specifications could not answer "which one mentions this clause?" without opening each by hand. Matches appear as you type, with the line they were found on; choosing one opens the document with the term already in its search bar. Text is cached against each file's modification time, so only the first search reads the files. ([#43](https://github.com/showdocx/show-docx/issues/43))

  Headers and footers are searched, because that is where a document number or title usually lives. Field codes and text removed by a tracked change are not: neither is text the reader sees.

- **`showDocx.exportLocation`**, which can write an export next to the document instead of asking every time. Anyone converting the same documents repeatedly was filling in an identical save dialog with no decision behind it. Writing over an existing file still asks first. ([#42](https://github.com/showdocx/show-docx/issues/42))

### Added

- **Compare a DOCX with its committed revision in the diff editor.** Right-click a `.docx` and choose **Compare with HEAD**, or run it from the editor title bar or the Command Palette. Git reports a DOCX as `Binary files differ` and the diff editor cannot open one, so both revisions are converted to readable text and served to the normal diff editor through a virtual read-only `showdocx-diff` document. ([#35](https://github.com/showdocx/show-docx/issues/35))

  The text is normalized for diffing: one line per paragraph and per table row, ordered items all written `1.` so inserting one does not renumber the rest, and embedded images reduced to a digest of their bytes. Word rewrites the whole package on every save, so without this a one-word edit reads as a full rewrite; with it, it is one changed line.

  This is the first feature that needs mammoth in the extension host, which grows `dist/extension.js` from 19 KB to 577 KB. Lazy-loading it is tracked in #30.

- **AI agents in your editor can read `.docx` files.** ShowDocx registers a `showdocx_readDocx` language model tool that returns a document as Markdown, so Copilot agent mode — or anything using the same API — reads `spec.docx` instead of giving up on a ZIP archive. Reference it in a prompt as `#docx`. ([#36](https://github.com/showdocx/show-docx/issues/36))

  ShowDocx calls no model and makes no outbound request: the user's own agent asks this extension for text. Only `.docx` files inside the open workspace can be read, because a model's arguments can be steered by whatever it has read.

  The API needs VS Code 1.95, and `engines` stays at `^1.85.0`. The API is detected at runtime and the tool is simply not registered where it is absent.

- **Page themes for Visual mode: paper, sepia and dark.** The page background was hardcoded white, which is a poor answer for the majority of users who run a dark editor. Cycle it from the toolbar or set `showDocx.defaultPageTheme`. Dark inverts the rendered page and rotates the hue back, so colours stay recognizable; images, SVG and video are inverted a second time and keep their own colours. Printing and the PDF export are unaffected — they print what the document says. ([#37](https://github.com/showdocx/show-docx/issues/37))
- **Reading position, mode, zoom and page theme are remembered per document, across sessions.** They were kept only while the editor stayed open, which is fine for a short document and useless for the long specification this viewer is for. The 100 most recently opened documents are remembered. ([#38](https://github.com/showdocx/show-docx/issues/38))

- **Copy the document to the clipboard as Markdown or plain text**, from the toolbar or the Command Palette. Getting the content into an issue or a message was an export, a save dialog, a location, opening the file, selecting all, copying, and deleting the file. ([#39](https://github.com/showdocx/show-docx/issues/39))
- **`.docm`, `.dotx` and `.dotm` open alongside `.docx`.** All four are the same OOXML package, and corporate repositories are full of templates and forms. A macro is never executed: ShowDocx reads the document parts and never opens `vbaProject.bin`. ([#40](https://github.com/showdocx/show-docx/issues/40))
- **Fit to width and fit to page**, plus `Ctrl/Cmd` + wheel for continuous zoom. A fit is a mode rather than a one-shot action: resizing the panel refits the page instead of leaving it at the width the panel used to be. ([#41](https://github.com/showdocx/show-docx/issues/41))

### Changed

- Markdown now comes from one converter, whichever way it is asked for — exported, copied, or read by an agent. The export used mammoth's Markdown writer, which flattens a table into one paragraph per cell and escapes ordinary punctuation, so the same document had two different Markdown answers. Tables keep their rows now, and a hyphen stays a hyphen. Embedded images become a short placeholder rather than inlined base64.

### Fixed

- The viewer fills the height of the editor. The app shell declared three grid rows for four children, of which only two are ever in flow — the warnings panel is hidden until there is a warning, and the search bar is positioned outside the flow — so the document area took its content height and left the rest of the editor empty. A short document in Text mode showed this as a half-empty window with a sidebar that stopped partway down.
- The document is centred in the editor again. The viewport is a flex item and had no `flex` of its own, so it sized itself to a single page: on any window wider than one page the document sat against the left edge with the rest of the editor empty.
- Zooming past the width of the editor no longer puts the left margin of the page out of reach. Zoom scaled the page with a transform, which paints at a new size without changing the layout box, so the page overflowed equally in both directions and scrolling could not reach what had gone off to the left. It scales the layout box now, so every zoom level stays fully reachable.
- Reloading a document after it changes on disk no longer resets the reader's mode and zoom to the configured defaults. Word rewrites a file several times during one save, so this could throw away the view mid-read.
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
