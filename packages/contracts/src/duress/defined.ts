/** Fail closed when a value must exist after an earlier length/presence check. */
export function defined<T>(value: T | null | undefined, label: string): T {
  if (value == null) {
    throw new Error(`expected ${label}`);
  }
  return value;
}
