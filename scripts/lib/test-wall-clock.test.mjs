import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRootFromHere } from "./ci-affected-graph.mjs";
import {
  FIXED_NOW,
  FOREVER_DATE,
  outboxAppendCalls,
  readsBeforeTheAnswer,
  testSources,
} from "./test-wall-clock.mjs";

/**
 * A test that fixes its clock must not let the wall clock decide anything.
 *
 * `outbox.append` stamps `availableAt` with `new Date()` unless told otherwise.
 * A suite that drives the cleanup tick with a fixed `NOW` and appends events
 * without `availableAt` passes only while the wall clock is before `NOW`, and
 * goes red for everybody the moment it is not: that is how identity-worker's
 * Web Push suite went 8/8 red on main at 12:00 UTC on the day it was written,
 * after a green merge. The tick's clock is the one that says when an event is
 * due, so the event must be stamped with it.
 */

function workspaceTests() {
  const root = repoRootFromHere();
  const files = [];
  for (const base of ["packages", "apps"]) {
    for (const file of testSources(join(root, base))) {
      files.push({
        name: file.slice(root.length + 1),
        source: readFileSync(file, "utf8"),
      });
    }
  }
  return files;
}

describe("a test with a fixed clock stamps the events it appends", () => {
  it("recognises the call that was left to the wall clock", () => {
    const bad = `await repos.outbox.append({ id: "x", payload: { a: f(1) } });`;
    const good = `await repos.outbox.append({ id: "x", availableAt: NOW, payload: {} });`;
    expect(outboxAppendCalls(bad)[0]).not.toContain("availableAt");
    expect(outboxAppendCalls(good)[0]).toContain("availableAt");
  });

  it("holds across the workspace's tests", () => {
    const offenders = [];
    for (const { name, source } of workspaceTests()) {
      if (!FIXED_NOW.test(source)) continue;
      for (const call of outboxAppendCalls(source)) {
        if (!call.includes("availableAt")) {
          offenders.push(`${name}: ${call.slice(0, 60)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("a calendar date is never called 'never'", () => {
  it("recognises a date posing as forever, and not a clock-relative one", () => {
    expect(
      FOREVER_DATE.test(
        `const NEVER_EXPIRES = new Date("2030-01-01T00:00:00.000Z");`,
      ),
    ).toBe(true);
    expect(FOREVER_DATE.test(`const farFuture = "2099-01-01T00:00:00Z";`)).toBe(
      true,
    );
    expect(
      FOREVER_DATE.test("const NEVER_EXPIRES = new Date(Date.now() + TEN);"),
    ).toBe(false);
  });

  it("holds across the workspace's tests", () => {
    const offenders = workspaceTests()
      .filter(({ source }) => FOREVER_DATE.test(source))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });
});

describe("a test reads what a call produced only after it has been drawn", () => {
  it("recognises a screen read straight after waiting for a call", () => {
    const qr = `await waitFor(() => expect(store.begin).toHaveBeenCalled());\n    expect(sheet().getByTestId("qr")).toBeTruthy();`;
    const sent = `await waitFor(() =>\n      expect(store.begin).toHaveBeenCalledWith(\n        "email",\n      ),\n    );\n    expect(dialog.getByText("Code sent")).toBeTruthy();`;
    const handle = `await waitFor(() => expect(sync).toHaveBeenCalledOnce());\n    const stop = screen.getByRole("button");`;
    expect(readsBeforeTheAnswer(qr)).toHaveLength(1);
    expect(readsBeforeTheAnswer(sent)).toHaveLength(1);
    expect(readsBeforeTheAnswer(handle)).toHaveLength(1);
  });

  it("lets a read that waits, or a call checked against a call, stand", () => {
    const waits = `await waitFor(() => expect(a).toHaveBeenCalled());\n    expect(await dialog.findByText("x")).toBeTruthy();`;
    const mocks =
      "await waitFor(() => expect(a).toHaveBeenCalled());\n    expect(b).toHaveBeenCalled();";
    const settled = `await waitFor(() => expect(screen.getByText("x")).toBeTruthy());\n    expect(screen.getByText("y")).toBeTruthy();`;
    expect(readsBeforeTheAnswer(waits)).toEqual([]);
    expect(readsBeforeTheAnswer(mocks)).toEqual([]);
    expect(readsBeforeTheAnswer(settled)).toEqual([]);
  });

  it("holds across the workspace's tests", () => {
    const offenders = [];
    for (const { name, source } of workspaceTests()) {
      for (const found of readsBeforeTheAnswer(source)) {
        offenders.push(`${name}: ${found}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
