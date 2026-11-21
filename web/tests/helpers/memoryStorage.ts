export interface MemoryStorage extends Storage {
  /** Make every setItem throw, like a full or disabled store. */
  failWrites(): void;
  /** Called with each key right before it is written. */
  onWrite(cb: (key: string) => void): void;
}

export function createMemoryStorage(): MemoryStorage {
  const m = new Map<string, string>();
  let failing = false;
  let writeHook: ((key: string) => void) | null = null;
  return {
    get length() {
      return m.size;
    },
    clear: () => {
      m.clear();
    },
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => {
      m.delete(k);
    },
    setItem: (k, v) => {
      if (failing) throw new DOMException('quota', 'QuotaExceededError');
      writeHook?.(k);
      m.set(k, v);
    },
    failWrites: () => {
      failing = true;
    },
    onWrite: (cb) => {
      writeHook = cb;
    },
  };
}
