/** Accepted deletion is not the same as completed data erasure. */
import { z } from "zod";
import type { BoatJsonValue } from "./boat-client.js";

const deletionOperationSchema = z.object({
  ok: z.literal(true),
  operation: z.object({
    id: z.string().regex(/^bdop_[a-f0-9]{32}$/u),
    kind: z.literal("sandbox"),
    targetId: z.string(),
    status: z.enum(["pending", "processing", "blocked", "completed"]),
  }),
});

/** No trustworthy operation receipt was obtained; the sandbox ID remains actionable. */
export class BoatDeletionUnconfirmedError extends Error {
  constructor(readonly sandboxId: string) {
    super(
      "boat: sandbox deletion was not confirmed; inspect the sandbox in Boat",
    );
    this.name = "BoatDeletionUnconfirmedError";
  }
}

export async function requestBoatDeletion(
  sandboxId: string,
  timeoutMs: number,
  send: (signal: AbortSignal) => Promise<BoatJsonValue>,
) {
  if (!/^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/u.test(sandboxId))
    throw new Error("boat: invalid sandbox id");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new BoatDeletionUnconfirmedError(sandboxId));
    }, timeoutMs);
  });
  try {
    const raw = await Promise.race([send(controller.signal), timeout]);
    return parseBoatDeletionReceipt(raw, sandboxId);
  } catch {
    throw new BoatDeletionUnconfirmedError(sandboxId);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Deletion was accepted but erasure has not been confirmed. */
export class BoatDeletionPendingError extends Error {
  constructor(
    readonly operationId: string,
    readonly sandboxId: string,
  ) {
    super(
      "boat: sandbox deletion is not yet confirmed; check the deletion operation",
    );
    this.name = "BoatDeletionPendingError";
  }
}

export function parseBoatDeletionReceipt(
  raw: BoatJsonValue,
  sandboxId: string,
) {
  const parsed = deletionOperationSchema.safeParse(raw);
  if (!parsed.success || parsed.data.operation.targetId !== sandboxId)
    throw new Error(
      "boat: deletion completion is not confirmed; invalid operation receipt",
    );
  return parsed.data.operation;
}

export async function waitForBoatDeletion(
  sandboxId: string,
  operationId: string,
  timeoutMs: number,
  intervalMs: number,
  read: (operationId: string, signal: AbortSignal) => Promise<BoatJsonValue>,
): Promise<void> {
  if (
    !/^bdop_[a-f0-9]{32}$/u.test(operationId) ||
    !/^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/u.test(sandboxId)
  )
    throw new Error("boat: invalid deletion identity");
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const remaining = deadline - performance.now();
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(intervalMs, remaining)),
    );
    const timeLeft = Math.ceil(deadline - performance.now());
    if (timeLeft <= 0) break;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new BoatDeletionPendingError(operationId, sandboxId));
      }, timeLeft);
    });
    let raw: BoatJsonValue;
    try {
      raw = await Promise.race([read(operationId, controller.signal), timeout]);
    } catch {
      throw new BoatDeletionPendingError(operationId, sandboxId);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const parsed = deletionOperationSchema.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.operation.id !== operationId ||
      parsed.data.operation.targetId !== sandboxId
    )
      throw new BoatDeletionPendingError(operationId, sandboxId);
    if (parsed.data.operation.status === "completed") return;
  }
  throw new BoatDeletionPendingError(operationId, sandboxId);
}
