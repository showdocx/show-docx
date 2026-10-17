import { createHash } from 'node:crypto';

/**
 * A stable digest used to represent binary content in the diff text.
 * Identical bytes give an identical digest, so an untouched image stays silent
 * in a diff and a replaced one is a single changed word.
 */

export function fingerprintBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function fingerprintText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
