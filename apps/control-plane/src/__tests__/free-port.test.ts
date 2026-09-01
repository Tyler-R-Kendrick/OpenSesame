/** @vitest-environment node */
import { createServer } from "node:http";
import type { AddressInfo, Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { freePort, onFreePort } from "./free-port.js";

const open: Server[] = [];

/** Actually listen, the way the suites this helper serves do. */
function listen(port: number): Promise<Server> {
  const server = createServer();
  open.push(server);
  return new Promise<Server>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

afterEach(async () => {
  await Promise.all(
    open.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          if (server.listening) server.close(() => resolve());
          else resolve();
        }),
    ),
  );
});

describe("binding a loopback port under contention", () => {
  it("gives back a port that can be listened on", async () => {
    const port = await freePort();
    const server = await listen(port);
    expect(
      /* SAFETY: `listen` resolves only once the socket is up — the checked
          runtime invariant that makes `address()` an AddressInfo, not null. */
      (server.address() as AddressInfo).port,
    ).toBe(port);
  });

  it("takes another port when the first is gone by the time we bind", async () => {
    // The exact CI failure, made deterministic: the first port handed out is
    // taken by somebody else in the window between probing it and binding it.
    const stolen = await freePort();
    await listen(stolen);

    let first = true;
    const server = await onFreePort(async (port) => {
      // Bind the already-taken port on the first go, whatever we were given.
      const target = first ? stolen : port;
      first = false;
      return listen(target);
    });

    expect(server.listening).toBe(true);
    expect(
      /* SAFETY: `listening` is asserted true on the line above — the checked
          runtime invariant that makes `address()` an AddressInfo, not null. */
      (server.address() as AddressInfo).port,
    ).not.toBe(stolen);
  });

  it("rethrows anything that is not the port being taken", async () => {
    // A helper that retried every failure would turn a config error into ten
    // slow attempts and then a message about ports, which is the wrong thing
    // to read at 2am.
    const boom = new Error("the issuer is not a URL");
    await expect(onFreePort(() => Promise.reject(boom))).rejects.toThrow(
      "the issuer is not a URL",
    );
  });

  it("gives up rather than looping forever, and says why", async () => {
    const taken = Object.assign(new Error("listen EADDRINUSE"), {
      code: "EADDRINUSE",
    });
    await expect(onFreePort(() => Promise.reject(taken))).rejects.toThrow(
      /no free loopback port after \d+ attempts/,
    );
  });
});
