/**
 * Credential rotation consumer (WP-E).
 *
 * Consumes CloudEvents-shaped bus messages for
 * `credential.rotation.requested|succeeded|failed`. Never materializes or
 * returns secret values — Host APIs remain ConnectionRef / status only.
 *
 * The Rust TaskBus trait is the authority-plane publisher; this TS module is
 * the identity/worker-side drain that reacts to those event types.
 */

export const EVENT_ROTATION_REQUESTED = "credential.rotation.requested";
export const EVENT_ROTATION_SUCCEEDED = "credential.rotation.succeeded";
export const EVENT_ROTATION_FAILED = "credential.rotation.failed";

export type RotationEventType =
  | typeof EVENT_ROTATION_REQUESTED
  | typeof EVENT_ROTATION_SUCCEEDED
  | typeof EVENT_ROTATION_FAILED;

export interface BusEventLike {
  id: string;
  type: string;
  source?: string;
  time?: string;
  data: Record<string, unknown>;
}

/** Minimal TaskBus-shaped surface for unit tests and outbox drains. */
export interface TaskBusLike {
  publish(event: BusEventLike): Promise<void>;
  drain(max: number): Promise<BusEventLike[]>;
}

export interface RotationJobView {
  id: string;
  status: "requested" | "succeeded" | "failed";
  connectionId?: string;
  storePath?: string;
  projectId?: string;
  organizationId?: string;
  error?: string;
  /** Always false — agents never receive rotated secrets. */
  secretsReturned: false;
}

const FORBIDDEN_KEYS = new Set([
  "secret",
  "password",
  "token",
  "access_token",
  "refresh_token",
  "api_key",
  "value",
  "client_secret",
]);

export function assertNoSecrets(payload: Record<string, unknown>): void {
  for (const key of Object.keys(payload)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      throw new Error(
        `rotation payload must not include secret field \`${key}\``,
      );
    }
  }
}

export function toPublicJobView(
  data: Record<string, unknown>,
): RotationJobView {
  assertNoSecrets(data);
  const target = data.target as Record<string, unknown> | undefined;
  const statusRaw = String(data.status ?? "requested");
  const status =
    statusRaw === "succeeded" || statusRaw === "failed"
      ? statusRaw
      : "requested";
  const view: RotationJobView = {
    id: String(data.rotation_id ?? data.id ?? ""),
    status,
    secretsReturned: false,
  };
  const connectionId =
    typeof target?.connection_id === "string"
      ? target.connection_id
      : typeof data.connection_id === "string"
        ? data.connection_id
        : undefined;
  if (connectionId) view.connectionId = connectionId;
  const storePath =
    typeof target?.path === "string"
      ? target.path
      : typeof data.store_path === "string"
        ? data.store_path
        : undefined;
  if (storePath) view.storePath = storePath;
  if (typeof data.project_id === "string") view.projectId = data.project_id;
  if (typeof data.organization_id === "string") {
    view.organizationId = data.organization_id;
  }
  if (typeof data.error === "string") view.error = data.error;
  return view;
}

export interface RotationConsumerDeps {
  bus: TaskBusLike;
  /**
   * Host callback to execute a requested connection rotation.
   * Must not return secret material.
   */
  executeConnectionRotation?: (args: {
    rotationId: string;
    connectionId: string;
    organizationId?: string;
  }) => Promise<RotationJobView>;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface RotationConsumeResult {
  processed: number;
  succeeded: number;
  failed: number;
  jobs: RotationJobView[];
}

/**
 * Drain up to `max` bus events and handle rotation.requested messages.
 * Succeeded/failed events are recorded as views only (no secret fields).
 */
export async function consumeRotationEvents(
  deps: RotationConsumerDeps,
  max = 32,
): Promise<RotationConsumeResult> {
  const events = await deps.bus.drain(max);
  const jobs: RotationJobView[] = [];
  let succeeded = 0;
  let failed = 0;

  for (const event of events) {
    if (
      event.type !== EVENT_ROTATION_REQUESTED &&
      event.type !== EVENT_ROTATION_SUCCEEDED &&
      event.type !== EVENT_ROTATION_FAILED
    ) {
      continue;
    }
    assertNoSecrets(event.data);
    if (event.type === EVENT_ROTATION_REQUESTED) {
      const view = toPublicJobView(event.data);
      const connectionId = view.connectionId;
      if (connectionId && deps.executeConnectionRotation) {
        try {
          const done = await deps.executeConnectionRotation({
            rotationId: view.id,
            connectionId,
            ...(view.organizationId
              ? { organizationId: view.organizationId }
              : {}),
          });
          // SAFETY: rotation results are JSON objects; assertNoSecrets walks
          // string keys looking for secret needles. RotationJobView has no
          // index signature, so TypeScript requires the unknown step.
          assertNoSecrets(done as unknown as Record<string, unknown>);
          if (done.secretsReturned !== false) {
            throw new Error("rotation executor must set secretsReturned=false");
          }
          jobs.push({ ...done, secretsReturned: false });
          if (done.status === "succeeded") succeeded += 1;
          else failed += 1;
        } catch (err) {
          failed += 1;
          const error = err instanceof Error ? err.message : String(err);
          deps.log?.("rotation execute failed", { rotationId: view.id, error });
          jobs.push({
            ...view,
            status: "failed",
            error,
            secretsReturned: false,
          });
          await deps.bus.publish({
            id: `evt_fail_${view.id}`,
            type: EVENT_ROTATION_FAILED,
            source: "opensesame://worker/rotation",
            time: new Date().toISOString(),
            data: {
              rotation_id: view.id,
              status: "failed",
              error,
              connection_id: connectionId,
              organization_id: view.organizationId,
            },
          });
        }
      } else {
        jobs.push(view);
      }
    } else {
      const view = toPublicJobView(event.data);
      jobs.push(view);
      if (event.type === EVENT_ROTATION_SUCCEEDED) succeeded += 1;
      if (event.type === EVENT_ROTATION_FAILED) failed += 1;
    }
  }

  return {
    processed: jobs.length,
    succeeded,
    failed,
    jobs,
  };
}

/** In-memory TaskBus stand-in for unit tests. */
export class InMemoryTaskBus implements TaskBusLike {
  private readonly q: BusEventLike[] = [];

  async publish(event: BusEventLike): Promise<void> {
    this.q.push(event);
  }

  async drain(max: number): Promise<BusEventLike[]> {
    return this.q.splice(0, max);
  }
}
