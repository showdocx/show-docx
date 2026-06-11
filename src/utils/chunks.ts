export const DEFAULT_CHUNK_SIZE = 1024 * 1024;

export function splitIntoChunks(
  data: Uint8Array,
  chunkSize = DEFAULT_CHUNK_SIZE,
): Uint8Array[] {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new RangeError('Chunk size must be a positive integer.');
  }

  if (data.byteLength === 0) {
    return [data];
  }

  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < data.byteLength; offset += chunkSize) {
    chunks.push(data.subarray(offset, Math.min(offset + chunkSize, data.byteLength)));
  }
  return chunks;
}
