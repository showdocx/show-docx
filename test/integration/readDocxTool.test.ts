import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { before, describe, it } from 'mocha';
import { READ_DOCX_TOOL, resolveToolApi } from '../../src/lm/readDocxTool';
import { CHAT_PARTICIPANT, resolveChatApi } from '../../src/lm/chatParticipant';

/**
 * Exercises the tool through the API an agent would use. The types are not in
 * the pinned @types/vscode, so the calls are made through a narrow local shape —
 * the same way the extension registers the tool.
 */

interface ToolPart {
  readonly value?: unknown;
}

interface ToolResult {
  readonly content?: readonly ToolPart[];
}

interface LanguageModelApi {
  readonly tools?: ReadonlyArray<{ name: string; description?: string }>;
  invokeTool?(
    name: string,
    options: { input: unknown; toolInvocationToken: undefined },
    token?: vscode.CancellationToken,
  ): PromiseLike<ToolResult>;
}

function languageModel(): LanguageModelApi | undefined {
  return (vscode as unknown as { lm?: LanguageModelApi }).lm;
}

/** The text an agent would receive from one call. */
function textOf(result: ToolResult): string {
  return (result.content ?? [])
    .map((part) => (typeof part.value === 'string' ? part.value : ''))
    .join('');
}

describe('Reading a DOCX for a language model', () => {
  before(async function () {
    this.timeout(30_000);
    const extension = vscode.extensions.getExtension('showdocx.show-docx');
    assert.ok(extension, 'Expected the ShowDocx extension to be installed.');
    await extension.activate();

    if (typeof languageModel()?.invokeTool !== 'function') {
      // Below VS Code 1.95 there is no tool API. Skipping is the honest result:
      // the extension is required to keep working there, not to register a tool.
      this.skip();
    }
  });

  it('offers the tool to agents', () => {
    const tools = languageModel()?.tools ?? [];
    assert.ok(
      tools.some((tool) => tool.name === READ_DOCX_TOOL),
      `Expected ${READ_DOCX_TOOL} among: ${tools.map((tool) => tool.name).join(', ')}`,
    );
  });

  it('returns the document as readable text', async function () {
    this.timeout(30_000);

    const result = await invoke({ filePath: 'simple.docx' });
    const text = textOf(result);

    assert.ok(text.includes('ShowDocx Sample'), text.slice(0, 300));
    assert.ok(text.includes('# Overview'), 'headings should survive');
    assert.ok(!text.includes('PK'), 'the binary must not reach the model');
  });

  it('keeps the structure a model needs to answer about the document', async function () {
    this.timeout(30_000);

    const text = textOf(await invoke({ filePath: 'simple.docx' }));

    assert.ok(text.includes('- Visual page rendering'), 'lists should survive');
    assert.ok(text.includes('**bold**'), 'emphasis should survive');
  });

  it('honours the length an agent asks for', async function () {
    this.timeout(30_000);

    const text = textOf(await invoke({ filePath: 'simple.docx', maxCharacters: 40 }));

    assert.ok(text.includes('showing the first'), text);
    assert.ok(text.includes('maxCharacters'), 'the agent must be told how to read more');
  });

  it('refuses a document outside the workspace', async function () {
    this.timeout(30_000);
    const outside = path.join(path.parse(process.cwd()).root, 'private', 'secret.docx');

    await assert.rejects(invoke({ filePath: outside }), /outside this workspace/i);
  });

  it('refuses a file that is not a DOCX', async function () {
    this.timeout(30_000);
    await assert.rejects(invoke({ filePath: 'README.md' }), /\.docx/i);
  });

  it('reports a document that is not there', async function () {
    this.timeout(30_000);
    await assert.rejects(invoke({ filePath: 'no-such-document.docx' }), /could not read/i);
  });
});

describe('Detecting the language model tool API', () => {
  it('finds the API on this VS Code', () => {
    assert.ok(resolveToolApi(vscode), 'this VS Code has the tool API');
  });

  it('reports no API rather than failing, which is what 1.85 to 1.94 get', () => {
    // engines stays at ^1.85.0 deliberately: raising it once already hid a
    // release from everyone below it. The viewer has to keep working there.
    assert.equal(resolveToolApi(undefined), undefined);
    assert.equal(resolveToolApi({}), undefined);
  });

  it('reports no API when only part of it is present', () => {
    // A partial API would otherwise fail at invocation, where the user reads it
    // as the tool being broken rather than unavailable.
    const noop = () => undefined;
    assert.equal(resolveToolApi({ lm: {} }), undefined);
    assert.equal(resolveToolApi({ lm: { registerTool: noop } }), undefined);
    assert.equal(
      resolveToolApi({ lm: { registerTool: noop }, LanguageModelToolResult: noop }),
      undefined,
    );
    assert.ok(resolveToolApi({
      lm: { registerTool: noop },
      LanguageModelToolResult: noop,
      LanguageModelTextPart: noop,
    }));
  });
});

describe('Detecting the chat API', () => {
  it('finds the API on this VS Code', () => {
    assert.ok(resolveChatApi(vscode), 'this VS Code has the chat API');
  });

  it('reports no API rather than failing on an editor without one', () => {
    assert.equal(resolveChatApi(undefined), undefined);
    assert.equal(resolveChatApi({}), undefined);
  });

  it('reports no API when only part of it is present', () => {
    // Half an API would fail when someone asked a question, which reads as the
    // participant being broken rather than unavailable.
    const noop = () => undefined;
    assert.equal(resolveChatApi({ chat: { createChatParticipant: noop } }), undefined);
    assert.equal(
      resolveChatApi({
        chat: { createChatParticipant: noop },
        lm: { selectChatModels: noop },
      }),
      undefined,
    );
    assert.ok(resolveChatApi({
      chat: { createChatParticipant: noop },
      lm: { selectChatModels: noop },
      LanguageModelChatMessage: { User: noop },
    }));
  });

  it('registers the participant the manifest declares', () => {
    const extension = vscode.extensions.getExtension('showdocx.show-docx');
    const declared = (extension?.packageJSON as {
      contributes?: { chatParticipants?: Array<{ id: string; name: string }> };
    }).contributes?.chatParticipants ?? [];

    assert.equal(declared[0]?.id, CHAT_PARTICIPANT);
    assert.equal(declared[0]?.name, 'docx');
  });
});

async function invoke(input: unknown): Promise<ToolResult> {
  const api = languageModel();
  assert.ok(api?.invokeTool, 'Expected the language model tool API.');
  return api.invokeTool(READ_DOCX_TOOL, { input, toolInvocationToken: undefined });
}
