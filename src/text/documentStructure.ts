import JSZip from 'jszip';
import { xmlToLines } from './searchText';

/**
 * The structure a document declares about itself: which paragraphs are
 * headings, and what has been said about the text.
 *
 * Both were previously guessed from the rendered page — headings by matching
 * CSS class names against the English words "heading" and "title", annotations
 * by walking the DOM docx-preview built. Guessing from the render is wrong in
 * both directions and only works in Visual mode. This reads what the document
 * states, so it is right in either mode and in any language.
 */

export interface HeadingStyle {
  /** The style id, which is what docx-preview turns into a class name. */
  readonly styleId: string;
  readonly name: string;
  /** 1 to 9, as a reader would number them. */
  readonly level: number;
}

export interface DocumentComment {
  readonly id: string;
  readonly author: string;
  readonly initials?: string;
  readonly date?: string;
  readonly text: string;
  /** Marked done in Word. Only documents that record it say so. */
  readonly resolved?: boolean;
  /** The comment this one replies to, where the document records a thread. */
  readonly replyTo?: string;
}

export interface DocumentRevision {
  readonly type: 'insertion' | 'deletion';
  readonly author: string;
  readonly date?: string;
  readonly text: string;
}

export interface DocumentStructure {
  readonly headingStyles: HeadingStyle[];
  readonly comments: DocumentComment[];
  /** Comment ids in the order they are anchored in the body. */
  readonly commentOrder: string[];
  readonly revisions: DocumentRevision[];
}

export async function readDocumentStructure(data: Uint8Array): Promise<DocumentStructure> {
  const zip = await JSZip.loadAsync(data);
  const [styles, body, comments, extended] = await Promise.all([
    readPart(zip, 'word/styles.xml'),
    readPart(zip, 'word/document.xml'),
    readPart(zip, 'word/comments.xml'),
    readPart(zip, 'word/commentsExtended.xml'),
  ]);

  return {
    headingStyles: readHeadingStyles(styles),
    comments: readComments(comments, extended),
    commentOrder: readCommentOrder(body),
    revisions: readRevisions(body),
  };
}

/* --------------------------------------------------------------------------
 * Headings
 * ----------------------------------------------------------------------- */

interface StyleRecord {
  readonly styleId: string;
  readonly name: string;
  readonly basedOn?: string;
  readonly outlineLevel?: number;
}

/** Word's own names for its heading styles, which it stores in English. */
const BUILT_IN_LEVELS: Record<string, number> = {
  title: 1,
  subtitle: 2,
};

/**
 * The paragraph styles that are headings, and how deep each one is.
 *
 * `w:outlineLvl` is the document's own answer and is preferred. Documents
 * written by anything other than Word often omit it, so the style's `w:name` is
 * the fallback — Word stores the canonical English name there and localizes
 * only what it shows, which is why this works for a document in any language.
 * A style that says neither, but is based on one that does, inherits it.
 */
export function readHeadingStyles(stylesXml: string): HeadingStyle[] {
  const byId = new Map<string, StyleRecord>();
  for (const block of stylesXml.match(/<w:style\b[\s\S]*?<\/w:style>/g) ?? []) {
    if (!/w:type="paragraph"/.test(block)) {
      continue;
    }
    const styleId = attribute(block, 'w:styleId');
    if (!styleId) {
      continue;
    }
    const outline = attributeOf(block, 'w:outlineLvl', 'w:val');
    const level = Number.parseInt(outline ?? '', 10);
    byId.set(styleId, {
      styleId,
      name: attributeOf(block, 'w:name', 'w:val') ?? styleId,
      basedOn: attributeOf(block, 'w:basedOn', 'w:val'),
      outlineLevel: Number.isFinite(level) ? level : undefined,
    });
  }

  const headings: HeadingStyle[] = [];
  for (const style of byId.values()) {
    const level = resolveLevel(style, byId, new Set());
    if (level !== undefined) {
      headings.push({ styleId: style.styleId, name: style.name, level });
    }
  }
  return headings.sort((left, right) => left.level - right.level
    || left.styleId.localeCompare(right.styleId));
}

function resolveLevel(
  style: StyleRecord | undefined,
  byId: Map<string, StyleRecord>,
  seen: Set<string>,
): number | undefined {
  if (!style || seen.has(style.styleId)) {
    // A style based on itself, directly or around a chain, would not terminate.
    return undefined;
  }
  seen.add(style.styleId);

  if (style.outlineLevel !== undefined && style.outlineLevel >= 0 && style.outlineLevel <= 8) {
    return style.outlineLevel + 1;
  }
  const byName = levelFromName(style.name);
  if (byName !== undefined) {
    return byName;
  }
  return style.basedOn ? resolveLevel(byId.get(style.basedOn), byId, seen) : undefined;
}

