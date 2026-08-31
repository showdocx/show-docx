import { truncateForModel } from './readDocxInput';

/**
 * Building what the model is asked. Kept free of the VS Code API so the unit
 * tests exercise the real prompt rather than a copy of it.
 */

/**
 * How much of a document goes into one question. Well inside the context of the
 * models this is asked of, and cut at a line boundary with the cut announced,
 * so a long contract gives a partial answer that says it is partial rather than
 * a request that fails.
 */
export const MAX_DOCUMENT_CHARACTERS = 48_000;

/** What the participant answers when the prompt is only the mention. */
export const DEFAULT_QUESTION = 'Summarize this document.';

export interface PromptParts {
  readonly instructions: string;
  readonly document: string;
  readonly question: string;
  /** True when the document did not fit and was cut. */
  readonly truncated: boolean;
}

export function buildPrompt(
  documentName: string,
  text: string,
  question: string,
  limit = MAX_DOCUMENT_CHARACTERS,
): PromptParts {
  const trimmed = question.trim();
  const document = truncateForModel(text, limit);
  return {
    instructions: [
      'You are answering questions about a Word document the user has open in their editor.',
      'The document follows, converted to Markdown. Answer only from it.',
      'If the document does not contain the answer, say so plainly rather than guessing.',
      'Quote the document where a quote settles the question, and keep quotes short.',
    ].join(' '),
    document: `# ${documentName}\n\n${document}`,
    question: trimmed === '' ? DEFAULT_QUESTION : trimmed,
    truncated: document.length !== text.length,
  };
}

/** The prompt as the ordered messages a chat model is sent. */
export function toMessageTexts(parts: PromptParts): string[] {
  return [
    parts.instructions,
    parts.document,
    parts.truncated
      ? `${parts.question}\n\n(Only the first part of the document was provided.)`
      : parts.question,
  ];
}
