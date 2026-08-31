import * as path from 'node:path';
import * as vscode from 'vscode';
import { buildPrompt, toMessageTexts } from './chatPrompt';
import { convertDocxToText } from '../text/docxText';
import { getLog } from '../log';

/**
 * An `@docx` chat participant: ask questions about the Word document you have
 * open, in the chat panel the editor already has.
 *
 * The reason to read a long document is usually to summarize it or pull one
 * thing out of it. ShowDocx does not call a model — it hands the document to
 * the model the user's own chat is already using, so this costs the project
 * nothing and sends nothing anywhere ShowDocx chose.
 *
 * Like the language model tool, the API is newer than the `engines` floor, so
 * everything here is feature-detected and simply absent on an older editor.
 */

export const CHAT_PARTICIPANT = 'showdocx.docx';

export interface ChatDocumentHost {
  /** The document in the focused viewer, if one is open. */
  activeDocument(): vscode.Uri | undefined;
  read(uri: vscode.Uri): Promise<Uint8Array>;
}

/* --------------------------------------------------------------------------
 * The slice of the chat API this uses, declared locally because the pinned
 * @types/vscode does not describe it.
 * ----------------------------------------------------------------------- */

interface ChatRequest {
  readonly prompt: string;
  readonly model?: ChatModel;
}

interface ChatModel {
  sendRequest(
    messages: unknown[],
    options: unknown,
    token: vscode.CancellationToken,
  ): Promise<{ text: AsyncIterable<string> }>;
}

interface ChatResponseStream {
  markdown(value: string): void;
  reference?(value: vscode.Uri): void;
  progress?(value: string): void;
}

interface ChatParticipant {
  iconPath?: vscode.Uri;
}

interface ChatApi {
  readonly chat?: {
    createChatParticipant?(
      id: string,
      handler: (
        request: ChatRequest,
        context: unknown,
        stream: ChatResponseStream,
        token: vscode.CancellationToken,
      ) => Promise<void>,
    ): ChatParticipant & vscode.Disposable;
  };
  readonly lm?: {
    selectChatModels?(selector?: unknown): PromiseLike<ChatModel[]>;
  };
  readonly LanguageModelChatMessage?: {
    User(content: string): unknown;
  };
}

interface ResolvedChatApi {
  readonly create: NonNullable<NonNullable<ChatApi['chat']>['createChatParticipant']>;
  readonly selectModels: NonNullable<NonNullable<ChatApi['lm']>['selectChatModels']>;
  readonly userMessage: (content: string) => unknown;
}

/**
 * The chat API, if this VS Code has all of it. Every piece is checked: half an
 * API would fail when someone asked a question, which reads as the feature
 * being broken rather than unavailable.
 */
export function resolveChatApi(candidate: unknown): ResolvedChatApi | undefined {
  const api = candidate as ChatApi | undefined;
  const create = api?.chat?.createChatParticipant;
  const selectModels = api?.lm?.selectChatModels;
  const message = api?.LanguageModelChatMessage;
  if (
    typeof create !== 'function'
    || typeof selectModels !== 'function'
    || typeof message?.User !== 'function'
  ) {
    return undefined;
  }
  return {
    create: create.bind(api?.chat),
    selectModels: selectModels.bind(api?.lm),
    userMessage: (content: string) => message.User(content),
  };
}

export function registerChatParticipant(
  context: vscode.ExtensionContext,
  host: ChatDocumentHost,
): vscode.Disposable | undefined {
  const api = resolveChatApi(vscode);
  if (!api) {
    getLog().info('This version of VS Code has no chat API, so ShowDocx registered no participant.');
    return undefined;
  }

  try {
    const participant = api.create(CHAT_PARTICIPANT, async (request, _context, stream, token) => {
      await answer(request, stream, token, host, api);
    });
    participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
    getLog().info(`Registered the @docx chat participant (${CHAT_PARTICIPANT}).`);
    return participant;
  } catch (error: unknown) {
    getLog().warn('Registering the @docx chat participant failed.', error);
    return undefined;
  }
}

async function answer(
  request: ChatRequest,
  stream: ChatResponseStream,
  token: vscode.CancellationToken,
  host: ChatDocumentHost,
  api: ResolvedChatApi,
): Promise<void> {
  const uri = host.activeDocument();
  if (!uri) {
    stream.markdown('Open a Word document in ShowDocx first, then ask me about it.');
    return;
  }

  const name = path.basename(uri.path);
  stream.reference?.(uri);
  stream.progress?.(`Reading ${name}...`);

  let text: string;
  try {
    const { text: converted } = await convertDocxToText(await host.read(uri), {
      stableOrderedNumbers: false,
    });
    text = converted;
  } catch (error: unknown) {
    getLog().error(`Reading ${name} for the chat participant failed.`, error);
    stream.markdown(`I could not read **${name}**. The ShowDocx log has the details.`);
    return;
  }

  if (text.trim() === '') {
    stream.markdown(`**${name}** has no readable text in it.`);
    return;
  }

  // The model is the one the user's chat is already using, or whatever their
  // own subscription offers. ShowDocx never picks a vendor for them.
  const model = request.model ?? (await api.selectModels())[0];
  if (!model) {
    stream.markdown('No language model is available in this editor, so I cannot answer.');
    return;
  }

  const prompt = buildPrompt(name, text, request.prompt);
  if (prompt.truncated) {
    stream.markdown(`*${name} is long, so I read the first part of it.*\n\n`);
  }

  try {
    const response = await model.sendRequest(
      toMessageTexts(prompt).map((content) => api.userMessage(content)),
      {},
      token,
    );
    for await (const fragment of response.text) {
      if (token.isCancellationRequested) {
        return;
      }
      stream.markdown(fragment);
    }
  } catch (error: unknown) {
    getLog().error('The chat request failed.', error);
    stream.markdown('The language model could not answer that. The ShowDocx log has the details.');
  }
}
