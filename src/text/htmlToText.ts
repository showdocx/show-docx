/**
 * Turns the HTML mammoth produces into the line-oriented text the diff editor
 * compares. Kept free of Node and VS Code imports so the unit tests exercise the
 * real functions rather than copies of them.
 *
 * Two callers read this text: the diff editor, and the language model tool. The
 * rules below are shared, because both want structure without noise.
 *
 * Most of them exist to keep a diff readable. Word rewrites a DOCX wholesale on
 * every save, so a representation that shifts when the document did not turns
 * each revision into a full rewrite:
 *
 * - one line per block, so a changed paragraph is one changed line;
 * - one line per table row, so an edited cell does not move the rest;
 * - ordered items are all `1.`, which Markdown still renders as 1, 2, 3 and
 *   which keeps inserting an item from renumbering every item after it;
 * - images collapse to a digest of their bytes, because the base64 mammoth
 *   inlines is megabytes of churn no reader can compare;
 * - runs of whitespace collapse, because Word moves them around freely.
 *
 * What the document says is written as text, never as syntax: a paragraph
 * that begins with "#" is not a heading, "2*3*4" has no italics, and
 * "List<String>" is not an HTML tag. Escapes are added only where a character
 * could be read as Markdown, so ordinary prose, file_names and "2 < 3" stay as
 * they are.
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

export interface TextOptions {
  /**
   * Write every ordered item as `1.`. Markdown still renders 1, 2, 3, and a
   * list renumbered by an insertion stays a one-line diff. Turn it off where the
   * numbers themselves are the information a reader needs.
   */
  readonly stableOrderedNumbers?: boolean;
}

interface RenderContext {
  readonly options: Required<TextOptions>;
  /** Prefix repeated on every line inside a blockquote. */
  readonly quote: string;
  /** Leading whitespace for content nested under a list item. */
  readonly indent: string;
  /** Inside a list, where a blank line between blocks would break the list up. */
  readonly tight: boolean;
  readonly tableBudget: { cellsRemaining: number };
}

const MAX_OUTPUT_CHARACTERS = 4 * 1024 * 1024;
const TEXT_TRUNCATION_NOTICE = '[text truncated: safety limit reached]';

class LineWriter {
  private readonly lines: string[] = [];
  private characters = 0;
  public truncated = false;

  public get remainingCharacters(): number {
    return MAX_OUTPUT_CHARACTERS - TEXT_TRUNCATION_NOTICE.length - 2 - this.characters;
  }

  public push(line: string): void {
    if (this.truncated) {return;}
    const trimmed = line.trimEnd();
    const remaining = this.remainingCharacters;
    if (trimmed.length + 1 > remaining) {
      this.lines.push(trimmed.slice(0, Math.max(0, remaining - 1)));
      this.truncated = true;
      return;
    }
    this.lines.push(trimmed);
    this.characters += trimmed.length + 1;
  }

  /** Separates two blocks, without opening the document or doubling up. */
  public blank(context: RenderContext): void {
    if (context.tight || this.lines.length === 0) {
      return;
    }
    if (this.lines[this.lines.length - 1] !== '') {
      this.push('');
    }
  }

  public toString(): string {
    while (this.lines.length > 0 && this.lines[this.lines.length - 1] === '') {
      this.lines.pop();
    }
    if (this.truncated) {return `${this.lines.join('\n')}\n${TEXT_TRUNCATION_NOTICE}\n`;}
    return this.lines.length === 0 ? '' : `${this.lines.join('\n')}\n`;
  }
}

