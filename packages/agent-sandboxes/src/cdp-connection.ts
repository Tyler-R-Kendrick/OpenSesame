/**
 * Minimal Chrome DevTools Protocol connection: JSON-RPC over a WebSocket,
 * flat session routing, no dependencies. The socket is injected so the
 * same connection code runs in Node (the `ws` client, which can send the
 * provider's authorization header on upgrade) or any WebSocket host.
 */

import { z } from "zod";

export interface CdpSocket {
  send(data: string): void;
  close(): void;
  onMessage(listener: (data: string) => void): void;
  onClose(listener: () => void): void;
}

/** Any JSON value; the protocol payload contract at this seam. */
export type CdpJsonValue =
  | string
  | number
  | boolean
  | null
  | CdpJsonValue[]
  | { [key: string]: CdpJsonValue };

/** A CDP params/result object: JSON values under string keys. */
export interface CdpParams {
  [key: string]: CdpJsonValue;
}

const cdpJsonValueSchema: z.ZodType<CdpJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(cdpJsonValueSchema),
    z.record(z.string(), cdpJsonValueSchema),
  ]),
);

const cdpMessageSchema = z.object({
  id: z.number().optional(),
  method: z.string().optional(),
  sessionId: z.string().optional(),
  result: cdpJsonValueSchema.optional(),
  error: z.object({ message: z.string() }).optional(),
  params: cdpJsonValueSchema.optional(),
});

export type CdpEventHandler = (params: CdpJsonValue | undefined) => void;

interface PendingCall {
  resolve: (result: CdpJsonValue | undefined) => void;
  reject: (error: Error) => void;
}

interface CdpRequestMessage {
  id: number;
  method: string;
  params: CdpParams;
  sessionId?: string;
}

export class CdpConnection {
  private sequence = 0;
  private readonly pending = new Map<number, PendingCall>();
  private readonly handlers = new Map<string, Set<CdpEventHandler>>();
  private closed = false;

  constructor(private readonly socket: CdpSocket) {
    socket.onMessage((data) => this.handle(data));
    socket.onClose(() => {
      this.closed = true;
      for (const call of this.pending.values())
        call.reject(new Error("cdp: connection closed"));
      this.pending.clear();
    });
  }

  private handle(data: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      return;
    }
    const result = cdpMessageSchema.safeParse(raw);
    if (!result.success) return;
    const parsed = result.data;
    if (parsed.id !== undefined) {
      const call = this.pending.get(parsed.id);
      if (!call) return;
      this.pending.delete(parsed.id);
      if (parsed.error) call.reject(new Error(`cdp: ${parsed.error.message}`));
      else call.resolve(parsed.result);
      return;
    }
    if (parsed.method) {
      const key = `${parsed.sessionId ?? ""}:${parsed.method}`;
      for (const handler of this.handlers.get(key) ?? [])
        handler(parsed.params);
      for (const handler of this.handlers.get(parsed.method) ?? [])
        handler(parsed.params);
    }
  }

  on(method: string, handler: CdpEventHandler, sessionId?: string): void {
    const key = sessionId ? `${sessionId}:${method}` : method;
    const set = this.handlers.get(key) ?? new Set<CdpEventHandler>();
    set.add(handler);
    this.handlers.set(key, set);
  }

  async call<T>(
    method: string,
    params: CdpParams = {},
    sessionId?: string,
  ): Promise<T> {
    if (this.closed) throw new Error("cdp: connection closed");
    this.sequence += 1;
    const id = this.sequence;
    const result = await new Promise<CdpJsonValue | undefined>(
      (resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        const message: CdpRequestMessage = { id, method, params };
        if (sessionId) message.sessionId = sessionId;
        this.socket.send(JSON.stringify(message));
      },
    );
    // SAFETY: each caller names the CDP result shape it asked for; the protocol is untyped at this seam and results are consumed structurally.
    return result as T;
  }

  close(): void {
    this.socket.close();
  }
}
