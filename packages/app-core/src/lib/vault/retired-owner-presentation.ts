/** Store-owned handle adaptation and task retirement only; never authenticates an owner. */
import type { LocalVaultStarted } from "@opensesame/vault-core/local-vault-security.js";
import {
  type RetiredOperationEntries,
  type RetiredOperationExchange,
  requireRetiredOperationExchange,
} from "./retired-operation-exchange.js";
export function retireRetiredOwnerTask<T extends object>(
  entries: RetiredOperationEntries<T>,
  exchange: RetiredOperationExchange<T>,
  task: Promise<T>,
  release: () => void,
) {
  const finish = () => {
    release();
    entries.finish(exchange);
  };
  const tracked = task
    .then((result) => {
      finish();
      exchange.settle(result);
    })
    .catch((cause: unknown) => {
      finish();
      exchange.fail(cause);
    });
  exchange.track(tracked);
}
export async function presentRetiredOwnerStarted<T extends object>(
  entries: RetiredOperationEntries<T>,
  exchange: RetiredOperationExchange<T>,
): Promise<LocalVaultStarted<T>> {
  const started = await exchange.started();
  if (started.kind === "complete") return started;
  const requireEntry = () =>
    requireRetiredOperationExchange(entries, started.challenge);
  return Object.freeze({
    kind: "challenge",
    routes: started.routes,
    requestCode: async (channel: "email" | "sms") => {
      const status = await requireEntry().send(channel);
      return Object.freeze({
        channel: status.channel,
        expiresAt: status.expiresAt,
      });
    },
    complete: async (factor) => await requireEntry().complete(factor),
    cancel: () => exchange.drain(),
  });
}
