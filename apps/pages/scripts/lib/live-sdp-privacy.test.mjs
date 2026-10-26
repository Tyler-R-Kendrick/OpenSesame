import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import {
  assertSameMachineSdpPrivacy,
  gatheredHosts,
  hostFromCandidateLine,
  isPrivateLanHost,
  sameMachineSdpFault,
} from "./live-sdp-privacy.mjs";

const line = (host) =>
  `a=candidate:1 1 udp 2113937151 ${host} 41968 typ host generation 0`;
const peer = (remote, local = []) => ({
  remote: remote.map(line),
  local: local.map(line),
});

test("a candidate line names its host, with or without its prefix", () => {
  assert.equal(hostFromCandidateLine(line("10.1.0.142")), "10.1.0.142");
  assert.equal(
    hostFromCandidateLine("1 1 udp 2113937151 127.0.0.1 41968 typ host"),
    "127.0.0.1",
  );
  assert.equal(hostFromCandidateLine("a=candidate:1"), "");
});

test("private LAN literals are refused; loopback, mDNS and public hosts are not", () => {
  for (const host of ["10.0.0.1", "172.16.0.1", "172.31.255.1", "192.168.1.9"])
    assert.equal(isPrivateLanHost(host), true, host);
  for (const host of [
    "172.15.0.1",
    "172.32.0.1",
    "11.0.0.1",
    "127.0.0.1",
    "::1",
    "abcd-1234.local",
    "203.0.113.7",
    "",
  ])
    assert.equal(isPrivateLanHost(host), false, host);
});

test("loopback hints in the other side's description are what is wanted", () => {
  assert.equal(
    sameMachineSdpFault([peer(["127.0.0.1", "::1"])], "owner"),
    null,
  );
  assert.equal(sameMachineSdpFault([peer([], ["127.0.0.1"])], "owner"), null);
});

test("a private LAN address in the remote description is named", () => {
  assert.equal(
    sameMachineSdpFault([peer(["127.0.0.1", "10.1.0.142"])], "joiner"),
    "direct: joiner's remote description must not carry a private LAN IP (10.1.0.142)",
  );
});

test("a pair with no loopback hint in either description is a fault", () => {
  const fault =
    "direct: owner should seal loopback hints for same-machine pairing";
  assert.equal(sameMachineSdpFault([], "owner"), fault);
  assert.equal(sameMachineSdpFault([peer(["abcd.local"])], "owner"), fault);
});

test("a connection whose descriptions cannot be read is skipped, not a fault", () => {
  const closed = { remote: null, local: null };
  assert.equal(
    sameMachineSdpFault([closed, peer(["127.0.0.1"]), closed], "owner"),
    null,
  );
  assert.equal(
    sameMachineSdpFault([closed], "owner"),
    "direct: owner should seal loopback hints for same-machine pairing",
  );
});

test("an unreadable connection does not hide a LAN address in a readable one", () => {
  const closed = { remote: null, local: null };
  assert.match(
    sameMachineSdpFault([closed, peer(["192.168.1.9"])], "owner"),
    /192\.168\.1\.9/,
  );
});

test("a host the walk's own browsers gathered is excused; one they did not is not", () => {
  const remote = [peer(["10.1.0.142", "127.0.0.1", "::1"])];
  assert.equal(
    sameMachineSdpFault(remote, "owner", new Set(["10.1.0.142"])),
    null,
  );
  assert.equal(
    sameMachineSdpFault(remote, "owner", new Set(["10.9.9.9"])),
    "direct: owner's remote description must not carry a private LAN IP (10.1.0.142)",
  );
  // Hiding browsers gather none, so nothing is excused: the shipped default.
  assert.match(sameMachineSdpFault(remote, "owner"), /10\.1\.0\.142/);
});

test("excusing the browser's own address does not excuse another", () => {
  const own = new Set(["10.1.0.142"]);
  assert.match(
    sameMachineSdpFault(
      [peer(["10.1.0.142", "192.168.1.9", "127.0.0.1"])],
      "joiner",
      own,
    ),
    /192\.168\.1\.9/,
  );
});

test("consenting to an exact named route permits only that LAN host", () => {
  const named = new Set(["10.1.0.118"]);
  assert.equal(
    sameMachineSdpFault(
      [peer(["10.1.0.118", "127.0.0.1"])],
      "owner",
      new Set(),
      named,
    ),
    null,
  );
  assert.match(
    sameMachineSdpFault(
      [peer(["10.1.0.118", "10.1.0.119", "127.0.0.1"])],
      "owner",
      new Set(),
      named,
    ),
    /10\.1\.0\.119/,
  );
  assert.match(
    sameMachineSdpFault([peer(["10.1.0.118"])], "owner", new Set(), named),
    /should seal loopback/,
  );
});

// The in-page reader, run against a stand-in `window`: a closed connection
// answers its descriptions by throwing in Firefox.
const closedFirefox = {
  get remoteDescription() {
    throw new DOMException("Peer connection is closed", "InvalidStateError");
  },
  get localDescription() {
    throw new DOMException("Peer connection is closed", "InvalidStateError");
  },
};
const live = (remote, local) => ({
  remoteDescription: { sdp: remote.map(line).join("\r\n") },
  localDescription: { sdp: local.map(line).join("\r\n") },
});
const pageOf = (peers) => ({
  evaluate: async (read) => {
    globalThis.window = { __rtcPeers: peers };
    return read();
  },
});

afterEach(() => {
  globalThis.window = undefined;
});

test("a closed connection that throws on read is skipped, not an error", async () => {
  const page = pageOf([closedFirefox, live(["127.0.0.1"], ["10.1.0.142"])]);
  await assertSameMachineSdpPrivacy(page, "owner");
  assert.deepEqual([...(await gatheredHosts(page))], ["10.1.0.142"]);
});

test("a page's own gathered addresses excuse its description, and nothing else does", async () => {
  const page = pageOf([live(["10.1.0.142", "127.0.0.1"], ["10.1.0.142"])]);
  await assert.rejects(
    assertSameMachineSdpPrivacy(page, "owner"),
    /private LAN IP \(10\.1\.0\.142\)/,
  );
  await assertSameMachineSdpPrivacy(page, "owner", {
    own: await gatheredHosts(page),
  });
});
