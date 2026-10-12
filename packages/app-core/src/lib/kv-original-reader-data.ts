/** Fixed DATA reader capture. Only kv.ts supplies its lexical private default backing. */
type Reader = (key: string) => string | null;
export function bindRead(seams: { kvGet: Reader }, expected: Reader) {
  return (original: () => void) => {
    original();
    if (seams.kvGet !== expected) return undefined;
    const current = () => seams.kvGet === expected;
    const check = () => {
      original();
      if (!current()) throw new Error("Original memory KV reader changed.");
    };
    return Object.freeze({
      current,
      check,
      read(key: string): string | null {
        check();
        const value = expected(key);
        check();
        return value;
      },
    });
  };
}
