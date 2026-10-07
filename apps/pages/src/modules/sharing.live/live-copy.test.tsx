/** @vitest-environment jsdom */
import { LiveHost } from "@opensesame/app-core/lib/live/host.js";
import { FakeNet } from "@opensesame/app-core/lib/live/live-fakes.js";
import { plan } from "@opensesame/app-core/lib/live/live-plan.fixture.js";
import { DIRECT_ONLY } from "@opensesame/app-core/lib/live/peer.js";
import {
  endHosting,
  joinLive,
  leaveLive,
  liveSeams,
} from "@opensesame/app-core/lib/live/session.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { RequestStep } from "./LiveJoinPairing.js";

const originalSeams = { ...liveSeams };
const originalClipboard = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard",
);
let hosted: LiveHost | null = null;

afterEach(() => {
  cleanup();
  leaveLive();
  endHosting();
  hosted?.end("owner");
  hosted = null;
  Object.assign(liveSeams, originalSeams);
  if (originalClipboard)
    Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

it("copies a genuine sealed request from an empty locked joining device", async () => {
  vaultStore.lock();
  expect(vaultStore.getSnapshot().status).not.toBe("unlocked");
  Object.assign(liveSeams, {
    plan: () => plan(true),
    onPlan: () => () => {},
  });
  const net = new FakeNet();
  hosted = await LiveHost.start({
    admission: "invite",
    ice: DIRECT_ONLY,
    expiresAt: Date.now() + 300_000,
    catalog: () => ({
      title: "Team",
      policy: "read",
      expiresAt: Date.now() + 300_000,
      items: [],
    }),
    readField: async () => null,
    peers: net.factory(),
  });
  const guest = await joinLive({
    link: hosted.link,
    code: hosted.code,
    name: "Ada Lovelace",
    note: "",
    useRoutes: false,
    peers: net.factory(),
  });
  const status = guest.status;
  expect(status.at).toBe("request");
  if (status.at !== "request") throw new Error("No genuine request generated.");
  expect(status.code).toMatch(/^osl-request\./);
  expect(await hosted.receive(status.code)).toMatchObject({ kind: "guest" });
  let clipboard = "";
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      readText: async () => clipboard,
      writeText: async (value: string) => {
        clipboard = value;
      },
    },
  });
  render(<RequestStep guest={guest} code={status.code} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Copy your request code" }),
  );
  await screen.findByRole("button", { name: "Copied your request code" });
  expect(clipboard).toBe(status.code);
  expect(vaultStore.getSnapshot().status).not.toBe("unlocked");
});
