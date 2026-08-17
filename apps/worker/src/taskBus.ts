/**
 * Identity-plane TaskBus sink for outbox drain.
 *
 * Mirrors `crates/task-bus` CloudEvents shape. Default is in-memory (tests).
 * When `OPENSESAME_TASKBUS=nats` (or unset with `NATS_URL`), publishes via a
 * minimal NATS client to `opensesame.events.{type}` (JetStream stream must
 * already capture that subject — gateway ensures it on connect).
 */

export interface BusEvent {
  id: string;
  specversion: string;
  source: string;
  type: string;
  time: string;
  data: Record<string, unknown>;
}

export interface TaskBus {
  publish(event: BusEvent): Promise<void>;
}

/** In-memory bus used by unit tests and when NATS is not configured. */
export class MemoryTaskBus implements TaskBus {
  readonly published: BusEvent[] = [];

  async publish(event: BusEvent): Promise<void> {
    this.published.push(event);
  }
}

export type TaskBusBackend = "memory" | "nats";

export function resolveTaskBusBackend(
  env: NodeJS.ProcessEnv = process.env,
): TaskBusBackend {
  const explicit = env.OPENSESAME_TASKBUS?.trim().toLowerCase();
  const natsUrl = env.NATS_URL?.trim();
  if (explicit === "memory" || explicit === "inmemory" || explicit === "in-memory") {
    return "memory";
  }
  if (explicit === "nats" || explicit === "jetstream") {
    if (!natsUrl) {
      throw new Error("OPENSESAME_TASKBUS=nats requires NATS_URL");
    }
    return "nats";
  }
  if (explicit) {
    throw new Error(
      `unknown OPENSESAME_TASKBUS=${explicit}; expected memory|nats`,
    );
  }
  return natsUrl ? "nats" : "memory";
}

/**
 * Build a TaskBus from env. Memory never opens sockets; nats uses a thin
 * core-NATS publisher (JetStream stores messages when the stream exists).
 */
export async function createTaskBusFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<TaskBus> {
  if (resolveTaskBusBackend(env) === "memory") {
    return new MemoryTaskBus();
  }
  const url = env.NATS_URL?.trim();
  if (!url) {
    throw new Error("NATS_URL required for nats TaskBus");
  }
  return NatsCoreTaskBus.connect(url);
}

const SUBJECT_PREFIX = "opensesame.events";

export function outboxToBusEvent(event: {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}): BusEvent {
  return {
    id: event.id,
    specversion: "1.0",
    source: `opensesame/outbox/${event.aggregateType}`,
    type: event.eventType,
    time: event.createdAt.toISOString(),
    data: {
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      ...event.payload,
    },
  };
}

export function eventSubject(eventType: string): string {
  return `${SUBJECT_PREFIX}.${eventType.replace(/^\./, "")}`;
}

/**
 * Minimal core-NATS PUB client (no external dep). JetStream retains messages
 * when stream `OPENSESAME_EVENTS` captures `opensesame.events.>`.
 */
export class NatsCoreTaskBus implements TaskBus {
  #socket: import("node:net").Socket;
  #writeChain: Promise<void> = Promise.resolve();

  private constructor(socket: import("node:net").Socket) {
    this.#socket = socket;
  }

  static async connect(natsUrl: string): Promise<NatsCoreTaskBus> {
    const { hostname, port } = parseNatsUrl(natsUrl);
    const net = await import("node:net");
    const socket = await new Promise<import("node:net").Socket>(
      (resolve, reject) => {
        const s = net.createConnection({ host: hostname, port }, () =>
          resolve(s),
        );
        s.once("error", reject);
      },
    );
    socket.setEncoding("utf8");
    await writeRaw(
      socket,
      `CONNECT ${JSON.stringify({
        verbose: false,
        pedantic: false,
        name: "opensesame-worker",
        lang: "node",
        version: "0.1.0",
        protocol: 1,
      })}\r\n`,
    );
    // Consume INFO/PONG noise so it does not fill the buffer unread.
    socket.on("data", () => {
      /* drain */
    });
    return new NatsCoreTaskBus(socket);
  }

  async publish(event: BusEvent): Promise<void> {
    const subject = eventSubject(event.type);
    const payload = Buffer.from(JSON.stringify(event), "utf8");
    const frame = `PUB ${subject} ${payload.length}\r\n`;
    this.#writeChain = this.#writeChain.then(async () => {
      await writeRaw(this.#socket, frame);
      await writeRaw(this.#socket, payload);
      await writeRaw(this.#socket, "\r\n");
    });
    await this.#writeChain;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#socket.end(() => resolve());
    });
  }
}

function parseNatsUrl(url: string): { hostname: string; port: number } {
  const normalized = url.includes("://") ? url : `nats://${url}`;
  const parsed = new URL(normalized);
  return {
    hostname: parsed.hostname || "127.0.0.1",
    port: parsed.port ? Number(parsed.port) : 4222,
  };
}

function writeRaw(
  socket: import("node:net").Socket,
  data: string | Buffer,
): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(data, (err) => (err ? reject(err) : resolve()));
  });
}
