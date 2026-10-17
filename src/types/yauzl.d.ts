declare module 'yauzl' {
  import type { Readable } from 'node:stream';

  export interface Entry {
    readonly fileName: string;
    readonly uncompressedSize: number;
  }

  export interface ZipFile {
    readonly entryCount: number;
    on(event: 'entry', listener: (entry: Entry) => void): this;
    on(event: 'end', listener: () => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    readEntry(): void;
    openReadStreamPromise(entry: Entry): Promise<Readable>;
    close(): void;
  }

  export function fromBufferPromise(
    buffer: Buffer,
    options?: {
      lazyEntries?: boolean;
      validateEntrySizes?: boolean;
      strictFileNames?: boolean;
    },
  ): Promise<ZipFile>;
}
