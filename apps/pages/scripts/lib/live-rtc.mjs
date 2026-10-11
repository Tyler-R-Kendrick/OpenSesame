/**
 * What verify:live-join reads of WebRTC in a page (ADR 0150): every peer
 * connection's configuration and, for a failure, what each data channel did
 * (`WATCH_RTC`); a tunnel played on one machine (`TUNNEL_ONLY`); and what each
 * connection selected once connected (`selectedPairs`). The same in every
 * engine: where one's stats leave a field out, it is read from the
 * description instead.
 */

/**
 * Every RTCPeerConnection's configuration, as the page made it, and — for a
 * failure — what each data channel did: its events, and the kind of every
 * frame it sent and received (the `t` of a protocol message, never its body,
 * so no value reaches the artifacts).
 */
export const WATCH_RTC = () => {
  const Native = window.RTCPeerConnection;
  window.__rtcConfigs = [];
  window.__rtcPeers = [];
  window.__rtcChannels = [];
  window.__rtcStates = [];
  const t0 = performance.now();
  const at = () => Math.round(performance.now() - t0);
  const kind = (data) => {
    try {
      return JSON.parse(data).t ?? "?";
    } catch {
      return String(data).slice(0, 16);
    }
  };
  const send = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function (data) {
    send.call(this, data);
    const record = window.__rtcChannels.find((r) => r.channel === this);
    record?.sent.push(`${kind(data)}@${at()}`);
  };
  const watch = (channel, side) => {
    const record = { side, channel, events: [], sent: [], heard: [] };
    window.__rtcChannels.push(record);
    record.events.push(`appeared:${channel.readyState}@${at()}`);
    for (const type of ["open", "closing", "close", "error"])
      channel.addEventListener(type, () =>
        record.events.push(`${type}@${at()}`),
      );
    channel.addEventListener("message", (event) =>
      record.heard.push(`${kind(event.data)}@${at()}`),
    );
  };
  // A subclass, not a wrapper function: it must stay a constructor.
  window.RTCPeerConnection = class extends Native {
    constructor(config) {
      super(config);
      window.__rtcConfigs.push(JSON.stringify(config ?? {}));
      window.__rtcPeers.push(this);
      this.addEventListener("datachannel", (event) =>
        watch(event.channel, "remote"),
      );
      this.addEventListener("connectionstatechange", () =>
        window.__rtcStates.push(`${this.connectionState}@${at()}`),
      );
    }
    createDataChannel(...args) {
      const channel = super.createDataChannel(...args);
      watch(channel, "local");
      return channel;
    }
  };
};

/**
 * A tunnel between two machines, played on one: the other side's mDNS names
 * do not resolve and nothing else routes, so the only remote candidate a
 * page keeps is one at `address` — where the other device is reachable
 * through the tunnel. Without an address hint, nothing is left to try.
 */
export const TUNNEL_ONLY = (address) => {
  const set = RTCPeerConnection.prototype.setRemoteDescription;
  RTCPeerConnection.prototype.setRemoteDescription = function (description) {
    if (!description?.sdp) return set.call(this, description);
    const sdp = description.sdp
      .split("\r\n")
      .filter(
        (line) =>
          !line.startsWith("a=candidate:") || line.split(" ")[4] === address,
      )
      .join("\r\n");
    return set.call(this, { type: description.type, sdp });
  };
};

/** Every peer connection's states, and the page's status marks: for a failure. */
export async function peerStates(page) {
  return page.evaluate(() => {
    // Firefox throws reading a closed connection's descriptions.
    const read = (get) => {
      try {
        return get();
      } catch (error) {
        return `(${error?.name ?? "error"})`;
      }
    };
    return {
      peers: (window.__rtcPeers ?? []).map((pc) => ({
        connection: read(() => pc.connectionState),
        ice: read(() => pc.iceConnectionState),
        gathering: read(() => pc.iceGatheringState),
        signaling: read(() => pc.signalingState),
        remote: String(read(() => pc.remoteDescription?.sdp ?? ""))
          .split("\r\n")
          .filter((line) => line.startsWith("a=candidate:")),
      })),
      marks: [...document.querySelectorAll("[role=img][aria-label]")].map(
        (node) => node.getAttribute("aria-label"),
      ),
      states: window.__rtcStates ?? [],
      channels: (window.__rtcChannels ?? []).map(({ channel, ...rest }) => ({
        ...rest,
        state: read(() => channel.readyState),
        buffered: read(() => channel.bufferedAmount),
      })),
    };
  });
}

/**
 * On a failure, send a probe frame on every open channel of every page, so
 * the record says whether the link still carries frames each way (a lost
 * first frame on a live link reads differently from a dead link).
 */
export async function probeChannels(pages) {
  for (const page of pages)
    await page
      .evaluate(() => {
        for (const record of window.__rtcChannels ?? []) {
          if (record.channel?.readyState !== "open") continue;
          try {
            record.channel.send(`probe:${record.side}`);
          } catch (error) {
            record.probeError = String(error);
          }
        }
      })
      .catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 3000));
}

/**
 * What each peer connection selected, once connected: local and remote type,
 * the remote candidate's address and — for a relayed local candidate — the
 * protocol the browser spoke to its TURN server (`udp`, `tcp` or `tls`).
 *
 * The pair is the one the browser itself names as selected: the transport's
 * `selectedCandidatePairId` (Chromium, WebKit), or the pair Firefox marks
 * `selected` (it reports no transport). A nominated, succeeded pair is not
 * the same thing — the controlled side may be sending on a pair before it
 * reads as nominated. Stats are read apart from the page's own events, so a
 * connection that is up may name its pair a moment later: this waits, up to
 * `timeout`, until every connected peer connection names one. WebKit's stats
 * name a candidate's port and foundation but not its address, so a remote
 * address the stats leave out is the remote description's candidate with
 * that foundation and port.
 */
export async function selectedPairs(page, { timeout = 10_000 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const { pairs, unnamed } = await readSelected(page);
    if (unnamed === 0 || Date.now() >= deadline) return pairs;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function readSelected(page) {
  return page.evaluate(async () => {
    const pairs = [];
    let unnamed = 0;
    for (const pc of window.__rtcPeers ?? []) {
      if (pc.connectionState !== "connected") continue;
      const stats = await pc.getStats();
      const reports = [...stats.values()];
      const named = new Set(
        reports
          .filter((r) => r.type === "transport" && r.selectedCandidatePairId)
          .map((r) => r.selectedCandidatePairId),
      );
      const chosen = reports.filter(
        (r) =>
          r.type === "candidate-pair" &&
          (named.has(r.id) || r.selected === true),
      );
      if (chosen.length === 0) unnamed += 1;
      const described = (pc.remoteDescription?.sdp ?? "")
        .split(/\r?\n/)
        .filter((line) => line.startsWith("a=candidate:"))
        .map((line) => line.slice("a=candidate:".length).split(" "));
      const addressOf = (candidate) =>
        candidate?.address ??
        candidate?.ip ??
        described.find(
          (fields) =>
            fields[0] === candidate?.foundation &&
            fields[5] === String(candidate?.port),
        )?.[4];
      for (const report of chosen) {
        const local = stats.get(report.localCandidateId);
        const remote = stats.get(report.remoteCandidateId);
        pairs.push({
          local: local?.candidateType,
          remote: remote?.candidateType,
          relayProtocol: local?.relayProtocol,
          address: addressOf(remote),
        });
      }
    }
    return { pairs, unnamed };
  });
}
