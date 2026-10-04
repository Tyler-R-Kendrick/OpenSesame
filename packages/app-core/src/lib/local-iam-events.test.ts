/**
 * The change fan-out the identity and access panels share, and the hint it
 * sends to other tabs of the origin (ADR 0162): content-free, and heard only
 * as "read your own sealed records again".
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_IAM_CHANNEL,
  notifyLocalIamChange,
  resetLocalIamChannelForTest,
  subscribeLocalIamChanges,
  subscribeLocalIamChangesFromOtherTabs,
} from "./local-iam-events.js";

const opened: BroadcastChannel[] = [];
function otherTab(): BroadcastChannel {
  const channel = new BroadcastChannel(LOCAL_IAM_CHANNEL);
  opened.push(channel);
  return channel;
}

afterEach(() => {
  for (const channel of opened.splice(0)) channel.close();
  resetLocalIamChannelForTest();
  vi.unstubAllGlobals();
});

describe("a change made in this tab", () => {
  it("reaches this tab's listeners and not the other-tab ones", async () => {
    const here = vi.fn();
    const there = vi.fn();
    const offHere = subscribeLocalIamChanges(here);
    const offThere = subscribeLocalIamChangesFromOtherTabs(there);
    notifyLocalIamChange();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(here).toHaveBeenCalledOnce();
    expect(there).not.toHaveBeenCalled();
    offHere();
    offThere();
  });

  it("tells another tab, with nothing in the message but that it changed", async () => {
    const heard: unknown[] = [];
    const tab = otherTab();
    tab.onmessage = (event) => heard.push(event.data);
    subscribeLocalIamChangesFromOtherTabs(() => undefined);
    notifyLocalIamChange();
    await vi.waitFor(() => expect(heard).toHaveLength(1));
    expect(heard[0]).toEqual({ type: "changed" });
  });
});

describe("a change made in another tab", () => {
  it("reaches the other-tab listeners and never this tab's own", async () => {
    const here = vi.fn();
    const there = vi.fn();
    subscribeLocalIamChanges(here);
    subscribeLocalIamChangesFromOtherTabs(there);
    otherTab().postMessage({ type: "changed" });
    await vi.waitFor(() => expect(there).toHaveBeenCalledOnce());
    expect(here).not.toHaveBeenCalled();
  });

  it("reads nothing a message carries: any payload is the same hint", async () => {
    const there = vi.fn();
    subscribeLocalIamChangesFromOtherTabs(there);
    const tab = otherTab();
    tab.postMessage({ type: "changed", scopes: ["admin"], token: "x" });
    tab.postMessage("garbage");
    await vi.waitFor(() => expect(there).toHaveBeenCalledTimes(2));
    // What the listener is handed is this module's own change event, never
    // the message: nothing of the payload can reach a panel.
    for (const [event] of there.mock.calls) {
      expect(event).toBeInstanceOf(Event);
      expect(event).not.toHaveProperty("data");
    }
  });

  it("is not heard again after the listener leaves", async () => {
    const there = vi.fn();
    subscribeLocalIamChangesFromOtherTabs(there)();
    otherTab().postMessage({ type: "changed" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(there).not.toHaveBeenCalled();
  });
});

describe("a host with no broadcast channel", () => {
  it("still tells this tab, and quietly tells no one else", async () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    resetLocalIamChannelForTest();
    const here = vi.fn();
    const off = subscribeLocalIamChanges(here);
    expect(() => notifyLocalIamChange()).not.toThrow();
    expect(here).toHaveBeenCalledOnce();
    off();
  });
});
