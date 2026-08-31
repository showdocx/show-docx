import * as path from 'node:path';
import * as vscode from 'vscode';
import { convertDocxToText } from '../diff/docxText';
import {
  ToolInputError,
  parseReadDocxInput,
  resolveDocxCandidates,
  truncateForModel,
} from './readDocxInput';
import { getLog } from '../log';

/**
 * Lets an AI agent already running in the user's editor read a `.docx`. Without
 * it an agent opens a Word document, sees a ZIP, and gives up.
 *
 * ShowDocx calls no model and sends nothing anywhere: the user's own agent asks
 * this extension for text it already knows how to produce. The privacy claim in
 * the README is unaffected.
 *
 * The API landed in VS Code 1.95 and `engines` is deliberately pinned at 1.85
 * (see #6, where raising it hid a release from everyone below), so both the
 * types and the registration are handled by feature detection at runtime.
 */

export const READ_DOCX_TOOL = 'showdocx_readDocx';

/* --------------------------------------------------------------------------
 * The slice of the VS Code 1.95+ API this uses, declared locally because the
 * pinned @types/vscode does not describe it.
 * ----------------------------------------------------------------------- */

interface ToolInvocationOptions {
  readonly input?: unknown;
}

interface LanguageModelApi {
  readonly lm?: {
    registerTool?(name: string, tool: unknown): vscode.Disposable;
  };
  readonly LanguageModelToolResult?: new (content: unknown[]) => unknown;
  readonly LanguageModelTextPart?: new (value: string) => unknown;
}

export interface ReadDocxHost {
  /** The folders a document may be read from. */
  workspaceFolders(): readonly string[];
  read(uri: vscode.Uri): Promise<Uint8Array>;
}

interface ResolvedToolApi {
  readonly registerTool: (name: string, tool: unknown) => vscode.Disposable;
  readonly Result: new (content: unknown[]) => unknown;
  readonly TextPart: new (value: string) => unknown;
}

/**
 * The tool API, if this VS Code has all of it. Undefined on 1.85 through 1.94,
 * which is a supported version rather than a failure — the viewer is unaffected.
 * Every piece is checked: a partial API would fail at invocation instead, where
 * the user would see it as the tool being broken.
 */
export function resolveToolApi(candidate: unknown): ResolvedToolApi | undefined {
  const api = candidate as LanguageModelApi | undefined;
  const registerTool = api?.lm?.registerTool;
  const Result = api?.LanguageModelToolResult;
  const TextPart = api?.LanguageModelTextPart;
  if (
    typeof registerTool !== 'function'
    || typeof Result !== 'function'
    || typeof TextPart !== 'function'
  ) {
    return undefined;
  }
  return { registerTool: registerTool.bind(api?.lm), Result, TextPart };
}

export async function readDocxForModel(
  input: unknown,
  host: ReadDocxHost,
): Promise<string> {
  const request = parseReadDocxInput(input);
  const folders = host.workspaceFolders();
  if (folders.length === 0) {
    throw new ToolInputError('ShowDocx reads documents from an open workspace, and none is open.');
  }

  const candidates = resolveDocxCandidates(request.filePath, folders);
  if (candidates.length === 0) {
    throw new ToolInputError(
      `"${request.filePath}" is outside this workspace. ShowDocx only reads documents inside it.`,
    );
  }

  for (const candidate of candidates) {
    const uri = vscode.Uri.file(candidate);
    let data: Uint8Array;
    try {
      data = await host.read(uri);
    } catch {
      continue;
    }
    const { text, messages } = await convertDocxToText(data, { stableOrderedNumbers: false });
    for (const message of messages) {
      getLog().warn(`${path.basename(candidate)}: ${message}`);
    }
    if (text === '') {
      return `${path.basename(candidate)} contains no readable text.\n`;
    }
    return truncateForModel(text, request.maxCharacters);
  }

  throw new ToolInputError(
    `ShowDocx could not read "${request.filePath}". Check the path is a .docx file in this workspace.`,
  );
}

/**
 * Registers the tool when the running VS Code has the API, and reports that it
 * did not when it does not. An older VS Code simply keeps the viewer it has.
 */
export function registerReadDocxTool(host: ReadDocxHost): vscode.Disposable | undefined {
  const api = resolveToolApi(vscode);
  if (!api) {
    getLog().info(
      'This version of VS Code has no language model tool API, so ShowDocx did not register one.',
    );
    return undefined;
  }
  const { Result, TextPart } = api;

  const tool = {
    invoke: async (options: ToolInvocationOptions) => {
      const text = await readDocxForModel(options.input, host);
      return new Result([new TextPart(text)]);
    },
    prepareInvocation: (options: ToolInvocationOptions) => {
      const raw = (options.input ?? {}) as { filePath?: unknown };
      const name = typeof raw.filePath === 'string' ? path.basename(raw.filePath) : 'a document';
      return { invocationMessage: `Reading ${name}` };
    },
  };

  try {
    const registration = api.registerTool(READ_DOCX_TOOL, tool);
    getLog().info(`Registered the ${READ_DOCX_TOOL} language model tool.`);
    return registration;
  } catch (error: unknown) {
    // Registration also fails when the manifest contribution is unknown to this
    // VS Code. That is not a reason to fail activation of the viewer.
    getLog().warn(`Registering the ${READ_DOCX_TOOL} tool failed.`, error);
    return undefined;
  }
}
