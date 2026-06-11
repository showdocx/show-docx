import { randomBytes } from 'node:crypto';

export function getNonce(length = 32): string {
  if (!Number.isInteger(length) || length < 16) {
    throw new RangeError('Nonce length must be an integer of at least 16 characters.');
  }

  const bytes = randomBytes(Math.ceil(length * 0.75) + 2);
  return bytes.toString('base64url').slice(0, length);
}