export function htmlToText(html: string, options: TextOptions = {}): string {
  const writer = new LineWriter();
  renderBlocks(parseHtml(html), writer, {
    quote: '',
    indent: '',
    tight: false,
    options: { stableOrderedNumbers: options.stableOrderedNumbers ?? true },
    tableBudget: { cellsRemaining: MAX_TABLE_CELLS },
  });
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
    if (writer.truncated) {break;}
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
    const heading = escapeClosingHashes(normalizeInline(renderInline(node.children).replaceAll('\n', ' ')));
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
    if (writer.truncated) {break;}
    writer.push(`${context.quote}${context.indent}${escapeLineStart(line)}`);
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
  const ordered = node.name === 'ol';
  const stable = context.options.stableOrderedNumbers;
  let position = 0;
  for (const item of items) {
    if (writer.truncated) {break;}
    position += 1;
    const marker = ordered ? `${stable ? 1 : position}.` : '-';
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
  writer.push(`${context.quote}${context.indent}${marker} ${escapeLineStart(text)}`);

  if (blocks.length > 0) {
    renderBlocks(blocks, writer, { ...context, indent: `${context.indent}  ` });
  }
}

const MAX_TABLE_ROWS = 10000;
const MAX_TABLE_COLUMNS = 1000;
const MAX_TABLE_CELLS = 100000;

const TABLE_TRUNCATION_NOTICE = '[table truncated: safety limit reached]';

function renderTable(node: ElementNode, writer: LineWriter, context: RenderContext): void {
  const collected = collectRows(node);
  const rows: Array<Array<ElementNode | undefined>> = [];
  let cellsRemaining = context.tableBudget.cellsRemaining;
  let truncated = collected.truncated;
  let columns = 1;

  for (const row of collected.rows) {
    if (cellsRemaining <= 0) {
      truncated = true;
      break;
    }
    const planned = planRow(row, Math.min(MAX_TABLE_COLUMNS, cellsRemaining));
    rows.push(planned.cells);
    cellsRemaining -= planned.cells.length;
    columns = Math.max(columns, planned.cells.length);
    truncated ||= planned.truncated;
  }
  if (collected.rows.length === 0) {return;}

  const available = context.tableBudget.cellsRemaining;
  if (available < 3) {
    writeParagraph(TABLE_TRUNCATION_NOTICE, writer, context);
    return;
  }
  // Budget the actual rectangle, not just source cells: padding, separator and
  // a possible notice all occupy columns. Reserve it before rendering nested tables.
  const outputColumns = Math.min(columns, Math.floor(available / 3));
  truncated ||= outputColumns < columns;
  let rowLimit = Math.floor(available / outputColumns) - 1;
  truncated ||= rows.length > rowLimit;
  if (truncated) {rowLimit -= 1;}
  const outputRows = rows.slice(0, rowLimit);
  context.tableBudget.cellsRemaining -= (outputRows.length + 1 + (truncated ? 1 : 0)) * outputColumns;
  const prefix = context.quote + context.indent;

  writer.blank(context);
  for (let index = 0; index < outputRows.length; index += 1) {
    if (writer.truncated) {break;}
    const cells: string[] = [];
    const row = outputRows[index] ?? [];
    let characters = prefix.length + outputColumns * 3 + 1;
    for (const cell of row.slice(0, outputColumns)) {
      if (characters + 1 > writer.remainingCharacters) {break;}
      const text = cell ? renderCell(cell, context) : '';
      cells.push(text);
      characters += text.length;
    }
    writer.push(prefix + formatRow(cells, outputColumns));
    if (index === 0) {writer.push(prefix + formatRow([], outputColumns, '---'));}
  }
  if (truncated && !writer.truncated) {
    writer.push(prefix + formatRow([TABLE_TRUNCATION_NOTICE], outputColumns));
  }
  writer.blank({ ...context, tight: false });
}

function collectRows(node: ElementNode): { rows: ElementNode[]; truncated: boolean } {
  const rows: ElementNode[] = [];
  const pending: ElementNode[] = [];
  for (let index = node.children.length - 1; index >= 0; index -= 1) {
    const child = node.children[index];
    if (child?.type === 'element') {pending.push(child);}
  }

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {continue;}
    if (current.name === 'tr') {
      if (rows.length >= MAX_TABLE_ROWS) {
        return { rows, truncated: true };
      }
      rows.push(current);
    } else if (current.name !== 'table') {
      // A nested table belongs to its own cell, not to this table's rows.
      for (let index = current.children.length - 1; index >= 0; index -= 1) {
        const child = current.children[index];
        if (child?.type === 'element') {pending.push(child);}
      }
    }
  }
  return { rows, truncated: false };
}

