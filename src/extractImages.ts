import * as path from 'node:path';
import * as vscode from 'vscode';
import { imageName, readMedia } from './text/documentFacts';
import { stripDocumentExtension } from '../shared/documentExtensions';
import { getLog } from './log';

/**
 * Writes the images out of a document to a folder.
 *
 * The pictures are already stored in the package as ordinary files, so this
 * copies them rather than decoding anything. Getting a diagram out of a
 * specification and into a README otherwise means opening Word.
 */

export interface ExtractImagesHost {
  read(uri: vscode.Uri): Promise<Uint8Array>;
}

export async function extractImages(
  source: vscode.Uri | undefined,
  host: ExtractImagesHost,
): Promise<void> {
  if (!source) {
    void vscode.window.showWarningMessage(
      'ShowDocx: open or select a Word document to extract its images.',
    );
    return;
  }

  const name = path.basename(source.path);
  try {
    const media = await readMedia(await host.read(source));
    if (media.length === 0) {
      void vscode.window.showInformationMessage(`ShowDocx: ${name} contains no images.`);
      return;
    }

    const folder = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Extract here',
      title: `Extract ${media.length} image${media.length === 1 ? '' : 's'} from ${name}`,
      defaultUri: source.with({ path: path.posix.dirname(source.path) }),
    });
    const target = folder?.[0];
    if (!target) {
      return;
    }

    const base = path.basename(stripDocumentExtension(source.path));
    const written: vscode.Uri[] = [];
    for (const [index, entry] of media.entries()) {
      const file = vscode.Uri.joinPath(target, imageName(base, index, media.length, entry.name));
      await vscode.workspace.fs.writeFile(file, entry.bytes);
      written.push(file);
    }

    getLog().info(`Extracted ${written.length} image(s) from ${name} to ${target.fsPath}.`);
    void vscode.window.showInformationMessage(
      `ShowDocx extracted ${written.length} image${written.length === 1 ? '' : 's'} from ${name}.`,
      'Show Folder',
    ).then((choice) => {
      if (choice === 'Show Folder') {
        void vscode.commands.executeCommand('revealFileInOS', written[0] ?? target);
      }
    });
  } catch (error: unknown) {
    getLog().error(`Extracting images from ${name} failed.`, error);
    void vscode.window.showErrorMessage(`ShowDocx: could not extract images from ${name}.`);
  }
}
