/** Physical response ownership, independent of provider/configuration modules. */
const lifetimes = new WeakMap<
  Response,
  { signal: AbortSignal; retire?: () => void }
>();

export function hasNativeResponseLifetime(response: Response): boolean {
  return lifetimes.has(response);
}
export function bindNativeResponseLifetime(
  response: Response,
  retire: (() => void) | undefined,
  signal: AbortSignal,
) {
  if (lifetimes.has(response))
    throw new Error("The transport reused a live response.");
  lifetimes.set(response, { signal, retire });
}
export function nativeResponseBodySignal(response: Response) {
  return lifetimes.get(response)?.signal;
}
export function finishNativeResponseBody(response: Response) {
  const lifetime = lifetimes.get(response);
  lifetimes.delete(response);
  lifetime?.retire?.();
}
