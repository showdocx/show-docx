import JSZip from 'jszip';
import { decodeEntities } from './htmlToText';
import { xmlToLines } from './searchText';
import { loadAndValidateZip } from '../docxLoader';
import { readHiddenStyleInfo, removeHiddenRuns, scanXmlTags, xmlAttribute } from './xmlScanner';

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
  /** The revision's `w:id`, which the rendered page carries too. */
  readonly id?: string;
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

export async function readDocumentStructure(data: Uint8Array | JSZip): Promise<DocumentStructure> {
  const zip = data instanceof JSZip ? data : await loadAndValidateZip(data);
  const [styles, body, comments, extended] = await Promise.all([
    readPart(zip, 'word/styles.xml'),
    readPart(zip, 'word/document.xml'),
    readPart(zip, 'word/comments.xml'),
    readPart(zip, 'word/commentsExtended.xml'),
  ]);
  const hiddenStyles = readHiddenStyleInfo(styles);
  const visibleBody = removeHiddenRuns(body, hiddenStyles);

  return {
    headingStyles: readHeadingStyles(styles),
    comments: readComments(comments, extended, hiddenStyles),
    commentOrder: readCommentOrder(visibleBody),
    revisions: readRevisions(visibleBody),
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
  let currentStyle: {
    styleId?: string;
    type?: string;
    name?: string;
    basedOn?: string;
    outlineLevel?: number;
  } | undefined;

  for (const tag of scanXmlTags(stylesXml)) {
    if (tag.name === 'w:style') {
      if (tag.closing) {
        if (currentStyle?.type === 'paragraph' && currentStyle.styleId) {
          byId.set(currentStyle.styleId, {
            styleId: currentStyle.styleId,
            name: currentStyle.name ?? currentStyle.styleId,
            ...(currentStyle.basedOn ? { basedOn: currentStyle.basedOn } : {}),
            ...(currentStyle.outlineLevel !== undefined ? { outlineLevel: currentStyle.outlineLevel } : {}),
          });
        }
        currentStyle = undefined;
      } else if (!tag.selfClosing) {
        currentStyle = {
          styleId: xmlAttribute(tag.attributes, 'w:styleId'),
          type: xmlAttribute(tag.attributes, 'w:type'),
        };
      }
      continue;
    }
    if (!currentStyle || tag.closing) {continue;}
    if (tag.name === 'w:name') {
      currentStyle.name = xmlAttribute(tag.attributes, 'w:val');
    } else if (tag.name === 'w:basedOn') {
      currentStyle.basedOn = xmlAttribute(tag.attributes, 'w:val');
    } else if (tag.name === 'w:outlineLvl') {
      const outline = Number.parseInt(xmlAttribute(tag.attributes, 'w:val') ?? '', 10);
      if (Number.isFinite(outline)) {currentStyle.outlineLevel = outline;}
    }
  }

  const levels = new Map<string, number | undefined>();
  const resolve = (styleId: string): number | undefined => {
    if (levels.has(styleId)) {return levels.get(styleId);}
    const chain: string[] = [];
    const seen = new Set<string>();
    let currentId: string | undefined = styleId;
    let level: number | undefined;

    while (currentId !== undefined) {
      if (levels.has(currentId)) {
        level = levels.get(currentId);
        break;
      }
      if (seen.has(currentId)) {break;}
      seen.add(currentId);
      const style = byId.get(currentId);
      if (!style) {break;}

      if (style.outlineLevel !== undefined && style.outlineLevel >= 0 && style.outlineLevel <= 8) {
        level = style.outlineLevel + 1;
        levels.set(currentId, level);
        break;
      }
      const namedLevel = levelFromName(style.name);
      if (namedLevel !== undefined) {
        level = namedLevel;
        levels.set(currentId, level);
        break;
      }
      chain.push(currentId);
      currentId = style.basedOn;
    }

    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const id = chain[index];
      if (id !== undefined) {levels.set(id, level);}
    }
    return level;
  };

  const headings: HeadingStyle[] = [];
  for (const style of byId.values()) {
    const level = resolve(style.styleId);
    if (level !== undefined) {
      headings.push({ styleId: style.styleId, name: style.name, level });
    }
  }
  return headings.sort((left, right) => left.level - right.level
    || left.styleId.localeCompare(right.styleId));
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

export function readComments(
  commentsXml: string,
  extendedXml: string,
  hiddenStyles?: ReturnType<typeof readHiddenStyleInfo>,
): DocumentComment[] {
  const done = new Set<string>();
  const parentOf = new Map<string, string>();
  for (const tag of scanXmlTags(extendedXml)) {
    if (tag.name !== 'w15:commentEx' || tag.closing) {continue;}
    const paraId = xmlAttribute(tag.attributes, 'w15:paraId');
    if (!paraId) {continue;}
    if (attribute(tag.attributes, 'w15:done') === '1') {done.add(paraId);}
    const parent = xmlAttribute(tag.attributes, 'w15:paraIdParent');
    if (parent) {parentOf.set(paraId, parent);}
  }

  interface CommentBuilder {
    readonly start: number;
    readonly attributes: string;
    readonly paraIds: string[];
  }
  const MAX_COMMENTS = 10000;
  const MAX_COMMENT_DEPTH = 64;
  const stack: CommentBuilder[] = [];
  const commentOfParagraph = new Map<string, string>();
  const paraIdsByComment = new Map<string, string[]>();
  const comments: DocumentComment[] = [];
  let ignoredDepth = 0;

  for (const tag of scanXmlTags(commentsXml)) {
    if (tag.name === 'w:comment') {
      if (tag.closing) {
        if (ignoredDepth > 0) {
          ignoredDepth -= 1;
          continue;
        }
        const builder = stack.pop();
        if (!builder) {continue;}
        const id = attribute(builder.attributes, 'w:id');
        if (id === undefined) {continue;}
        for (const paraId of builder.paraIds) {commentOfParagraph.set(paraId, id);}
        paraIdsByComment.set(id, builder.paraIds);
        const block = commentsXml.slice(builder.start, tag.end);
        comments.push({
          id,
          author: attribute(builder.attributes, 'w:author') ?? 'Unknown',
          initials: attribute(builder.attributes, 'w:initials'),
          date: attribute(builder.attributes, 'w:date'),
          text: xmlToLines(block, hiddenStyles).trim(),
        });
      } else if (!tag.selfClosing) {
        if (ignoredDepth > 0 || stack.length >= MAX_COMMENT_DEPTH || comments.length + stack.length >= MAX_COMMENTS) {
          ignoredDepth += 1;
        } else {
          stack.push({ start: tag.start, attributes: tag.attributes, paraIds: [] });
        }
      }
      continue;
    }
    if (!tag.closing && ignoredDepth === 0) {
      const paraId = xmlAttribute(tag.attributes, 'w14:paraId');
      const current = stack[stack.length - 1];
      if (paraId && current) {current.paraIds.push(paraId);}
    }
  }

  return comments.map((comment) => {
    const paraIds = paraIdsByComment.get(comment.id) ?? [];
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
/**
 * Comment ids in the order the body anchors them, which is reading order. A
 * comment is anchored where its range starts, or at its reference when it has
 * no range — a comment on a point rather than on a stretch of text.
 */
export function readCommentOrder(documentXml: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const tag of scanXmlTags(documentXml)) {
    if (tag.closing || (tag.name !== 'w:commentRangeStart' && tag.name !== 'w:commentReference')) {continue;}
    const id = xmlAttribute(tag.attributes, 'w:id');
    if (id !== undefined && !seen.has(id)) {
      seen.add(id);
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
 *
 * Each `w:ins` and `w:del` element is read on its own, in the order it opens.
 * Two shapes need care:
 *
 * - **Self-closing** `<w:ins/>` and `<w:del/>` mark a paragraph mark or a table
 *   row as inserted or deleted. They hold no text, and treating one as an
 *   opening tag swallowed everything up to the next revision's end — listing
 *   untouched text as deleted, under the wrong author.
 * - **Nested**: text one reviewer inserted and another deleted is a `w:del`
 *   inside a `w:ins`. Both are listed; the insertion shows what is left of it.
 */
export function readRevisions(documentXml: string): DocumentRevision[] {
  interface RevisionBuilder {
    readonly kind: 'ins' | 'del';
    readonly attributes: string;
    text: string;
    complete: boolean;
  }

  const MAX_REVISION_ELEMENTS = 10000;
  const MAX_REVISION_DEPTH = 64;
  const MAX_TOTAL_REVISION_TEXT = 1024 * 1024;
  const builders: RevisionBuilder[] = [];
  const active: RevisionBuilder[] = [];
  const textElements: string[] = [];
  const runs: boolean[] = [];
  let cursor = 0;
  let fallbackDepth = 0;
  let fieldDepth = 0;
  let ignoredRevisionDepth = 0;
  let totalText = 0;

  const appendText = (value: string): void => {
    if (value === '' || totalText >= MAX_TOTAL_REVISION_TEXT || fallbackDepth > 0 || fieldDepth > 0) {return;}
    const textElement = textElements[textElements.length - 1];
    if (textElement !== 'w:t' && textElement !== 'w:delText') {return;}
    if (runs[runs.length - 1]) {return;}

    for (const revision of active) {
      if (textElement === 'w:delText' && revision.kind !== 'del') {continue;}
      const addition = value.slice(0, MAX_TOTAL_REVISION_TEXT - totalText);
      revision.text += addition;
      totalText += addition.length;
      if (totalText >= MAX_TOTAL_REVISION_TEXT) {break;}
    }
  };

  const appendSpace = (): void => {
    if (totalText >= MAX_TOTAL_REVISION_TEXT || fallbackDepth > 0 || fieldDepth > 0) {return;}
    for (const revision of active) {
      if (revision.text !== '' && !revision.text.endsWith(' ')) {
        revision.text += ' ';
        totalText += 1;
      }
    }
  };

  for (const tag of scanXmlTags(documentXml)) {
    appendText(documentXml.slice(cursor, tag.start));
    cursor = tag.end;

    if (tag.name === 'w:ins' || tag.name === 'w:del') {
      if (tag.closing) {
        if (ignoredRevisionDepth > 0) {
          ignoredRevisionDepth -= 1;
        } else {
          for (let index = active.length - 1; index >= 0; index -= 1) {
            const revision = active[index];
            if (revision?.kind === tag.name.slice(2)) {
              revision.complete = true;
              active.splice(index, 1);
              break;
            }
          }
        }
      } else if (!tag.selfClosing) {
        if (ignoredRevisionDepth > 0 || active.length >= MAX_REVISION_DEPTH || builders.length >= MAX_REVISION_ELEMENTS) {
          ignoredRevisionDepth += 1;
        } else {
          const revision: RevisionBuilder = {
            kind: tag.name.slice(2) as 'ins' | 'del',
            attributes: tag.attributes,
            text: '',
            complete: false,
          };
          builders.push(revision);
          active.push(revision);
        }
      }
      continue;
    }

    if (tag.name === 'w:r') {
      if (tag.closing) {runs.pop();}
      else if (!tag.selfClosing) {runs.push(false);}
      continue;
    }
    if (!tag.closing && (tag.name === 'w:vanish' || tag.name === 'w:specVanish')) {
      const value = attribute(tag.attributes, 'w:val')?.toLowerCase();
      if (value !== '0' && value !== 'false' && value !== 'off' && runs.length > 0) {
        runs[runs.length - 1] = true;
      }
    }

    if (tag.name === 'mc:Fallback') {
      fallbackDepth = Math.max(0, fallbackDepth + (tag.closing ? -1 : tag.selfClosing ? 0 : 1));
    } else if (tag.name === 'w:instrText') {
      fieldDepth = Math.max(0, fieldDepth + (tag.closing ? -1 : tag.selfClosing ? 0 : 1));
    } else if (tag.name === 'w:t' || tag.name === 'w:delText') {
      if (tag.closing) {textElements.pop();}
      else if (!tag.selfClosing) {textElements.push(tag.name);}
    } else if (!tag.closing && (tag.name === 'w:tab' || tag.name === 'w:br')) {
      appendSpace();
    } else if (tag.closing && tag.name === 'w:p') {
      appendSpace();
    }
  }

  appendText(documentXml.slice(cursor));
  return builders
    .filter((revision) => revision.complete)
    .map((revision) => ({
      revision,
      text: decodeEntities(revision.text).replaceAll(/\s+/g, ' ').trim(),
    }))
    .filter(({ text }) => text !== '')
    .map(({ revision, text }) => {
      const id = attribute(revision.attributes, 'w:id');
      return {
        type: revision.kind === 'ins' ? 'insertion' : 'deletion',
        ...(id !== undefined ? { id } : {}),
        author: attribute(revision.attributes, 'w:author') ?? 'Unknown',
        date: attribute(revision.attributes, 'w:date'),
        text,
      };
    });
}
/* --------------------------------------------------------------------------
 * XML reading
 * ----------------------------------------------------------------------- */

/** An attribute's value, with the entities XML escapes it with decoded. */
function attribute(xml: string, name: string): string | undefined {
  const parsed = xmlAttribute(xml, name);
  if (parsed !== undefined) {
    return parsed;
  }
  const escaped = name.replaceAll(':', '\\:');
  const match = new RegExp(`(?:^|\\s)${escaped}="([^"]*)"`).exec(xml);
  return match?.[1] === undefined ? undefined : decodeEntities(match[1]);
}

async function readPart(zip: JSZip, name: string): Promise<string> {
  const file = zip.file(name);
  return file ? file.async('text') : '';
}
