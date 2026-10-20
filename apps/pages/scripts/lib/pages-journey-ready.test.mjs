import { afterEach, describe, expect, it, vi } from "vitest";
import { PIN, unlockWithPin, waitOpen } from "./pages-journey.mjs";
import { unlockIfLocked } from "./tutorial-walk.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** Locator contract only; the compiled app/browser remains an acceptance gate. */
function fixture({ open = true, pin = true, detached = false } = {}) {
  const opened = deferred();
  const finished = deferred();
  const gateStarted = deferred();
  const field = {
    waitFor: vi.fn(() => (pin ? Promise.resolve() : opened.promise)),
    isVisible: vi.fn(async () => pin),
    fill: vi.fn(async () => {}),
    press: vi.fn(async (key) => {
      expect(key).toBe("Enter");
      open = true;
      opened.resolve();
    }),
  };
  const lock = {
    locator: vi.fn((selector) => {
      expect(selector).toBe("visible=true");
      return lock;
    }),
    first: () => lock,
    waitFor: vi.fn(() => (open ? Promise.resolve() : opened.promise)),
    isVisible: vi.fn(async () => open),
  };
  const gate = {
    waitFor: vi.fn((options) => {
      expect(options.state).toBe("detached");
      gateStarted.resolve();
      return detached ? Promise.resolve() : finished.promise;
    }),
  };
  const submit = vi.fn(async () => {
    open = true;
    opened.resolve();
  });
  const page = {
    getByRole(role, { name, exact }) {
      expect(role).toBe("button");
      if (name === "Lock vault") return lock;
      expect(name).toBe("Unlock");
      expect(exact).toBe(true);
      return { click: submit };
    },
    getByLabel(label, options) {
      expect(label).toBe("PIN");
      expect(options).toEqual({ exact: true });
      return field;
    },
    locator(selector) {
      expect(selector).toBe(".unlock");
      return gate;
    },
  };
  return { page, field, lock, gate, submit, gateStarted, finished };
}

afterEach(() => vi.restoreAllMocks());

describe("open means the actual ceremony completed", () => {
  it("does not return for an early visible Lock key until the gate detaches", async () => {
    const f = fixture();
    let settled = false;
    const ready = waitOpen(f.page).then(() => {
      settled = true;
    });
    await Promise.race([f.gateStarted.promise, ready]);
    expect(f.lock.waitFor).toHaveBeenCalledWith({ timeout: 20000 });
    expect(f.gate.waitFor).toHaveBeenCalledWith({
      state: "detached",
      timeout: expect.any(Number),
    });
    expect(settled).toBe(false);
    f.finished.resolve();
    await ready;
    expect(settled).toBe(true);
  });

  it("propagates a stuck gate's timeout instead of reporting an open vault", async () => {
    const f = fixture();
    const refused = expect(waitOpen(f.page)).rejects.toThrow(
      "gate still mounted",
    );
    await f.gateStarted.promise;
    f.finished.reject(new Error("gate still mounted"));
    await refused;
  });

  it("retains the existing gate bound within the original overall open deadline", async () => {
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(17000);
    const f = fixture({ detached: true });
    await waitOpen(f.page);
    expect(f.gate.waitFor).toHaveBeenCalledWith({
      state: "detached",
      timeout: 3000,
    });
  });

  it("caps an immediately open shell's gate wait at the existing 10s", async () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const f = fixture({ detached: true });
    await waitOpen(f.page);
    expect(f.gate.waitFor).toHaveBeenCalledWith({
      state: "detached",
      timeout: 10000,
    });
  });

  it("does not reach gate readiness when the shell itself fails to open", async () => {
    const f = fixture();
    f.lock.waitFor.mockRejectedValue(new Error("shell did not open"));
    await expect(waitOpen(f.page)).rejects.toThrow("shell did not open");
    expect(f.gate.waitFor).not.toHaveBeenCalled();
  });
});

describe("PIN and reload completion", () => {
  it("keeps a real PIN button submission pending until its gate detaches", async () => {
    const f = fixture({ open: false });
    const ready = unlockWithPin(f.page);
    await f.gateStarted.promise;
    expect(f.field.fill).toHaveBeenCalledExactlyOnceWith(PIN);
    expect(f.submit).toHaveBeenCalledTimes(1);
    expect(f.field.press).not.toHaveBeenCalled();
    f.finished.resolve();
    await ready;
  });

  it("reuses readiness after exactly one locked tutorial PIN/Enter submission", async () => {
    const f = fixture({ open: false });
    let settled = false;
    const ready = unlockIfLocked(f.page).then((result) => {
      settled = true;
      return result;
    });
    await f.gateStarted.promise;
    expect(f.field.fill).toHaveBeenCalledExactlyOnceWith(PIN);
    expect(f.field.press).toHaveBeenCalledExactlyOnceWith("Enter");
    expect(settled).toBe(false);
    f.finished.resolve();
    await expect(ready).resolves.toBe(true);
  });

  it("does not resubmit the still-visible PIN during an already-open ceremony", async () => {
    const f = fixture();
    let settled = false;
    const ready = unlockIfLocked(f.page).then((result) => {
      settled = true;
      return result;
    });
    await Promise.race([f.gateStarted.promise, ready]);
    expect(f.field.fill).not.toHaveBeenCalled();
    expect(f.field.press).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    f.finished.resolve();
    await expect(ready).resolves.toBe(false);
  });

  it("fails closed when neither the PIN nor open shell arrives", async () => {
    const f = fixture({ open: false, pin: false });
    f.field.waitFor.mockRejectedValue(new Error("PIN absent"));
    f.lock.waitFor.mockRejectedValue(new Error("open shell absent"));
    await expect(unlockIfLocked(f.page)).rejects.toThrow("open shell absent");
    expect(f.field.fill).not.toHaveBeenCalled();
    expect(f.gate.waitFor).not.toHaveBeenCalled();
  });

  it("returns false for an open vault whose ceremony has already finished", async () => {
    const f = fixture({ pin: false, detached: true });
    await expect(unlockIfLocked(f.page)).resolves.toBe(false);
    expect(f.field.fill).not.toHaveBeenCalled();
    expect(f.gate.waitFor).toHaveBeenCalledTimes(1);
  });

  it("propagates an unfinished reload ceremony even when no PIN is visible", async () => {
    const f = fixture({ pin: false });
    const refused = expect(unlockIfLocked(f.page)).rejects.toThrow(
      "reload gate still mounted",
    );
    await f.gateStarted.promise;
    f.finished.reject(new Error("reload gate still mounted"));
    await refused;
    expect(f.field.fill).not.toHaveBeenCalled();
  });
});
