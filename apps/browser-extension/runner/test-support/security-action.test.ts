// @vitest-environment jsdom
import { expect, it } from "vitest";
import { clickSecurityAction } from "./security-action";

it("awaits the genuine asynchronous action finally before permitting a successor", async () => {
  const button = document.createElement("button");
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let completed = false;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await pending;
    } finally {
      completed = true;
      button.disabled = false;
    }
  });
  let returned = false;
  const action = clickSecurityAction(button).then(() => {
    returned = true;
  });
  await Promise.resolve();
  expect(button.disabled).toBe(true);
  expect(completed).toBe(false);
  expect(returned).toBe(false);
  release();
  await action;
  expect(completed).toBe(true);
  expect(button.disabled).toBe(false);
  expect(returned).toBe(true);
});
