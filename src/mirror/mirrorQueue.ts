export interface MirrorWriteTicket {
  isCurrent(): boolean;
  run(work: (isCurrent: () => boolean) => Promise<boolean>): Promise<boolean>;
  cancel(): void;
}

interface TargetQueue {
  latest?: object;
  tail: Promise<unknown>;
  running: number;
}

/** One commit at a time per target; reserving invalidates work even before debounce expires. */
export class MirrorWriteQueue {
  private readonly targets = new Map<string, TargetQueue>();

  reserve(key: string): MirrorWriteTicket {
    const queue = this.targets.get(key) ?? { tail: Promise.resolve(), running: 0 };
    this.targets.set(key, queue);
    const generation = {};
    queue.latest = generation;
    const isCurrent = () => queue.latest === generation;
    const release = () => {
      if (isCurrent()) {queue.latest = undefined;}
      if (!queue.latest && queue.running === 0 && this.targets.get(key) === queue) {
        this.targets.delete(key);
      }
    };
    return {
      isCurrent,
      cancel: release,
      run: (work) => {
        queue.running += 1;
        const result = queue.tail.then(() => isCurrent() ? work(isCurrent) : false);
        // A failed conversion must not poison subsequent refreshes.
        queue.tail = result.catch(() => undefined);
        return result.finally(() => {
          queue.running -= 1;
          release();
        });
      },
    };
  }
}