function planRow(row: ElementNode, maxCells: number): { cells: Array<ElementNode | undefined>; truncated: boolean } {
  const cells: Array<ElementNode | undefined> = [];
  let truncated = false;
  for (const child of row.children) {
    if (child.type !== 'element' || (child.name !== 'td' && child.name !== 'th')) {continue;}
    if (cells.length >= maxCells) {
      truncated = true;
      break;
    }
    const parsedSpan = Number.parseInt(child.attributes.colspan ?? '1', 10);
    const requestedSpan = parsedSpan > 0 ? parsedSpan : 1;
    const span = Math.min(requestedSpan, MAX_TABLE_COLUMNS, maxCells - cells.length);
    truncated ||= span < requestedSpan;
    cells.push(child);
    // A merged cell still occupies its columns, so the row stays aligned with
    // the rows above and below it.
    for (let extra = 1; extra < span; extra += 1) {cells.push(undefined);}
  }
  return { cells, truncated };
}
function renderCell(cell: ElementNode, context: RenderContext): string {
  const writer = new LineWriter();
  renderBlocks(cell.children, writer, { ...context, quote: '', indent: '', tight: true });
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

interface InlineContext {
  /** Inside a link's own text, where any bracket would end it early. */
  readonly linkText: boolean;
}

const PLAIN_TEXT: InlineContext = { linkText: false };

function renderInline(nodes: readonly DocumentNode[], context: InlineContext = PLAIN_TEXT): string {
  let output = '';
  for (const node of nodes) {
    if (node.type === 'text') {
      output += escapeInline(node.value.replaceAll(/\s+/g, ' '), context);
      continue;
    }
    switch (node.name) {
      case 'br':
        output += '\n';
        break;
      case 'b':
      case 'strong':
        output += emphasize(renderInline(node.children, context), '**');
        break;
      case 'em':
      case 'i':
        output += emphasize(renderInline(node.children, context), '*');
        break;
      case 'del':
      case 's':
      case 'strike':
        output += emphasize(renderInline(node.children, context), '~~');
        break;
      case 'code':
        output += renderCode(node);
        break;
      case 'a':
        // A link inside a link's text cannot be written; its text still can.
        output += context.linkText ? renderInline(node.children, context) : renderAnchor(node);
        break;
      case 'img':
        output += renderImage(node);
        break;
      default:
        output += renderInline(node.children, context);
    }
  }
  return output;
}

function renderAnchor(node: ElementNode): string {
  const href = node.attributes.href ?? '';
  // Footnote and bookmark links point back into the document, at an identifier
  // mammoth generated. Showing it would be noise.
  if (href === '' || href.startsWith('#')) {
    return renderInline(node.children);
  }
  return `[${renderInline(node.children, { linkText: true })}](${linkDestination(href)})`;
}

/**
 * A link target as Markdown accepts it. A space or a parenthesis would end the
 * link early, so such a target is written in angle brackets, the form
 * CommonMark keeps for exactly that.
 */
function linkDestination(href: string): string {
  if (!/[\s<>()]/.test(href)) {
    return href;
  }
  return `<${href.replaceAll('<', '%3C').replaceAll('>', '%3E')}>`;
}

/** Code is literal: no escapes inside, and a fence longer than any run of backticks in it. */
function renderCode(node: ElementNode): string {
  const text = textOf(node).replaceAll(/\s+/g, ' ');
  if (text.trim() === '') {
    return text;
  }
  const runs = [...text.matchAll(/`+/g)].map((run) => run[0].length);
  let maxRun = 0;
  for (const len of runs) {
    if (len > maxRun) {
      maxRun = len;
    }
  }
  const fence = '`'.repeat(maxRun + 1);
  const padding = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${padding}${text}${padding}${fence}`;
}

function textOf(node: DocumentNode): string {
  return node.type === 'text' ? node.value : node.children.map(textOf).join('');
}

/**
 * Escapes what Markdown could read as syntax in a run of document text,
 * wherever it stands. Each rule escapes as little as it can:
 *
 * - `*`, a backtick and `~` always: each can open emphasis, code or a
 *   strikethrough anywhere, even inside a word;
 * - `_` only at the edge of a word, because inside one it never means
 *   emphasis, and file_names stay readable;
 * - `]` only where a link could follow, before `(` or `[`, and both brackets
 *   anywhere in a link's own text;
 * - `<` only where it could open a tag or an autolink, so "2 < 3" is left be;
 * - `&` only where it could start an entity;
 * - a backslash only before punctuation, the one place it escapes anything.
 */
function escapeInline(text: string, context: InlineContext): string {
  let output = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (needsEscape(text, index, context)) {
      output += BACKSLASH;
    }
    output += character;
  }
  return output;
}

const BACKSLASH = String.fromCharCode(0x5c);
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
const ENTITY = /^&(?:#\d{1,7}|#[xX][\da-fA-F]{1,6}|[A-Za-z][A-Za-z\d]{0,31});/;

function needsEscape(text: string, index: number, context: InlineContext): boolean {
  const character = text.charAt(index);
  const previous = text.charAt(index - 1);
  const next = text.charAt(index + 1);
  switch (character) {
    case '*':
    case '`':
    case '~':
      return true;
    case '_':
      return !(isWordCharacter(previous) && isWordCharacter(next));
    case '[':
      return context.linkText;
    case ']':
      return context.linkText || next === '(' || next === '[';
    case '<':
      return /[A-Za-z/!?]/.test(next);
    case '&':
      return ENTITY.test(text.slice(index, index + 40));
    case BACKSLASH:
      return ASCII_PUNCTUATION.test(next);
    default:
      return false;
  }
}

function isWordCharacter(character: string): boolean {
  return /[\p{L}\p{N}]/u.test(character);
}

/**
 * Escapes what would make a line a block of its own: a heading, a quote, a
 * list item, a rule, a setext underline or a reference definition.
 */
const BLOCK_STARTS = [
  /^#{1,6}(?:\s|$)/,
  /^>/,
  /^[-+](?:\s|$)/,
  /^(?:-[ \t]*){3,}$/,
  /^-+[ \t]*$/,
  /^=+[ \t]*$/,
  /^\[[^\]]*\]:/,
];

function escapeLineStart(line: string): string {
  if (BLOCK_STARTS.some((pattern) => pattern.test(line))) {
    return `${BACKSLASH}${line}`;
  }
  const ordered = /^(\d{1,9})([.)])(?:\s|$)/.exec(line);
  if (ordered?.[1]) {
    return `${ordered[1]}${BACKSLASH}${line.slice(ordered[1].length)}`;
  }
  return line;
}

/** A heading ending in " #" would lose it: CommonMark reads that as a closing sequence. */
function escapeClosingHashes(heading: string): string {
  return heading.replace(/(\s)(#+)$/, (_match, space: string, hashes: string) => `${space}${BACKSLASH}${hashes}`);
}

/** The longest source kept verbatim, above which it is reduced to a digest. */
const READABLE_SOURCE_LENGTH = 64;

function renderImage(node: ElementNode): string {
  const alt = node.attributes.alt?.trim() ?? '';
  const source = node.attributes.src ?? '';
  const label = alt === '' ? 'image' : alt.replaceAll(/[[\]\\]/g, (bracket) => `${BACKSLASH}${bracket}`);
  if (source === '') {
    return `![${label}]`;
  }
  // A source short enough to read is a path or a digest already. Only the
  // base64 of an image inlined into the HTML needs reducing.
  const isDocumentImageDigest = /^docx-image:[0-9a-f]{64}$/i.test(source);
  const token = source.length <= READABLE_SOURCE_LENGTH || isDocumentImageDigest
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
