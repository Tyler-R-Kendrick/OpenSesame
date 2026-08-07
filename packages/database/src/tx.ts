import type { NewOutboxEvent, Repositories, UnitOfWork } from "./repos/interfaces.js";
import type { OutboxEvent } from "@opensesame/os-domain";

/**
 * Run domain work and append an outbox event in the same transaction.
 * Both MemoryRepositories and PostgresRepositories honor this boundary.
 */
export async function withOutbox<T>(
  repos: Repositories,
  event: NewOutboxEvent,
  work: (uow: UnitOfWork) => Promise<T>,
): Promise<{ result: T; outbox: OutboxEvent }> {
  return repos.transaction(async (uow) => {
    const result = await work(uow);
    const outbox = await uow.appendOutbox(event);
    return { result, outbox };
  });
}

export async function appendOutboxInTransaction(
  repos: Repositories,
  event: NewOutboxEvent,
): Promise<OutboxEvent> {
  return repos.transaction(async (uow) => uow.appendOutbox(event));
}
