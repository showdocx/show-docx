import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import {
  DEFAULT_QUESTION,
  buildPrompt,
  toMessageTexts,
} from '../../src/lm/chatPrompt';

describe('Asking a model about a document', () => {
  it('sends the document under its own name', () => {
    const prompt = buildPrompt('contract.docx', '# Terms\n\nThe party agrees.\n', 'Who agrees?');

    assert.ok(prompt.document.startsWith('# contract.docx'));
    assert.ok(prompt.document.includes('The party agrees.'));
    assert.equal(prompt.question, 'Who agrees?');
    assert.equal(prompt.truncated, false);
  });

  it('tells the model to answer from the document and to say when it cannot', () => {
    // Without this a model fills a gap in a contract from its own memory, which
    // is the one failure that would matter here.
    const { instructions } = buildPrompt('a.docx', 'text', 'q');

    assert.match(instructions, /only from it/i);
    assert.match(instructions, /say so plainly rather than guessing/i);
  });

  it('summarizes when the reader typed nothing but the mention', () => {
    assert.equal(buildPrompt('a.docx', 'text', '').question, DEFAULT_QUESTION);
    assert.equal(buildPrompt('a.docx', 'text', '   ').question, DEFAULT_QUESTION);
  });

  it('trims what the reader typed', () => {
    assert.equal(buildPrompt('a.docx', 'text', '  What is clause 3?  ').question, 'What is clause 3?');
  });

  it('cuts a document that will not fit, and says that it did', () => {
    const long = `${'word '.repeat(400)}\n`.repeat(40);

    const prompt = buildPrompt('long.docx', long, 'Summarize', 1000);

    assert.equal(prompt.truncated, true);
    assert.ok(prompt.document.length < long.length);
    assert.match(prompt.document, /showing the first/i);
  });

  it('carries the cut into the question, so the answer is not passed off as complete', () => {
    const long = 'a'.repeat(5000);

    const [, , question] = toMessageTexts(buildPrompt('long.docx', long, 'Summarize', 500));

    assert.match(question ?? '', /Only the first part/i);
  });

  it('says nothing about a cut when the document fitted', () => {
    const [, , question] = toMessageTexts(buildPrompt('a.docx', 'short', 'Summarize'));
    assert.equal(question, 'Summarize');
  });

  it('sends the instructions, then the document, then the question', () => {
    // The question last is what keeps a document that ends mid-sentence from
    // reading as the thing being asked.
    const messages = toMessageTexts(buildPrompt('a.docx', 'body text', 'Why?'));

    assert.equal(messages.length, 3);
    assert.match(messages[0] ?? '', /answering questions about a Word document/i);
    assert.ok(messages[1]?.includes('body text'));
    assert.equal(messages[2], 'Why?');
  });
});
