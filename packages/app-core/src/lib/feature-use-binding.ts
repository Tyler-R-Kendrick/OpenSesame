/**
 * The operation a running feature performs. Activation registers it.
 * The next backup, certificate, connection load, or payment reads the
 * connector saved on this device after that registration.
 */

const bound = new Map<string, () => void>();

/** Register the operation `id` performs until the returned function runs. */
export function bindFeatureUse(id: string, use: () => void): () => void {
  bound.set(id, use);
  return () => {
    if (bound.get(id) === use) bound.delete(id);
  };
}

/** Run the operation registered for `id`. False when nothing registered. */
export function runFeatureUse(id: string): boolean {
  const use = bound.get(id);
  if (!use) return false;
  use();
  return true;
}

export function resetFeatureUsesBindingForTest(): void {
  bound.clear();
}
