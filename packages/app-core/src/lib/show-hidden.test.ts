import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createMemoryStorage } from "../memory-storage.js";
import { createTestHost } from "../test-host.js";
import {
  loadShowHidden,
  saveShowHidden,
  showHiddenSnapshot,
  subscribeShowHidden,
} from "./show-hidden.js";

beforeEach(() =>
  configureHost(createTestHost({ storage: { local: createMemoryStorage() } })),
);
afterEach(() => saveShowHidden(false));

it("is off until a person asks, then remembers and tells listeners", () => {
  expect(loadShowHidden()).toBe(false);
  const heard = vi.fn();
  const stop = subscribeShowHidden(heard);
  saveShowHidden(true);
  expect(loadShowHidden()).toBe(true);
  expect(showHiddenSnapshot()).toBe(true);
  expect(heard).toHaveBeenCalledTimes(1);
  stop();
  saveShowHidden(false);
  expect(heard).toHaveBeenCalledTimes(1);
  expect(showHiddenSnapshot()).toBe(false);
});
