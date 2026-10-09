/**
 * Serialize mutations that check-then-write shared Maps.
 * JavaScript is single-threaded, but awaits between a quota read and a write
 * let another request pass the same check.
 */
export async function serializeKeyed<T>(
  tails: Map<string, Promise<void>>,
  key: string,
  mutation: () => Promise<T>,
): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  let release = () => {};
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => turn);
  tails.set(key, tail);
  await previous;
  try {
    return await mutation();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}
