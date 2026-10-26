import assert from "node:assert/strict";
import { test } from "vitest";
import { admitAndAnswer } from "./live-join-addresses.mjs";

function consentPage(present, events) {
  const mark = { or: () => mark };
  const step = {
    or: () => ({
      first: () => ({
        waitFor: async () => {
          assert.deepEqual(events, ["owner-admitted"]);
        },
      }),
    }),
    count: async () => Number(present),
    getByRole: (role, { name }) => {
      assert.equal(role, "button");
      return { click: async () => events.push(name) };
    },
  };
  return {
    locator: (selector) => {
      assert.equal(selector, "#live-addresses");
      return step;
    },
    getByRole: () => mark,
  };
}

test.each([
  [true, "Allow the owner's addresses"],
  [false, "Join without them"],
])(
  "carrier admission preserves the joiner's address choice: %s",
  async (allow, choice) => {
    const events = [];
    const admit = {
      waitFor: async () => {},
      click: async () => events.push("owner-admitted"),
    };
    assert.equal(
      await admitAndAnswer(admit, consentPage(true, events), allow),
      true,
    );
    assert.deepEqual(events, ["owner-admitted", choice]);
  },
);

test("a relay reply with no named addresses needs no invented address consent", async () => {
  const events = [];
  const admit = {
    waitFor: async () => {},
    click: async () => events.push("owner-admitted"),
  };
  assert.equal(await admitAndAnswer(admit, consentPage(false, events)), false);
  assert.deepEqual(events, ["owner-admitted"]);
});
