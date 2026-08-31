/**
 * Turns the HTML mammoth produces into the line-oriented text the diff editor
 * compares. Kept free of Node and VS Code imports so the unit tests exercise the
 * real functions rather than copies of them.
 *
 * Every rule here exists to keep a diff readable. Word rewrites a DOCX wholesale
 * on every save, so a representation that shifts when the document did not turns
 * each revision into a full rewrite:
 *
 * - one line per block, so a changed paragraph is one changed line;
 * - one line per table row, so an edited cell does not move the rest;
 * - ordered items are all `1.`, which Markdown still renders as 1, 2, 3 and
 *   which keeps inserting an item from renumbering every item after it;
 * - images collapse to a digest of their bytes, because the base64 mammoth
 *   inlines is megabytes of churn no reader can compare;
 * - runs of whitespace collapse, because Word moves them around freely.
 */

import { fingerprintText } from './fingerprint';

type Attributes = Record<string, string>;

interface ElementNode {
  readonly type: 'element';
  readonly name: string;
  readonly attributes: Attributes;
  readonly children: DocumentNode[];
}

interface TextNode {
  readonly type: 'text';
  readonly value: string;
}

export type DocumentNode = ElementNode | TextNode;

const VOID_ELEMENTS = new Set(['area', 'br', 'col', 'hr', 'img', 'input', 'link', 'meta', 'wbr']);

/** Elements that start their own line rather than flowing into the current one. */
const BLOCK_ELEMENTS = new Set([
  'blockquote', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ol', 'p', 'section', 'table', 'ul',
]);

/**
 * Elements HTML closes implicitly when a sibling opens, so an unclosed tag does
 * not swallow everything after it. mammoth closes its own tags, but a parser
 * that mis-nests on one stray tag would mis-render the whole rest of a document.
 */
const CLOSED_BY_OPENING: Record<string, ReadonlySet<string>> = {
  li: new Set(['li', 'p']),
  p: new Set(['p']),
  td: new Set(['p', 'td', 'th']),
  th: new Set(['p', 'td', 'th']),
  tr: new Set(['p', 'td', 'th', 'tr']),
};

const HEADING_LEVELS: Record<string, number> = {
  h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6,
};

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

interface RenderContext {
  /** Prefix repeated on every line inside a blockquote. */
  readonly quote: string;
  /** Leading whitespace for content nested under a list item. */
  readonly indent: string;
  /** Inside a list, where a blank line between blocks would break the list up. */
  readonly tight: boolean;
}

class LineWriter {
  private readonly lines: string[] = [];

  public push(line: string): void {
    this.lines.push(line.trimEnd());
  }

  /** Separates two blocks, without opening the document or doubling up. */
  public blank(context: RenderContext): void {
    if (context.tight || this.lines.length === 0) {
      return;
    }
    if (this.lines[this.lines.length - 1] !== '') {
      this.lines.push('');
    }
  }

  public toString(): string {
    while (this.lines.length > 0 && this.lines[this.lines.length - 1] === '') {
      this.lines.pop();
    }
    return this.lines.length === 0 ? '' : `${this.lines.join('\n')}\n`;
  }
}

export function htmlToDiffText(html: string): string {
  const writer = new LineWriter();
  renderBlocks(parseHtml(html), writer, { quote: '', indent: '', tight: false });
  return writer.toString();
}

/* --------------------------------------------------------------------------
 * Parsing
 * ----------------------------------------------------------------------- */

/**
 * A tolerant parser for the small, well-formed subset of HTML mammoth emits.
 * An element it does not know is kept and recursed into rather than dropped.
 */
