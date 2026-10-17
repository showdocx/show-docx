import * as vscode from 'vscode';
import { buildExcludePattern } from '../../shared/excludePattern';

/**
 * Combines standard ignored directories (node_modules, .git, .venv, vendor) with the
 * user's configured files.exclude and search.exclude settings into a glob pattern for findFiles.
 */
export function getWorkspaceExcludePattern(): string {
  const filesExclude = vscode.workspace.getConfiguration('files').get<Record<string, boolean>>('exclude');
  const searchExclude = vscode.workspace.getConfiguration('search').get<Record<string, boolean>>('exclude');
  return buildExcludePattern(filesExclude, searchExclude);
}
