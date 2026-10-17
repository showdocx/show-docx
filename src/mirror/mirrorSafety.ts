import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface PhysicalPathHost {
  realpath(file: string): Promise<string>;
  lstat(file: string): Promise<{ isSymbolicLink(): boolean }>;
  readlink(file: string): Promise<string>;
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/** Resolve missing paths too, without mistaking a dangling link for a missing entry. */
async function physicalPath(file: string, host: PhysicalPathHost, links = 0): Promise<string> {
  if (links > 40) {throw new Error('Too many symbolic links in mirror path.');}
  try {
    return await host.realpath(file);
  } catch (error) {
    if (!isMissing(error)) {throw error;}
  }

  let symbolicLink = false;
  try {
    symbolicLink = (await host.lstat(file)).isSymbolicLink();
  } catch (error) {
    if (!isMissing(error)) {throw error;}
  }
  if (symbolicLink) {
    const link = await host.readlink(file);
    // Keep `..` until its preceding components have been physically resolved:
    // `redirect/../file` may leave the base when redirect is itself a symlink.
    const linkedPath = path.isAbsolute(link) ? link : `${path.dirname(file)}${path.sep}${link}`;
    return physicalPath(linkedPath, host, links + 1);
  }
  const parent = path.dirname(file);
  if (parent === file) {throw new Error('Cannot resolve the mirror filesystem root.');}
  return path.join(await physicalPath(parent, host, links), path.basename(file));
}

/** Only ENOENT permits resolving a missing suffix; access, I/O and loop errors fail closed. */
export async function isPhysicalPathContained(
  target: string,
  base: string,
  host: PhysicalPathHost = fs,
): Promise<boolean> {
  try {
    // The base must exist. Otherwise there is no physical containment boundary.
    const root = await host.realpath(base);
    const absoluteTarget = path.isAbsolute(target) ? target : `${process.cwd()}${path.sep}${target}`;
    const resolved = await physicalPath(absoluteTarget, host);
    const relative = path.relative(root, resolved);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  } catch {
    return false;
  }
}
