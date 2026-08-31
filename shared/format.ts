/**
 * Helpers shared by the extension host and the webview. Both bundles compile
 * this file directly, so a number is described the same way wherever it appears.
 */

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new RangeError('Byte count must be a non-negative finite number.');
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const formatted = value.toFixed(value >= 10 ? 1 : 2).replace(/\.0+$/, '');
  return `${formatted} ${units[unitIndex]}`;
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
