import * as path from 'node:path';
import * as vscode from 'vscode';
import { freeName, imageName, readMedia } from './text/documentFacts';
import { stripDocumentExtension } from '../shared/documentExtensions';
import { getLog } from './log';
import type { ZipValidationOptions } from './docxLoader';

/**
 * Writes the images out of a document to a folder.
 *
 * The pictures are already stored in the package as ordinary files, so this
 * copies them rather than decoding anything. Getting a diagram out of a
 * specification and into a README otherwise means opening Word.
 */

export interface ExtractImagesHost {
  read(uri: vscode.Uri): Promise<Uint8Array>;
  zipValidationOptions?(): ZipValidationOptions;
}

export async function extractImages(
  source: vscode.Uri | undefined,
  host: ExtractImagesHost,
): Promise<void> {
  if (!source) {
    void vscode.window.showWarningMessage(
      'ShowDocx: open or select a Word document to extract its valid images.',
    );
    return;
  }

  const name = path.basename(source.path);
  try {
    const media = await readMedia(await host.read(source), host.zipValidationOptions?.());
    if (media.length === 0) {
      void vscode.window.showInformationMessage(`ShowDocx: ${name} contains no valid images.`);
      return;
    }

    const folder = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Extract here',
      title: `Extract ${media.length} valid image${media.length === 1 ? '' : 's'} from ${name}`,
      defaultUri: source.with({ path: path.posix.dirname(source.path) }),
    });
    const target = folder?.[0];
    if (!target) {
      return;
    }

    const base = path.basename(stripDocumentExtension(source.path));
    const names = media.map((entry, index) => imageName(base, index, media.length, entry.name));
    // Compared without case: the file systems most people use ignore it.
    const inFolder = new Set((await listNames(target)).map((name) => name.toLowerCase()));
    const clashes = names.filter((name) => inFolder.has(name.toLowerCase()));

    // Extracting the same document twice, or two documents with the same name,
    // into one folder lands on names already there. Writing over them without
    // asking is what the export never does either.
    let keepBoth = false;
    if (clashes.length > 0) {
      const count = clashes.length;
      const choice = await vscode.window.showWarningMessage(
        `${count} of these image${count === 1 ? '' : 's'} already exist${count === 1 ? 's' : ''} in ${path.basename(target.path)}.`,
        {
          modal: true,
          detail: 'Replace them, or keep both by giving the new images numbered names.',
        },
        'Replace',
        'Keep Both',
      );
      if (choice === undefined) {
        return;
      }
      keepBoth = choice === 'Keep Both';
    }

    const written: vscode.Uri[] = [];
    for (const [index, entry] of media.entries()) {
      const planned = names[index] ?? imageName(base, index, media.length, entry.name);
      const name = keepBoth
        ? freeName(planned, (candidate) => inFolder.has(candidate.toLowerCase()))
        : planned;
      inFolder.add(name.toLowerCase());
      const file = vscode.Uri.joinPath(target, name);
      await vscode.workspace.fs.writeFile(file, entry.bytes);
      written.push(file);
    }

    getLog().info(`Extracted ${written.length} valid image(s) from ${name} to ${target.fsPath}.`);
    void vscode.window.showInformationMessage(
      `ShowDocx extracted ${written.length} valid image${written.length === 1 ? '' : 's'} from ${name}.`,
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

/** The names of the files in a folder, or none when it cannot be listed. */
async function listNames(folder: vscode.Uri): Promise<string[]> {
  try {
    return (await vscode.workspace.fs.readDirectory(folder)).map(([name]) => name);
  } catch {
    return [];
  }
}
