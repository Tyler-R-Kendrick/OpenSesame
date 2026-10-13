/** Transport-custody controls only. These test doubles never stand in for genuine Root/factor proof. */
import { afterEach, describe, expect, it } from "vitest";
import { configureHost } from "../../host.js";
import { createTestHost } from "../../test-host.js";
import { captureHostAuthenticationPort } from "./capture-host-authentication-port.js";
import type {
  PhysicalAuthenticationPort,
  PhysicalAuthenticationReader,
} from "./physical-authentication-port.js";

afterEach(() => configureHost(createTestHost()));
function install(reader: PhysicalAuthenticationReader) {
  const port: PhysicalAuthenticationPort = {
    bodyFormat: "flat-v1",
    capture: async () => reader,
  };
  configureHost(createTestHost({ physicalVaultAuthentication: port }));
}
function reader(): PhysicalAuthenticationReader {
  return {
    check() {},
    revalidateRoot: async () => {},
    close: async () => {},
    readOriginalStateIdentity: async () => "original-actual-transport-profile",
    read: async () => ({ tomb: "selected", header: null, body: null }),
  };
}
async function rejected<T>(work: Promise<T>): Promise<ErrorOptions> {
  const outcome = await work.then(
    () => ({ ok: true as const }),
    (cause) => ({ ok: false as const, cause }),
  );
  if (outcome.ok) throw new Error("The transport unexpectedly accepted.");
  return { cause: outcome.cause };
}
describe("actual captured physical transport custody", () => {
  it("retains and rechecks the original state identity function", async () => {
    const source = reader();
    install(source);
    const captured = await captureHostAuthenticationPort("selected", () => {});
    expect(await captured.readOriginalStateIdentity()).toBe(
      "original-actual-transport-profile",
    );
    Object.defineProperty(source, "readOriginalStateIdentity", {
      value: async () => "substituted",
    });
    await expect(captured.readOriginalStateIdentity()).rejects.toThrow(
      "changed",
    );
    await captured.close();
  });
  it("does not replace a missing physical state identity with a local guess", async () => {
    const source = reader();
    let closed = 0;
    Object.defineProperty(source, "readOriginalStateIdentity", {
      value: undefined,
    });
    Object.defineProperty(source, "close", {
      value: async () => {
        closed++;
      },
    });
    install(source);
    await expect(
      captureHostAuthenticationPort("selected", () => {}),
    ).rejects.toThrow("changed");
    expect(closed).toBe(1);
  });
  it.each([undefined, 0, -0, Promise.resolve("opaque cause")])(
    "preserves work and close causes by presence and order (%s)",
    async (workCause) => {
      const source = reader();
      const closeCause = Promise.resolve("opaque cleanup cause");
      Object.defineProperty(source, "revalidateRoot", {
        value: async () => {
          throw workCause;
        },
      });
      Object.defineProperty(source, "close", {
        value: async () => {
          throw closeCause;
        },
      });
      install(source);
      const caught = (
        await rejected(captureHostAuthenticationPort("selected", () => {}))
      ).cause;
      expect(caught).toBeInstanceOf(AggregateError);
      if (!(caught instanceof AggregateError))
        throw new Error("Expected both causes.");
      expect(caught.errors).toHaveLength(2);
      expect(Object.is(caught.errors[0], workCause)).toBe(true);
      expect(caught.errors[1]).toBe(closeCause);
    },
  );
  it("owns delivered cleanup before a later read slot getter refuses", async () => {
    const source = reader();
    let closed = 0;
    const cause = new Error("delivered read getter refused");
    Object.defineProperty(source, "close", {
      value: async () => {
        closed++;
      },
    });
    Object.defineProperty(source, "read", {
      get() {
        throw cause;
      },
    });
    install(source);
    expect(
      (await rejected(captureHostAuthenticationPort("selected", () => {})))
        .cause,
    ).toBe(cause);
    expect(closed).toBe(1);
  });
});
