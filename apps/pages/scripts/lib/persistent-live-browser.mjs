/**
 * WebKit's ephemeral contexts do not expose OPFS. Each simulated person gets
 * a separate persistent profile and process, so the walk exercises the real
 * storage API without letting peers share vaults or browser state.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export function persistentLiveBrowser(browserType, launchOptions) {
  const contexts = new Map();
  const pending = new Set();
  let closing;

  async function createContext(options) {
    const directory = await mkdtemp(
      path.join(tmpdir(), "opensesame-live-webkit-"),
    );
    let context;
    try {
      context = await browserType.launchPersistentContext(directory, {
        ...launchOptions,
        ...options,
      });
      // launchPersistentContext opens a blank page; the harness owns its page.
      await Promise.all(context.pages().map((page) => page.close()));
      const close = context.close.bind(context);
      let retired;
      context.close = (...args) => {
        retired ??= (async () => {
          try {
            await close(...args);
          } finally {
            contexts.delete(context);
            await rm(directory, { recursive: true, force: true });
          }
        })();
        return retired;
      };
      contexts.set(context, directory);
      return context;
    } catch (error) {
      await context?.close().catch(() => {});
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  return {
    browserType: () => browserType,
    contexts: () => [...contexts.keys()],
    newContext(options = {}) {
      if (closing) return Promise.reject(new Error("Live browser is closed"));
      const work = createContext(options);
      pending.add(work);
      const settled = () => pending.delete(work);
      void work.then(settled, settled);
      return work;
    },
    close() {
      closing ??= (async () => {
        // A device already being opened belongs to this owner too.
        await Promise.allSettled([...pending]);
        const results = await Promise.allSettled(
          [...contexts.keys()].map((context) => context.close()),
        );
        const errors = results.filter((result) => result.status === "rejected");
        if (errors.length)
          throw new AggregateError(
            errors.map((result) => result.reason),
            "Live browser cleanup failed",
          );
      })();
      return closing;
    },
  };
}
