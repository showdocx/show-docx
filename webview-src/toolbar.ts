import type { RenderMode } from './types';

interface ToolbarCallbacks {
  onModeChange(mode: RenderMode): void;
  onZoomIn(): void;
  onZoomOut(): void;
  onZoomReset(): void;
  onExport(): void;
  onPrint(): void;
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
  private readonly printButton = getButton('print-button');

  public constructor(callbacks: ToolbarCallbacks) {
    this.visualButton.addEventListener('click', () => callbacks.onModeChange('visual'));
    this.textButton.addEventListener('click', () => callbacks.onModeChange('text'));
    getButton('zoom-in').addEventListener('click', callbacks.onZoomIn);
    getButton('zoom-out').addEventListener('click', callbacks.onZoomOut);
    this.zoomValue.addEventListener('click', callbacks.onZoomReset);
    this.exportButton.addEventListener('click', callbacks.onExport);
    this.printButton.addEventListener('click', callbacks.onPrint);
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
  }

  public updateZoom(zoom: number): void {
    this.zoomValue.textContent = `${zoom}%`;
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
    this.printButton.toggleAttribute('disabled', busy);
  }
}

function getElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing toolbar element: ${id}`);
  }
  return element;
}

function getButton(id: string): HTMLButtonElement {
  const element = getElement(id);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`Expected button element: ${id}`);
  }
  return element;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[index]}`;
}
