/** Connection correlation never grants provider authority or chooses a saved credential. */
export function authorizationCorrelation(input: {
  initial?: string;
  stale?: string;
  existing: ReadonlySet<string>;
  read(id: string): "same-provider" | "other-provider" | "absent";
}) {
  let bound = input.initial;
  let candidate: string | undefined;
  const stale =
    !bound && input.stale && input.read(input.stale) === "absent"
      ? input.stale
      : undefined;
  const reject = () => {
    throw new Error("Provider sign-in selection changed");
  };
  const check = () => {
    const id = bound ?? candidate;
    if (id && input.read(id) !== "same-provider") reject();
  };
  return {
    check,
    select(id?: string) {
      check();
      if (!id || (id === stale && input.read(id) === "absent")) return;
      if (input.read(id) !== "same-provider") reject();
      if (bound) {
        if (id !== bound) reject();
        return;
      }
      if (input.existing.has(id) || (candidate && candidate !== id)) reject();
      candidate = id;
    },
    bind(id: string) {
      check();
      if ((bound && bound !== id) || (candidate && candidate !== id)) reject();
      if (input.read(id) !== "same-provider") reject();
      bound = id;
    },
  };
}

/** A local closed flag protects legacy ports lacking a captured browser guard. */
export function authorizationAttempt(
  release: (() => void) | undefined,
  cancelLegacy: (() => void) | undefined,
  guard: () => void,
  retired: () => void,
  correlation: ReturnType<typeof authorizationCorrelation>,
) {
  let open = true;
  const check = () => {
    if (!open) throw new Error("Provider sign-in was cancelled");
    guard();
    correlation.check();
  };
  const close = (cancel: boolean) => {
    if (!open) return;
    open = false;
    try {
      if (release) {
        release();
        return;
      }
      if (cancel) {
        try {
          guard();
        } catch {
          return;
        }
        cancelLegacy?.();
      }
    } finally {
      retired();
    }
  };
  return {
    check,
    bind(id: string) {
      check();
      correlation.bind(id);
    },
    selectConnection(id?: string) {
      if (!open) return;
      try {
        check();
        correlation.select(id);
      } catch {
        close(true);
      }
    },
    finish: () => close(false),
    cancel: () => close(true),
    current: () => {
      try {
        check();
        return true;
      } catch {
        return false;
      }
    },
  };
}
