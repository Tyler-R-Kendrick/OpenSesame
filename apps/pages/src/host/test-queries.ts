/**
 * Vitest setup: Testing Library's polling, made to cost what it checks.
 *
 * A `findBy*` or `waitFor` re-runs its query on every DOM mutation and every
 * 50 ms, and each miss built its error with `prettyDOM` of the whole
 * document, only to throw it away on the next try. Profiled on the join
 * ceremony's suite, that serialization was 0.78 s of the file's 6.8 s of
 * CPU, all of it spent inside the one second a query has to succeed in.
 *
 * Inside a poll (the flag Testing Library itself raises there) a miss now
 * carries only its message. Nothing is lost: when a wait times out, its
 * `onTimeout` calls `getElementError` again, outside the poll, and the
 * failure prints the document as it always did — once, where it used to be
 * printed twice. A query outside a wait is untouched.
 *
 * Only a DOM suite loads Testing Library; a node suite never pays for it.
 */
if ("document" in globalThis) {
  const { configure, getConfig } = await import("@testing-library/react");
  const printed = getConfig().getElementError;
  const polling = (): boolean => {
    const config = getConfig();
    return (
      "_disableExpensiveErrorDiagnostics" in config &&
      config._disableExpensiveErrorDiagnostics === true
    );
  };
  configure({
    getElementError(message, container) {
      if (!polling()) return printed(message, container);
      const error = new Error(message ?? "");
      error.name = "TestingLibraryElementError";
      return error;
    },
  });
}

// A module, so the setup can await Testing Library's import at top level.
export {};
