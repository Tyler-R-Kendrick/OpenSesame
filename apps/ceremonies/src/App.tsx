import { Link, Route, Routes } from "react-router";
import { issuer } from "./lib/issuer.js";
import { AuthenticatorInvocation } from "./pages/AuthenticatorInvocation.js";
import { ClaimCeremony } from "./pages/ClaimCeremony.js";
import { DelegateClaim } from "./pages/DelegateClaim.js";
import { DeviceApprove } from "./pages/DeviceApprove.js";
import { GuestSession } from "./pages/GuestSession.js";
import { Inbox } from "./pages/Inbox.js";

/**
 * Hosted ceremony pages (ADR 0045): each route is a complete, shareable
 * artifact — no product-app chrome, one ceremony per page. The index exists
 * only so a bare visit explains itself; real traffic arrives deep-linked.
 */
function Home() {
  return (
    <section className="panel">
      <div className="badge">OpenSesame ceremonies</div>
      <h1>Shareable ceremony pages</h1>
      <p>
        These pages are handed out as links, like a payment form: each does one
        thing and ends. If you followed a link here without a fragment or code,
        ask the sender for a fresh one.
      </p>
      <ul className="index">
        <li>
          <Link to="/claim">Accept a claim</Link> — ownership or delegation
          shared with you (<code>#token=osc_clm_…</code>)
        </li>
        <li>
          <Link to="/guest">Start a guest session</Link> — a provisional
          identity, no account needed
        </li>
        <li>
          <Link to="/device">Approve a device</Link> — enter a user code from a
          CLI or device (<code>?user_code=…</code>)
        </li>
        <li>
          <Link to="/delegate">Accept delegated access</Link> — delegated
          connector auth (pending backend)
        </li>
        <li>
          <Link to="/inbox">Requests for you</Link> — approve or deny access
          somebody is asking for
        </li>
      </ul>
      <p className="fine">
        Agents: every page fronts a JSON API — see{" "}
        <a href={`${issuer}/auth.md`}>auth.md</a>.
      </p>
    </section>
  );
}

export function App() {
  return (
    <div className="shell">
      <header>
        <p className="brand" role="banner">
          OpenSesame
        </p>
      </header>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/claim" element={<ClaimCeremony />} />
        <Route path="/guest" element={<GuestSession />} />
        <Route path="/device" element={<DeviceApprove />} />
        <Route path="/delegate" element={<DelegateClaim />} />
        <Route path="/inbox" element={<Inbox />} />
        <Route path="/invoke/:kind" element={<AuthenticatorInvocation />} />
      </Routes>
    </div>
  );
}