export function parseHtml(html: string): DocumentNode[] {
  const root: ElementNode = { type: 'element', name: '#root', attributes: {}, children: [] };
  const stack: ElementNode[] = [root];
  let index = 0;

  while (index < html.length) {
    const next = html.indexOf('<', index);
    if (next === -1) {
      appendText(stack, html.slice(index));
      break;
    }
    if (next > index) {
      appendText(stack, html.slice(index, next));
    }

    if (html.startsWith('<!--', next)) {
      const end = html.indexOf('-->', next);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', next) || html.startsWith('<?', next)) {
      const end = html.indexOf('>', next);
      index = end === -1 ? html.length : end + 1;
      continue;
    }

    const tag = readTag(html, next);
    if (!tag) {
      // A bare "<" in the text, not the start of a tag.
      appendText(stack, '<');
      index = next + 1;
      continue;
    }
    index = tag.end;

    if (tag.closing) {
      closeElement(stack, tag.name);
      continue;
    }

    closeImplicitly(stack, tag.name);
    const element: ElementNode = {
      type: 'element',
      name: tag.name,
      attributes: tag.attributes,
      children: [],
    };
    stack[stack.length - 1]?.children.push(element);
    if (!tag.selfClosing && !VOID_ELEMENTS.has(tag.name)) {
      stack.push(element);
    }
  }

  return root.children;
}

interface ParsedTag {
  readonly name: string;
  readonly attributes: Attributes;
  readonly closing: boolean;
  readonly selfClosing: boolean;
  readonly end: number;
}

function readTag(html: string, start: number): ParsedTag | undefined {
  let index = start + 1;
  const closing = html[index] === '/';
  if (closing) {
    index += 1;
  }

  const nameStart = index;
  while (index < html.length && /[a-zA-Z0-9:_-]/.test(html[index] ?? '')) {
    index += 1;
  }
  if (index === nameStart) {
    return undefined;
  }
  const name = html.slice(nameStart, index).toLowerCase();
  const attributes: Attributes = {};

  while (index < html.length) {
    while (index < html.length && /\s/.test(html[index] ?? '')) {
      index += 1;
    }
    const character = html[index];
    if (character === undefined) {
      break;
    }
    if (character === '>') {
      return { name, attributes, closing, selfClosing: false, end: index + 1 };
    }
    if (character === '/' && html[index + 1] === '>') {
      return { name, attributes, closing, selfClosing: true, end: index + 2 };
    }

    const attributeStart = index;
    while (index < html.length && !/[\s=>/]/.test(html[index] ?? '')) {
      index += 1;
    }
    if (index === attributeStart) {
      // Nothing was consumed, so skip the character rather than stalling here.
      index += 1;
      continue;
    }
    const attributeName = html.slice(attributeStart, index).toLowerCase();

    while (index < html.length && /\s/.test(html[index] ?? '')) {
      index += 1;
    }
    if (html[index] !== '=') {
      attributes[attributeName] = '';
      continue;
    }
    index += 1;
    while (index < html.length && /\s/.test(html[index] ?? '')) {
      index += 1;
    }

    const quote = html[index];
    if (quote === '"' || quote === "'") {
      index += 1;
      const closingQuote = html.indexOf(quote, index);
      const valueEnd = closingQuote === -1 ? html.length : closingQuote;
      attributes[attributeName] = decodeEntities(html.slice(index, valueEnd));
      index = valueEnd + 1;
    } else {
      const valueStart = index;
      while (index < html.length && !/[\s>]/.test(html[index] ?? '')) {
        index += 1;
      }
      attributes[attributeName] = decodeEntities(html.slice(valueStart, index));
    }
  }

  return { name, attributes, closing, selfClosing: false, end: index };
}

function appendText(stack: ElementNode[], raw: string): void {
  if (raw === '') {
    return;
  }
  stack[stack.length - 1]?.children.push({ type: 'text', value: decodeEntities(raw) });
}

/** Closes whatever the element about to open ends by existing. */
function closeImplicitly(stack: ElementNode[], opening: string): void {
  const closes = CLOSED_BY_OPENING[opening];
  if (!closes) {
    return;
  }
  while (stack.length > 1 && closes.has(stack[stack.length - 1]?.name ?? '')) {
    stack.pop();
  }
}

/**
 * Closes the nearest open element with this name. A stray closing tag whose
 * element was never opened is ignored rather than unwinding the whole stack.
 */
function closeElement(stack: ElementNode[], name: string): void {
  for (let depth = stack.length - 1; depth > 0; depth -= 1) {
    if (stack[depth]?.name === name) {
      stack.length = depth;
      return;
    }
  }
}

