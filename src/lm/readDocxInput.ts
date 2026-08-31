import * as path from 'node:path';
import { DOCUMENT_EXTENSIONS, isDocumentPath } from '../../shared/documentExtensions';

/**
 * Reading and bounding the arguments a model produced. Kept free of the VS Code
 * API so the unit tests exercise the real functions rather than copies of them.
 *
 * Nothing here trusts its input. A model's arguments can be steered by whatever
 * it has read — an instruction planted in a README, an issue, or a document —
 * so a path is a request, not a permission.
 */

/**
 * How much text one call returns by default. Roughly 15k tokens: enough for most
 * specifications, small enough not to fill an agent's context with one file.
 */
export const DEFAULT_MAX_CHARACTERS = 60_000;

const MAX_CHARACTERS_LIMIT = 1_000_000;

export class ToolInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

export interface ReadDocxRequest {
  readonly filePath: string;
  readonly maxCharacters: number;
}

export function parseReadDocxInput(input: unknown): ReadDocxRequest {
  const raw = (input ?? {}) as Record<string, unknown>;
  const filePath = raw.filePath;
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new ToolInputError('Provide "filePath": the path of the .docx file to read.');
  }
  const trimmed = filePath.trim();
  if (!isDocumentPath(trimmed)) {
    throw new ToolInputError(
      `ShowDocx reads Word documents (${DOCUMENT_EXTENSIONS.join(', ')}). "${trimmed}" is not one.`,
    );
  }

  const requested = raw.maxCharacters;
  const maxCharacters = typeof requested === 'number' && Number.isFinite(requested)
    ? Math.min(Math.max(Math.floor(requested), 1), MAX_CHARACTERS_LIMIT)
    : DEFAULT_MAX_CHARACTERS;

  return { filePath: trimmed, maxCharacters };
}

/**
 * The absolute paths a request could mean, in priority order. Only paths inside
 * an open workspace folder are returned, so the tool cannot become a way to
 * reach documents elsewhere on the machine.
 */
export function resolveDocxCandidates(
  filePath: string,
  workspaceFolders: readonly string[],
): string[] {
  const candidates = path.isAbsolute(filePath)
    ? [path.normalize(filePath)]
    : workspaceFolders.map((folder) => path.resolve(folder, filePath));
  return candidates.filter((candidate) => isInsideAnyFolder(candidate, workspaceFolders));
}

export function isInsideAnyFolder(
  candidate: string,
  workspaceFolders: readonly string[],
): boolean {
  return workspaceFolders.some((folder) => {
    const relative = path.relative(folder, candidate);
    return relative !== ''
      && relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative);
  });
}

/** Cuts the text at a line boundary and says what was left out. */
export function truncateForModel(text: string, maxCharacters: number): string {
  if (text.length <= maxCharacters) {
    return text;
  }
  const head = text.slice(0, maxCharacters);
  const lastBreak = head.lastIndexOf('\n');
  const kept = lastBreak > maxCharacters / 2 ? head.slice(0, lastBreak) : head;
  return `${kept}\n\n[ShowDocx: showing the first ${kept.length} of ${text.length} characters. `
    + 'Call this tool again with a larger "maxCharacters" to read more.]\n';
}
