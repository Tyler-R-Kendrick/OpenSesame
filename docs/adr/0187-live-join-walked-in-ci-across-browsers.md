# ADR 0187 — The live join walk gates merges, across three browsers

- **Status:** Accepted
- **Date:** 2026-10-10
- **Builds on:** [ADR 0150](0150-live-sessions-browser-to-browser.md) (live
  sessions), [ADR 0176](0176-ci-runs-what-a-diff-can-reach.md) (CI runs what
  a diff can reach), [ADR 0186](0186-live-session-transport-port-and-catalog-greeting.md)
  (the transport port and the catalog greeting)

## Context

Joining somebody's vault browser to browser is what makes the product usable
between two people, and `verify:live-join` is the walk that proves it: direct
pairing, a tunnel, every code carrier, relay only through TURN over UDP, TCP
and TLS, TURN REST and NATS, each against real servers. It ran in no CI job.
Run again, it was red on `main`: since the 2026-10-06 change that made a
directory's `config.yaml` the page itself (ADR 0134), nothing led to
`settings/live/transport.json`, the only place a TURN server's REST secret is
written — the feature had no road and nobody noticed.

It also ran in one engine. Two people rarely hold the same browser, and the
walk, run with a Chromium owner and Firefox and WebKit joiners, found what
Chromium had hidden:

- zod asks whether it may `eval` the first time it parses an object; under
  the app's CSP that is a reported violation, and Firefox logs it as an error
  on every page that parses a schema;
- the title screen's wordmark resized the element its own ResizeObserver
  watched, inside the callback — a loop WebKit raises as a page error;
- WebKit, as Safari, refuses a plain socket to loopback from an https page;
- the MQTT client runs its keepalive in a worker started from a Blob URL it
  revokes on the next tick, and WebKit can lose that race: the worker fails
  to load and the page logs it.

## Decision

**`verify:live-join` is a merge gate** — the `live-join-e2e` job, "Live join
(&lt;owner&gt; owner)", folded into the required Bundle budgets check like the
other walks that are jobs of their own. It runs when a diff reaches it
(`scripts/lib/ci-gates.mjs`): its driver and the walks it imports, the live
session code and anything the rules cannot place, the shared controls, the
settings file viewer, the live profile's file, and the source of the servers
it runs (`scripts/test/live-turn`, the fixture scripts), which are outside the
Pages build.

**Every walk, every ordered pair of browsers.** The owner's browser is one of
three shards; each walks every joiner's: Chromium, Firefox and WebKit, the
builds the pinned Playwright installs, so a run is the same run on any
machine. The servers are pinned too: nats-server by checksum, ntfy and
live-turn built from source checked against go.sum, with the Go that
live-turn's go.mod names.

**What an engine cannot be told here is not walked with it, and says so**
(`apps/pages/scripts/lib/live-engines.mjs`, printed `NOT TAKEN`):

- TLS to a TURN server with a throwaway certificate. Chromium can be told to
  trust one public key; Firefox and WebKit verify a TURN server against their
  trust stores and nothing reaches WebRTC's TLS (`ignoreHTTPSErrors` does
  not). A real `turns:` server holds a publicly trusted certificate.
- The tunnel half that must not meet, for WebKit, which on Linux never hides
  its host address: its own candidate is the tunnel address.

**Played on one machine as two machines would be.** Each engine shows host
addresses in the clear (each ships hiding them behind mDNS names nothing on a
runner resolves); the tunnel is this machine's default-route address, an
interface every browser gathers on and hides, as a tailnet address is
(loopback is not: Firefox gathers no loopback candidate while hiding); a pair
that holds WebKit reaches its carriers through a TLS front, as production
does. The walk reads each copied code from the app's own clipboard write,
which still goes to the browser and must succeed, because only Chromium lets a
test read the clipboard back.

**The browser's own diagnostics are not the app's errors**, and only where
they are the expected outcome: Firefox's "ICE failed" console error passes in
the three walks that must not connect and fails the run anywhere else.

## Consequences

- A change to live sessions, a shared control or a server the walk runs waits
  on three shards of about a quarter of an hour.
- The features the walk found broken are fixed with it: the Routes heading
  opens its file, zod runs jitless under the CSP, the wordmark resizes on the
  next frame, and the MQTT carrier keeps its timers on the page.
- An edit of the transport profile from Routes reads and seals as one turn of
  the store's writes (`editLiveTransport`). Before, an edit queued by the Form
  could read the profile, then seal its result after the file viewer had saved,
  putting back what "Saved" had just written; a loaded run of the walk lost
  the TURN REST secret that way.
- A settings file takes no typing and no save until its stored text has
  arrived (the editor is busy and read-only until then). WebKit's fill in CI
  typed into the empty editor and the text that arrived next ran into it.
- A check reads what the browser itself selected (the transport's
  `selectedCandidatePairId`, or the pair Firefox marks `selected`) and waits
  for the stats to name it, rather than taking a nominated pair at one
  instant, which a loaded run can read before the controlled side has
  marked it.
- Firefox's and WebKit's descriptions join Chromium's as the SDP reader's test
  vectors (`__fixtures__/firefox-webkit-sdp.json`), so a reader change that
  would refuse them fails a unit test before any browser runs.
- The unlock screen's hero layout sets padding on an element its own
  ResizeObserver watches, the same loop as the wordmark's. The walk does not
  reach that screen, so it is left for the gate that does.
- Rejected: shards per walk rather than per owner (each would install three
  browsers and two builds to walk one road), and Chromium alone (the faults
  above are invisible in it).
