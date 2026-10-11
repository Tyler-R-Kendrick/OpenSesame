import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IMPORT_ACCEPT,
  discardPendingImport,
  holdPendingImport,
  peekPendingImport,
  subscribePendingImport,
  takePendingImport,
} from "./pending-import.js";

const env = new File(["API_KEY=sk-123\n"], "app.env");
const backup = new File(["{}"], "opensesame-offline-backup.json");

afterEach(() => discardPendingImport());

describe("the file held for the vault about to be sealed", () => {
  it("holds nothing until a file is chosen", () => {
    expect(peekPendingImport()).toBeNull();
    expect(takePendingImport()).toBeNull();
  });

  it("is looked at without being spent", () => {
    holdPendingImport(env);
    expect(peekPendingImport()).toBe(env);
    expect(peekPendingImport()).toBe(env);
  });

  it("is handed over once", () => {
    holdPendingImport(env);
    expect(takePendingImport()).toBe(env);
    expect(takePendingImport()).toBeNull();
    expect(peekPendingImport()).toBeNull();
  });

  it("holds the latest file chosen, not the first", () => {
    holdPendingImport(env);
    holdPendingImport(backup);
    expect(takePendingImport()).toBe(backup);
  });

  it("is let go when the person changes their mind", () => {
    holdPendingImport(env);
    discardPendingImport();
    expect(peekPendingImport()).toBeNull();
  });

  it("tells a listener when a file is held or let go, and not when nothing changed", () => {
    const heard = vi.fn();
    const stop = subscribePendingImport(heard);
    discardPendingImport();
    expect(heard).not.toHaveBeenCalled();
    holdPendingImport(env);
    expect(heard).toHaveBeenCalledTimes(1);
    takePendingImport();
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
    holdPendingImport(env);
    expect(heard).toHaveBeenCalledTimes(2);
  });
});

describe("what the picker offers", () => {
  it("names a dotenv file and an OpenSesame backup", () => {
    expect(IMPORT_ACCEPT).toContain(".env");
    expect(IMPORT_ACCEPT).toContain(".json");
  });
});
