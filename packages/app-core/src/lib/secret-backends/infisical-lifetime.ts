import { SecretBackendHttpError, type createBackendHttp } from "./http.js";
import { SecretBackendError } from "./types.js";

const MAX_TIMER_MS = 2_147_483_647;

function ended(): SecretBackendError {
  return new SecretBackendError("authentication", "Connect Infisical again.");
}

/** One issued token owns its deadline, transport cancellation and private credential. */
export function createInfisicalLifetime(
  request: ReturnType<typeof createBackendHttp>,
) {
  const controller = new AbortController();
  const started = Date.now();
  const monotonic = performance.now();
  let token = "";
  let duration: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = () =>
    Math.max(Date.now() - started, performance.now() - monotonic);
  function close(): void {
    token = "";
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    controller.abort();
  }
  function check(): void {
    if (duration !== null && elapsed() >= duration) close();
    if (controller.signal.aborted) throw ended();
  }
  function arm(): void {
    if (duration === null || controller.signal.aborted) return;
    const remaining = duration - elapsed();
    if (remaining <= 0) close();
    else timer = setTimeout(arm, Math.min(remaining, MAX_TIMER_MS));
  }
  return {
    signal: controller.signal,
    check,
    close,
    install(value: string, expiresIn: number | null): void {
      try {
        new Headers().set("authorization", `Bearer ${value}`);
      } catch {
        throw new SecretBackendError(
          expiresIn === null ? "configuration" : "response",
          "The Infisical access token is not valid for HTTP authorization.",
        );
      }
      if (expiresIn !== null) {
        const milliseconds = expiresIn * 1000;
        if (
          !Number.isFinite(milliseconds) ||
          milliseconds <= 0 ||
          started + milliseconds > Number.MAX_SAFE_INTEGER ||
          monotonic + milliseconds > Number.MAX_SAFE_INTEGER
        )
          throw new SecretBackendError(
            "response",
            "Infisical did not return a valid token lifetime.",
          );
        duration = milliseconds;
      }
      check();
      token = value;
      arm();
      check();
    },
    async call(path: string, init: RequestInit = {}) {
      check();
      if (!token) throw ended();
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${token}`);
      const signal = init.signal
        ? AbortSignal.any([controller.signal, init.signal])
        : controller.signal;
      const current = () => {
        check();
        if (signal.aborted)
          throw new SecretBackendError(
            "stale",
            "The Infisical request was cancelled.",
          );
      };
      current();
      try {
        const result = await request(path, { ...init, headers, signal });
        current();
        return result;
      } catch (error) {
        current();
        if (
          error instanceof SecretBackendHttpError &&
          (error.status === 401 ||
            (error.status === 403 && error.responseKind === "token-error"))
        )
          close();
        throw error;
      }
    },
  };
}
