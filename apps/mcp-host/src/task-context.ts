export interface FrozenIntentContext {
  intentId: string;
  intentDigest: string;
  operation: string;
  resource: string;
  audience: string;
  canonicalArguments: unknown;
}

export interface TaskContext {
  taskRunId: string;
  stateVersion: number;
  frozenIntent?: FrozenIntentContext;
}

export interface TaskResponse {
  task_run_id?: string;
  state_version?: number;
}

export interface TaskUpdateOptions {
  adopt: boolean;
}

let current: TaskContext | null = null;

export function getTaskContext(): TaskContext | null {
  return current;
}

export function setTaskContext(ctx: TaskContext | null): void {
  current = ctx;
}

export function requireTaskRunId(): string {
  if (!current?.taskRunId) {
    throw new Error("task_context_required");
  }
  return current.taskRunId;
}

export function requireFrozenIntent(): FrozenIntentContext {
  if (!current?.frozenIntent) {
    throw new Error("frozen_intent_required");
  }
  return current.frozenIntent;
}

/** Forget a spent intent while staying on the same task. */
export function clearFrozenIntent(): void {
  if (!current) return;
  const { frozenIntent: _spent, ...rest } = current;
  current = rest;
}

/**
 * Adopt the task a response describes, or merely refresh the one already active.
 *
 * `adopt` belongs to the call that created the task. A read must not be able to
 * repoint the active context: `task_status` takes a task_run_id from the model,
 * and if reading someone else's task made it the current one, a look would become
 * a move.
 */
export function updateTaskFromResponse(
  body: TaskResponse,
  options: TaskUpdateOptions = { adopt: true },
): void {
  if (!body.task_run_id || body.state_version === undefined) {
    return;
  }
  if (!options.adopt && current?.taskRunId !== body.task_run_id) {
    return;
  }
  const next: TaskContext = {
    taskRunId: body.task_run_id,
    stateVersion: body.state_version,
  };
  if (current?.taskRunId === body.task_run_id && current.frozenIntent) {
    next.frozenIntent = current.frozenIntent;
  }
  current = next;
}
