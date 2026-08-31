import { getButton, getElement } from './dom';
import { toRows } from './propertyRows';
import type { DocumentProperties } from './types';

/**
 * What the document says about itself: who wrote it, when, which revision.
 * "Which revision is this, and who wrote it?" is a question a contract or a
 * specification raises constantly, and in Word it takes several clicks.
 *
 * The values come from the package's own property parts, read in the extension
 * host. Anything the document does not state is left out rather than shown
 * empty, so the panel is a list of facts rather than a form with gaps.
 */

export class PropertiesController {
  private readonly sidebar = getElement('properties-sidebar');
  private readonly list = getElement('properties-list');
  private readonly toggleButton = getButton('properties-toggle');
  private properties: DocumentProperties | undefined;

  public constructor(private readonly onOpen: (isOpen: boolean) => void) {
    this.toggleButton.addEventListener('click', () => this.toggle());
    getButton('properties-close').addEventListener('click', () => this.close());
  }

  public get isOpen(): boolean {
    return !this.sidebar.classList.contains('hidden');
  }

  public update(properties: DocumentProperties | undefined): void {
    this.properties = properties;
    if (this.isOpen) {
      this.render();
    }
  }

  public toggle(): void {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  public open(): void {
    this.render();
    this.sidebar.classList.remove('hidden');
    this.toggleButton.setAttribute('aria-pressed', 'true');
    this.onOpen(true);
  }

  public close(): void {
    this.sidebar.classList.add('hidden');
    this.toggleButton.setAttribute('aria-pressed', 'false');
    this.onOpen(false);
  }

  private render(): void {
    this.list.replaceChildren();
    const rows = toRows(this.properties);
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sidebar-empty';
      empty.textContent = 'This document states no properties.';
      this.list.append(empty);
      return;
    }

    const table = document.createElement('dl');
    table.className = 'properties-table';
    for (const row of rows) {
      const term = document.createElement('dt');
      term.textContent = row.label;
      const value = document.createElement('dd');
      value.textContent = row.value;
      value.title = row.value;
      table.append(term, value);
    }
    this.list.append(table);
  }
}