export function decodeEntities(value: string): string {
  if (!value.includes('&')) {
    return value;
  }
  return value.replaceAll(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const isHex = entity[1] === 'x' || entity[1] === 'X';
      const code = Number.parseInt(isHex ? entity.slice(2) : entity.slice(1), isHex ? 16 : 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/* --------------------------------------------------------------------------
 * Rendering
 * ----------------------------------------------------------------------- */

function renderBlocks(
  nodes: readonly DocumentNode[],
  writer: LineWriter,
  context: RenderContext,
): void {
  let inlineRun: DocumentNode[] = [];

  const flush = (): void => {
    if (inlineRun.length === 0) {
      return;
    }
    const pending = inlineRun;
    inlineRun = [];
    writeParagraph(renderInline(pending), writer, context);
  };

  for (const node of nodes) {
    if (!isBlock(node)) {
      inlineRun.push(node);
      continue;
    }
    flush();
    renderBlock(node, writer, context);
  }
  flush();
}

function renderBlock(node: ElementNode, writer: LineWriter, context: RenderContext): void {
  const level = HEADING_LEVELS[node.name];
  if (level !== undefined) {
    const heading = normalizeInline(renderInline(node.children).replaceAll('\n', ' '));
    if (heading !== '') {
      writer.blank(context);
      writer.push(`${context.quote}${context.indent}${'#'.repeat(level)} ${heading}`);
      writer.blank(context);
    }
    return;
  }

  switch (node.name) {
    case 'p':
      writeParagraph(renderInline(node.children), writer, context);
      return;
    case 'ul':
    case 'ol':
      renderList(node, writer, context);
      return;
    case 'table':
      renderTable(node, writer, context);
      return;
    case 'blockquote':
      writer.blank(context);
      renderBlocks(node.children, writer, { ...context, quote: `${context.quote}> ` });
      writer.blank(context);
      return;
    default:
      renderBlocks(node.children, writer, context);
  }
}

/** Writes one block of inline content, split where a <br> asked for it. */
function writeParagraph(inline: string, writer: LineWriter, context: RenderContext): void {
  const lines = inline.split('\n').map(normalizeInline).filter((line) => line !== '');
  if (lines.length === 0) {
    // Word documents are full of empty paragraphs whose count changes with every
    // edit. Dropping them keeps that out of the diff.
    return;
  }
  writer.blank(context);
  for (const line of lines) {
    writer.push(`${context.quote}${context.indent}${line}`);
  }
  writer.blank(context);
}

function renderList(node: ElementNode, writer: LineWriter, context: RenderContext): void {
  const items = node.children.filter(
    (child): child is ElementNode => child.type === 'element' && child.name === 'li',
  );
  if (items.length === 0) {
    return;
  }

  writer.blank(context);
  const marker = node.name === 'ol' ? '1.' : '-';
  for (const item of items) {
    renderListItem(item, writer, { ...context, tight: true }, marker);
  }
  writer.blank({ ...context, tight: false });
}

function renderListItem(
  item: ElementNode,
  writer: LineWriter,
  context: RenderContext,
  marker: string,
): void {
  const inline: DocumentNode[] = [];
  const blocks: ElementNode[] = [];
  for (const child of item.children) {
    if (isBlock(child)) {
      blocks.push(child);
    } else {
      inline.push(child);
    }
  }

  let text = normalizeInline(renderInline(inline).replaceAll('\n', ' '));
  if (text === '' && blocks[0]?.name === 'p') {
    // mammoth writes <li><p>text</p></li> when the item holds a styled paragraph.
    text = normalizeInline(renderInline(blocks.shift()?.children ?? []).replaceAll('\n', ' '));
  }
  writer.push(`${context.quote}${context.indent}${marker} ${text}`);

  if (blocks.length > 0) {
    renderBlocks(blocks, writer, { ...context, indent: `${context.indent}  ` });
  }
}

function renderTable(node: ElementNode, writer: LineWriter, context: RenderContext): void {
  const rows = collectRows(node).map(renderRow);
  if (rows.length === 0) {
    return;
  }
  const columns = Math.max(...rows.map((row) => row.length));
  const prefix = `${context.quote}${context.indent}`;

  writer.blank(context);
  writer.push(prefix + formatRow(rows[0] ?? [], columns));
  // The separator makes the block render as a table wherever Markdown is shown,
  // and costs one stable line that never changes on its own.
  writer.push(prefix + formatRow([], columns, '---'));
  for (const row of rows.slice(1)) {
    writer.push(prefix + formatRow(row, columns));
  }
  writer.blank({ ...context, tight: false });
}

function collectRows(node: ElementNode): ElementNode[] {
  const rows: ElementNode[] = [];
  const visit = (current: ElementNode): void => {
    for (const child of current.children) {
      if (child.type !== 'element') {
        continue;
      }
      if (child.name === 'tr') {
        rows.push(child);
      } else if (child.name !== 'table') {
        // A nested table belongs to its own cell, not to this table's rows.
        visit(child);
      }
    }
  };
  visit(node);
  return rows;
}

function renderRow(row: ElementNode): string[] {
  const cells: string[] = [];
  for (const child of row.children) {
    if (child.type !== 'element' || (child.name !== 'td' && child.name !== 'th')) {
      continue;
    }
    cells.push(renderCell(child));
    // A merged cell still occupies its columns, so the row stays aligned with
    // the rows above and below it.
    const span = Number.parseInt(child.attributes.colspan ?? '1', 10);
    for (let extra = 1; Number.isFinite(span) && extra < span; extra += 1) {
      cells.push('');
    }
  }
  return cells;
}

function renderCell(cell: ElementNode): string {
  const writer = new LineWriter();
  renderBlocks(cell.children, writer, { quote: '', indent: '', tight: true });
  const flattened = normalizeInline(writer.toString().replaceAll('\n', ' '));
  return flattened.replaceAll('|', String.raw`\|`);
}

function formatRow(cells: readonly string[], columns: number, fill = ''): string {
  const padded: string[] = [];
  for (let index = 0; index < columns; index += 1) {
    padded.push(cells[index] ?? fill);
  }
  return `| ${padded.join(' | ')} |`;
}

function renderInline(nodes: readonly DocumentNode[]): string {
  let output = '';
  for (const node of nodes) {
    if (node.type === 'text') {
      output += node.value.replaceAll(/\s+/g, ' ');
      continue;
    }
    switch (node.name) {
      case 'br':
        output += '\n';
        break;
      case 'b':
      case 'strong':
        output += emphasize(renderInline(node.children), '**');
        break;
      case 'em':
      case 'i':
        output += emphasize(renderInline(node.children), '*');
        break;
      case 'del':
      case 's':
      case 'strike':
        output += emphasize(renderInline(node.children), '~~');
        break;
      case 'code':
        output += emphasize(renderInline(node.children), '`');
        break;
      case 'a':
        output += renderAnchor(node);
        break;
      case 'img':
        output += renderImage(node);
        break;
      default:
        output += renderInline(node.children);
    }
  }
  return output;
}

function renderAnchor(node: ElementNode): string {
  const text = renderInline(node.children);
  const href = node.attributes.href ?? '';
  // Footnote and bookmark links point back into the document, at an identifier
  // mammoth generated. Showing it would be noise.
  if (href === '' || href.startsWith('#')) {
    return text;
  }
  return `[${text}](${href})`;
}

/** The longest source kept verbatim, above which it is reduced to a digest. */
const READABLE_SOURCE_LENGTH = 64;

function renderImage(node: ElementNode): string {
  const alt = node.attributes.alt?.trim() ?? '';
  const source = node.attributes.src ?? '';
  const label = alt === '' ? 'image' : alt;
  if (source === '') {
    return `![${label}]`;
  }
  // A source short enough to read is a path or a digest already. Only the
  // base64 of an image inlined into the HTML needs reducing.
  const token = source.length <= READABLE_SOURCE_LENGTH
    ? source
    : `image:${fingerprintText(source)}`;
  return `![${label}](${token})`;
}

function emphasize(text: string, marker: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  const inner = match?.[2] ?? '';
  if (inner === '') {
    return text;
  }
  return `${match?.[1] ?? ''}${marker}${inner}${marker}${match?.[3] ?? ''}`;
}

function normalizeInline(text: string): string {
  return text.replaceAll(/[^\S\n]+/g, ' ').trim();
}

function isBlock(node: DocumentNode): node is ElementNode {
  return node.type === 'element'
    && (BLOCK_ELEMENTS.has(node.name) || HEADING_LEVELS[node.name] !== undefined);
}
