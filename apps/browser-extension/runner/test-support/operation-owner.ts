import type { OriginalOwner } from "../original-owner";
/** Local scope for envelope/protocol tests only; not evidence of vault admission. */
export function testOperationOwner(
  signal = new AbortController().signal,
): OriginalOwner {
  const check = () => signal.throwIfAborted();
  return {
    permit: undefined,
    check,
    async authorize() {
      check();
    },
  };
}
