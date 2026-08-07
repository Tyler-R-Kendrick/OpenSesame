export type QueuedActionInput =
  | { kind: "device_approve"; userCode: string }
  | { kind: "claim_complete"; claimToken: string };

export type QueuedAction = QueuedActionInput & {
  id: string;
  createdAt: string;
};

const KEY = "opensesame.pages.outbox.v1";

export function loadQueue(): QueuedAction[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as QueuedAction[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveQueue(items: QueuedAction[]): void {
  localStorage.setItem(KEY, JSON.stringify(items));
}

export function enqueue(action: QueuedActionInput): QueuedAction {
  const item: QueuedAction = {
    ...action,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  saveQueue([...loadQueue(), item]);
  return item;
}

export function dequeue(id: string): void {
  saveQueue(loadQueue().filter((a) => a.id !== id));
}
