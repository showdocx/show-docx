import { FIT_MODE_LABELS, PAGE_THEME_LABELS } from './types';
import type { FitMode, PageTheme, RenderMode } from './types';
import { getButton, getElement } from './dom';
import { formatBytes } from '../shared/format';

interface ToolbarCallbacks {
  onModeChange(mode: RenderMode): void;
  onZoomIn(): void;
  onZoomOut(): void;
  onZoomReset(): void;
  onExport(): void;
  onExportMarkdown(): void;
  onCopyMarkdown(): void;
  onCopyText(): void;
  onExportPdf(): void;
  onSearchToggle(): void;
  onPrint(): void;
  onCyclePageTheme(): void;
  onCycleFit(): void;
}

function nextFit(fit: FitMode): FitMode {
  if (fit === 'none') {
    return 'width';
  }
  return fit === 'width' ? 'page' : 'none';
}

export class Toolbar {
  private readonly fileName = getElement('file-name');
  private readonly fileSize = getElement('file-size');
  private readonly visualButton = getButton('mode-visual');
  private readonly textButton = getButton('mode-text');
  private readonly zoomValue = getButton('zoom-reset');
  private readonly warningsButton = getButton('warnings-button');
  private readonly warningCount = getElement('warning-count');
  private readonly warningsPanel = getElement('warnings-panel');
  private readonly exportButton = getButton('export-button');
  private readonly exportMdButton = getButton('export-md-button');
  private readonly exportPdfButton = getButton('export-pdf-button');
  private readonly copyMdButton = getButton('copy-md-button');
  private readonly copyTextButton = getButton('copy-text-button');
  private readonly searchToggleButton = getButton('search-toggle');
  private readonly printButton = getButton('print-button');
  private readonly pageThemeButton = getButton('page-theme-button');
  private readonly fitButton = getButton('fit-button');

  public constructor(callbacks: ToolbarCallbacks) {
    this.visualButton.addEventListener('click', () => callbacks.onModeChange('visual'));
    this.textButton.addEventListener('click', () => callbacks.onModeChange('text'));
    getButton('zoom-in').addEventListener('click', callbacks.onZoomIn);
    getButton('zoom-out').addEventListener('click', callbacks.onZoomOut);
    this.zoomValue.addEventListener('click', callbacks.onZoomReset);
    this.exportButton.addEventListener('click', callbacks.onExport);
    this.exportMdButton.addEventListener('click', callbacks.onExportMarkdown);
    this.exportPdfButton.addEventListener('click', callbacks.onExportPdf);
    this.copyMdButton.addEventListener('click', callbacks.onCopyMarkdown);
    this.copyTextButton.addEventListener('click', callbacks.onCopyText);
    this.searchToggleButton.addEventListener('click', callbacks.onSearchToggle);
    this.printButton.addEventListener('click', callbacks.onPrint);
    this.pageThemeButton.addEventListener('click', callbacks.onCyclePageTheme);
    this.fitButton.addEventListener('click', callbacks.onCycleFit);
    this.warningsButton.addEventListener('click', () => {
      this.warningsPanel.classList.toggle('hidden');
      const expanded = !this.warningsPanel.classList.contains('hidden');
      this.warningsButton.setAttribute('aria-expanded', String(expanded));
    });
  }

  public updateDocument(fileName: string, bytes: number): void {
    this.fileName.textContent = fileName;
    this.fileName.title = fileName;
    this.fileSize.textContent = formatBytes(bytes);
  }

  public updateMode(mode: RenderMode): void {
    const visualActive = mode === 'visual';
    this.visualButton.classList.toggle('active', visualActive);
    this.textButton.classList.toggle('active', !visualActive);
    this.visualButton.setAttribute('aria-pressed', String(visualActive));
    this.textButton.setAttribute('aria-pressed', String(!visualActive));
    // Text mode is drawn in the editor's own colours, so a page theme would be
    // a control with nothing to act on.
    this.pageThemeButton.classList.toggle('hidden', !visualActive);
    // Text mode is already as wide as the panel allows, so there is nothing for
    // a fit to do there.
    this.fitButton.classList.toggle('hidden', !visualActive);
  }

  public updatePageTheme(theme: PageTheme, next: PageTheme): void {
    const label = `Page theme: ${PAGE_THEME_LABELS[theme]} (switch to ${PAGE_THEME_LABELS[next]})`;
    this.pageThemeButton.title = label;
    this.pageThemeButton.setAttribute('aria-label', label);
    this.pageThemeButton.dataset.theme = theme;
  }

  public updateZoom(zoom: number, fit: FitMode): void {
    this.zoomValue.textContent = `${zoom}%`;
    const label = fit === 'none'
      ? 'Fit the page to the panel (click for fit width)'
      : `${FIT_MODE_LABELS[fit]} (click for ${FIT_MODE_LABELS[nextFit(fit)]})`;
    this.fitButton.title = label;
    this.fitButton.setAttribute('aria-label', label);
    this.fitButton.classList.toggle('active', fit !== 'none');
  }

  public updateWarnings(messages: string[]): void {
    this.warningsPanel.replaceChildren();
    if (messages.length === 0) {
      this.warningsButton.classList.add('hidden');
      this.warningsPanel.classList.add('hidden');
      return;
    }

    this.warningCount.textContent = String(messages.length);
    this.warningsButton.classList.remove('hidden');
    const heading = document.createElement('strong');
    heading.textContent = 'Rendering notes';
    const list = document.createElement('ul');
    for (const message of messages) {
      const item = document.createElement('li');
      item.textContent = message;
      list.append(item);
    }
    this.warningsPanel.append(heading, list);
  }

  public setBusy(busy: boolean): void {
    this.exportButton.toggleAttribute('disabled', busy);
    this.exportMdButton.toggleAttribute('disabled', busy);
    this.exportPdfButton.toggleAttribute('disabled', busy);
    this.copyMdButton.toggleAttribute('disabled', busy);
    this.copyTextButton.toggleAttribute('disabled', busy);
    this.printButton.toggleAttribute('disabled', busy);
  }
}

