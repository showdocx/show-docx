/**
 * A short, stable digest used to represent binary content in the diff text.
 * Identical bytes give an identical digest, so an untouched image stays silent
 * in a diff and a replaced one is a single changed word.
 *
 * FNV-1a: a change detector, not a checksum. Nothing here is a security claim.
 */

const OFFSET_BASIS = 0x811c9dc5;
const PRIME = 0x01000193;

export function fingerprintBytes(bytes: Uint8Array): string {
  let hash = OFFSET_BASIS;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index] ?? 0;
    hash = Math.imul(hash, PRIME) >>> 0;
  }
  return format(hash);
}

export function fingerprintText(value: string): string {
  let hash = OFFSET_BASIS;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, PRIME) >>> 0;
  }
  return format(hash);
}

function format(hash: number): string {
  return hash.toString(16).padStart(8, '0');
}
