import type { DocumentProperties } from './types';

/**
 * Turning a document's stated properties into the rows a reader sees. Kept free
 * of the DOM so the unit tests exercise the real functions rather than copies
 * of them.
 */

export interface PropertyRow {
  readonly label: string;
  readonly value: string;
}

/**
 * The rows worth showing, in the order a reader asks for them: what the document
 * is and who touched it, then the machinery that produced it. A property the
 * document does not state is left out rather than shown empty — a panel of blank
 * fields says nothing.
 */
export function toRows(properties: DocumentProperties | undefined): PropertyRow[] {
  if (!properties) {
    return [];
  }
  const rows: PropertyRow[] = [];
  const add = (label: string, value: string | number | undefined): void => {
    const text = typeof value === 'number' ? String(value) : value?.trim();
    if (text) {
      rows.push({ label, value: text });
    }
  };

  add('Title', properties.title);
  add('Subject', properties.subject);
  add('Author', properties.creator);
  add('Last modified by', properties.lastModifiedBy);
  add('Created', formatDate(properties.created));
  add('Modified', formatDate(properties.modified));
  add('Revision', properties.revision);
  add('Category', properties.category);
  add('Keywords', properties.keywords);
  add('Description', properties.description);
  add('Company', properties.company);
  add('Template', properties.template);
  add('Application', properties.application);
  return rows;
}

/**
 * A date the way the reader's own machine writes it. A value that cannot be
 * parsed is shown as it was stored rather than dropped: it is still what the
 * document says.
 */
export function formatDate(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
