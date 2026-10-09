/**
 * Binding a loopback port in a suite that runs many servers at once.
 *
 * Several of these tests start a real control-plane over a real socket, and a
 * server that issues its own tokens has to know its port *before* it binds:
 * `publicUrl` and `issuer` name it, and they go into the config. So the port
 * cannot be chosen by the kernel at bind time and read back afterwards.
 *
 * The obvious way to get one — listen on port 0, read the assigned port, close
 * the socket, hand the number back — is a race, and it was reproducing as CI
 * flake:
 *
 *     FAIL src/__tests__/org-domains.test.ts
 *     Error: listen EADDRINUSE: address already in use 127.0.0.1:33911
 *
 * The probe *releases* the port to learn its number, so between closing the
 * probe and binding for real the port belongs to nobody. Vitest runs these
 * files in parallel worker processes, each doing exactly this, so two workers
 * probing at the same moment can be handed the same freshly-freed port. Every
 * file had its own copy of that helper, so the odds got worse as the suite
 * grew.
 *
 * The window cannot be closed — two sockets cannot both listen on one port —
 * so [`onFreePort`] absorbs it instead: lose the race, take another port, try
 * again. Only `EADDRINUSE` retries. Anything else is a real failure to start a
 * server and is rethrown untouched, because a helper that swallowed a config
 * error and retried it ten times would turn a clear failure into a timeout.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { BoundaryValue } from "@opensesame/os-domain";

/** How many ports to try before giving up. */
const ATTEMPTS = 10;

/**
 * A loopback port that was free a moment ago.
 *
 * Deliberately not called `reservePort`: nothing is reserved. Callers that bind
 * it must be able to cope with losing it, which is what [`onFreePort`] does.
 */
export async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  // SAFETY: probe.listen established the runtime AddressInfo invariant.
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** The shape of the one failure this retries on. */
type ErrnoLike = { code?: string };

function isAddressInUse(error: BoundaryValue): boolean {
  const errno =
    /* SAFETY: `code` is optional, so the assertion asserts no runtime witness;
       the value is checked against the documented EADDRINUSE string before it
       decides anything, and any other shape reads as undefined. */
    error as ErrnoLike | null | undefined;
  return errno?.code === "EADDRINUSE";
}

/**
 * Start something on a loopback port, retrying if another process got there
 * first.
 *
 * `bind` receives the port and must resolve once it is listening — a `bind`
 * that resolves before the socket is up defeats the retry, because the
 * `EADDRINUSE` then arrives as an unhandled error event rather than a rejection
 * this can catch.
 */
export async function onFreePort<T>(
  bind: (port: number) => Promise<T>,
): Promise<T> {
  let lastError: BoundaryValue;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const port = await freePort();
    try {
      return await bind(port);
    } catch (caught) {
      // `catch` binds `unknown` and there is no parser for "whatever a socket
      // threw"; narrowing it to the boundary type is the widest honest claim,
      // and `isAddressInUse` checks the one field it reads.
      const error: BoundaryValue =
        /* SAFETY: BoundaryValue admits every runtime shape a throw can carry,
           so the assertion adds no witness; the contract is checked by
           `isAddressInUse` before it decides anything. */
        caught as BoundaryValue;
      if (!isAddressInUse(error)) throw error;
      lastError = error;
    }
  }
  throw new Error(
    `no free loopback port after ${ATTEMPTS} attempts; the last was taken between probing it and binding it`,
    { cause: lastError },
  );
}
