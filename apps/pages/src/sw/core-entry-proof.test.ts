import { MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { installCoreWorker } from "./core.js";
import { FakeWorkerEnv } from "./test-env.js";
import { RELEASE_ID, RELEASE_MANIFEST } from "./test-fixtures.js";

const MODULE = "assets/main-AbCd1234.js";
const NONCE = "a".repeat(43);
const URL = `https://example.test/OpenSesame/${MODULE}`;
const hello = { type: "WORKER_HELLO", pageModuleUrl: URL, proofNonce: NONCE };

function fixture() {
  const env = new FakeWorkerEnv();
  const module = { url: MODULE, revision: null };
  const manifest = [...RELEASE_MANIFEST, module];
  installCoreWorker(env.sw, {
    variant: "core-only",
    manifest,
    caches: env.caches,
    fetch: env.fetch,
  });
  const client = env.clients.add({ id: "page", url: env.scope });
  return { env, client, manifest, module };
}

async function request(setup: ReturnType<typeof fixture>, data = hello) {
  const channel = new MessageChannel();
  try {
    const event = { data, source: setup.client, ports: [channel.port2] };
    await setup.env.dispatch("message", event);
    return receiveMessageOnPort(channel.port1)?.message;
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
}

describe("worker module handoff proof", () => {
  it("echoes only an exact manifest JS identity and nonce over the transferred port", async () => {
    const setup = fixture();
    expect(await request(setup)).toEqual({
      type: "WORKER_INFO",
      releaseId: RELEASE_ID,
      variant: "core-only",
      scopePath: "/OpenSesame/",
      pageModuleUrl: URL,
      proofNonce: NONCE,
    });
    expect(setup.client.messages).toEqual([]);
    expect(setup.env.fetched).toEqual([]);
  });

  it("keeps the original hello response when no proof port is supplied", async () => {
    const setup = fixture();
    await setup.env.message(setup.client, { type: "WORKER_HELLO" });
    expect(setup.client.messages).toEqual([
      {
        type: "WORKER_INFO",
        releaseId: RELEASE_ID,
        variant: "core-only",
        scopePath: "/OpenSesame/",
      },
    ]);
    expect(setup.env.fetched).toEqual([]);
  });

  it.each([
    "https://other.test/OpenSesame/assets/main-AbCd1234.js",
    "https://example.test/other/assets/main-AbCd1234.js",
    "https://example.test/OpenSesame-extra/assets/main-AbCd1234.js",
    "https://example.test/OpenSesame/assets/main-AbCd1234.js?next=1",
    "https://example.test/OpenSesame/assets/main-AbCd1234.js#fragment",
    "https://example.test/OpenSesame/assets/missing-AbCd1234.js",
    "https://example.test/OpenSesame/assets/unhashed.js",
    "https://example.test/OpenSesame/assets/main-AbCd1234.wasm",
    "https://example.test/OpenSesame/assets/main-AbCd1234.css",
    "https://example.test/OpenSesame/%61ssets/main-AbCd1234.js",
    "assets/main-AbCd1234.js",
    "javascript:alert(1)",
  ])("refuses proof for an unbound module URL: %s", async (pageModuleUrl) => {
    const setup = fixture();
    expect(await request(setup, { ...hello, pageModuleUrl })).toBeUndefined();
    expect(setup.client.messages).toEqual([]);
    expect(setup.env.fetched).toEqual([]);
  });

  it.each(["", "a".repeat(31), "a".repeat(129), "with spaces".repeat(4)])(
    "refuses a malformed nonce",
    async (proofNonce) => {
      const setup = fixture();
      expect(await request(setup, { ...hello, proofNonce })).toBeUndefined();
      expect(setup.env.fetched).toEqual([]);
    },
  );

  it("does not let later manifest mutation add proof authority", async () => {
    const setup = fixture();
    setup.manifest.push({ url: "assets/later-AbCd1234.js", revision: null });
    setup.module.url = "assets/replaced-AbCd1234.js";
    expect(await request(setup)).toMatchObject({ pageModuleUrl: URL });
    expect(
      await request(setup, {
        ...hello,
        pageModuleUrl:
          "https://example.test/OpenSesame/assets/later-AbCd1234.js",
      }),
    ).toBeUndefined();
    expect(setup.env.fetched).toEqual([]);
  });

  it.each([
    { url: "https://example.test/other/", controlled: true, type: "window" },
    {
      url: "https://example.test/OpenSesame/",
      controlled: false,
      type: "window",
    },
    {
      url: "https://example.test/OpenSesame/",
      controlled: true,
      type: "worker",
    },
  ])("requires an actually controlled window inside scope", async (client) => {
    const setup = fixture();
    setup.env.clients.remove(setup.client.id);
    setup.client = setup.env.clients.add({ id: "outside", ...client });
    expect(await request(setup)).toBeUndefined();
    expect(setup.client.messages).toEqual([]);
    expect(setup.env.fetched).toEqual([]);
  });

  it("refuses ambiguous multiple ports", async () => {
    const setup = fixture();
    const first = new MessageChannel();
    const second = new MessageChannel();
    try {
      const event = {
        data: hello,
        source: setup.client,
        ports: [first.port2, second.port2],
      };
      await setup.env.dispatch("message", event);
      expect(receiveMessageOnPort(first.port1)).toBeUndefined();
      expect(receiveMessageOnPort(second.port1)).toBeUndefined();
      expect(setup.client.messages).toEqual([]);
    } finally {
      first.port1.close();
      first.port2.close();
      second.port1.close();
      second.port2.close();
    }
  });
});
