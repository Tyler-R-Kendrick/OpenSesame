/**
 * Identity-plane TaskBus sink for outbox drain.
 *
 * Mirrors `crates/task-bus` CloudEvents shape. Default is in-memory (tests).
 * When `OPENSESAME_TASKBUS=nats` (or unset with `NATS_URL`), publishes via the
 * official `nats` JetStream client to `opensesame.events.{type}`.
 *
 * Host (Rust `NatsJetStreamTaskBus`) owns creating stream `OPENSESAME_EVENTS`
 * for `opensesame.events.>`. The worker does **not** silently fall back to
 * core-NATS PUB: JetStream publish must succeed or the drain fails loudly.
 */

import {
  type JetStreamClient,
  type NatsConnection,
  StringCodec,
  connect,
} from "nats";

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
  if (
    explicit === "memory" ||
    explicit === "inmemory" ||
    explicit === "in-memory"
  ) {
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
 * Build a TaskBus from env. Memory never opens sockets; nats uses JetStream.
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
  return NatsJetStreamTaskBus.connect(url);
}

const SUBJECT_PREFIX = "opensesame.events";
const STREAM_NAME = "OPENSESAME_EVENTS";

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
 * JetStream publisher. Relies on Host having created `OPENSESAME_EVENTS`.
 * A missing stream surfaces as a publish error — never silent core-NATS PUB.
 */
export class NatsJetStreamTaskBus implements TaskBus {
  #nc: NatsConnection;
  #js: JetStreamClient;
  #codec = StringCodec();

  private constructor(nc: NatsConnection, js: JetStreamClient) {
    this.#nc = nc;
    this.#js = js;
  }

  static async connect(natsUrl: string): Promise<NatsJetStreamTaskBus> {
    const nc = await connect({ servers: natsUrl, name: "opensesame-worker" });
    const jsm = await nc.jetstreamManager();
    try {
      await jsm.streams.info(STREAM_NAME);
    } catch (caught) {
      await nc.close().catch(() => undefined);
      throw new Error(
        `JetStream stream ${STREAM_NAME} missing — start Host with OPENSESAME_TASKBUS=nats so it creates the stream (${caught instanceof Error ? caught.message : String(caught)})`,
      );
    }
    return new NatsJetStreamTaskBus(nc, nc.jetstream());
  }

  async publish(event: BusEvent): Promise<void> {
    const subject = eventSubject(event.type);
    const payload = this.#codec.encode(JSON.stringify(event));
    // JetStream publish — not core NATS PUB. Fails if stream does not capture subject.
    await this.#js.publish(subject, payload);
  }

  async close(): Promise<void> {
    await this.#nc.drain();
  }
}

/** @deprecated Use NatsJetStreamTaskBus — kept name alias for clarity in logs. */
export const NatsCoreTaskBus = NatsJetStreamTaskBus;