export function levelFromName(name: string): number | undefined {
  const normalized = name.trim().toLowerCase();
  const built = BUILT_IN_LEVELS[normalized];
  if (built !== undefined) {
    return built;
  }
  const heading = /^heading\s*([1-9])$/.exec(normalized);
  return heading ? Number.parseInt(heading[1] ?? '', 10) : undefined;
}

/* --------------------------------------------------------------------------
 * Comments and revisions
 * ----------------------------------------------------------------------- */

export function readComments(commentsXml: string, extendedXml: string): DocumentComment[] {
  const done = new Set<string>();
  const parentOf = new Map<string, string>();
  for (const entry of extendedXml.match(/<w15:commentEx\b[^>]*\/?>/g) ?? []) {
    const paraId = attribute(entry, 'w15:paraId');
    if (!paraId) {
      continue;
    }
    if (attribute(entry, 'w15:done') === '1') {
      done.add(paraId);
    }
    const parent = attribute(entry, 'w15:paraIdParent');
    if (parent) {
      parentOf.set(paraId, parent);
    }
  }

  // A thread is recorded against paragraph ids, so a comment has to be found by
  // the id of its own last paragraph before any of it can be applied.
  const commentOfParagraph = new Map<string, string>();
  const comments: DocumentComment[] = [];
  const paragraphIds: Array<{ id: string; paraIds: string[] }> = [];

  for (const block of commentsXml.match(/<w:comment\b[\s\S]*?<\/w:comment>/g) ?? []) {
    const id = attribute(block, 'w:id');
    if (id === undefined) {
      continue;
    }
    const paraIds = [...block.matchAll(/w14:paraId="([^"]+)"/g)].map((match) => match[1] ?? '');
    for (const paraId of paraIds) {
      commentOfParagraph.set(paraId, id);
    }
    paragraphIds.push({ id, paraIds });

    comments.push({
      id,
      author: attribute(block, 'w:author') ?? 'Unknown',
      initials: attribute(block, 'w:initials'),
      date: attribute(block, 'w:date'),
      text: xmlToLines(block).trim(),
    });
  }

  return comments.map((comment) => {
    const paraIds = paragraphIds.find((entry) => entry.id === comment.id)?.paraIds ?? [];
    const resolved = paraIds.some((paraId) => done.has(paraId));
    const parentParagraph = paraIds
      .map((paraId) => parentOf.get(paraId))
      .find((parent) => parent !== undefined);
    const replyTo = parentParagraph ? commentOfParagraph.get(parentParagraph) : undefined;
    return {
      ...comment,
      ...(resolved ? { resolved } : {}),
      ...(replyTo !== undefined && replyTo !== comment.id ? { replyTo } : {}),
    };
  });
}

/** Comment ids in the order the body anchors them, which is reading order. */
export function readCommentOrder(documentXml: string): string[] {
  const order: string[] = [];
  for (const match of documentXml.matchAll(/<w:commentRangeStart\b[^>]*w:id="([^"]+)"/g)) {
    const id = match[1];
    if (id !== undefined && !order.includes(id)) {
      order.push(id);
    }
  }
  return order;
}

/**
 * Tracked insertions and deletions, with who made them.
 *
 * Read from the body rather than from the render, so they are listed in Text
 * mode too — where mammoth drops deletions entirely and the panel was empty.
 */
export function readRevisions(documentXml: string): DocumentRevision[] {
  const revisions: DocumentRevision[] = [];
  const pattern = /<w:(ins|del)\b([^>]*)>([\s\S]*?)<\/w:\1>/g;
  for (const match of documentXml.matchAll(pattern)) {
    const [, kind, attributes = '', inner = ''] = match;
    // A deletion stores its text in w:delText, which xmlToLines drops on
    // purpose; unwrap it so the panel can show what was removed.
    const unwrapped = inner.replaceAll(/<w:delText\b([^>]*)>/g, '<w:t$1>')
      .replaceAll('</w:delText>', '</w:t>');
    const text = xmlToLines(unwrapped).replaceAll('\n', ' ').trim();
    if (text === '') {
      continue;
    }
    revisions.push({
      type: kind === 'ins' ? 'insertion' : 'deletion',
      author: attribute(attributes, 'w:author') ?? 'Unknown',
      date: attribute(attributes, 'w:date'),
      text,
    });
  }
  return revisions;
}

/* --------------------------------------------------------------------------
 * XML reading
 * ----------------------------------------------------------------------- */

function attribute(xml: string, name: string): string | undefined {
  const escaped = name.replaceAll(':', '\\:');
  const match = new RegExp(`${escaped}="([^"]*)"`).exec(xml);
  return match?.[1];
}

/** The value of an attribute on the first `<element>` in the fragment. */
function attributeOf(xml: string, element: string, name: string): string | undefined {
  const match = new RegExp(`<${element}\\b([^>]*)/?>`).exec(xml);
  return match ? attribute(match[1] ?? '', name) : undefined;
}

async function readPart(zip: JSZip, name: string): Promise<string> {
  const file = zip.file(name);
  return file ? file.async('text') : '';
}
