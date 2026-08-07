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

export function updateTaskFromResponse(body: {
  task_run_id?: string;
  state_version?: number;
}): void {
  if (!body.task_run_id || body.state_version === undefined) {
    return;
  }
  current = {
    taskRunId: body.task_run_id,
    stateVersion: body.state_version,
    frozenIntent: current?.taskRunId === body.task_run_id ? current.frozenIntent : undefined,
  };
}
