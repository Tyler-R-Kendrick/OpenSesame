/** A loader suspension only; this fixture supplies no authentication. */
export function deliveryGate() {
  let resolveEntered = () => {};
  let release = () => {};
  let loads = 0;
  let draining = false;
  const entered = new Promise<void>((resolve) => {
    resolveEntered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    held,
    release,
    loads: () => loads,
    releaseEntered() {
      draining = true;
      if (loads > 0) release();
    },
    announce() {
      loads += 1;
      resolveEntered();
      if (draining) release();
    },
  };
}
