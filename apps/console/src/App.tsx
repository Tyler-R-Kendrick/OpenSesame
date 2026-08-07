import { Link, Route, Routes } from "react-router-dom";
import { SignInPage } from "./pages/SignInPage.js";
import { DevicePage } from "./pages/DevicePage.js";
import { ClaimPage } from "./pages/ClaimPage.js";

const issuer =
  import.meta.env.VITE_OPENSESAME_ISSUER ?? "http://127.0.0.1:8788";

export function App() {
  return (
    <div className="shell">
      <p className="brand">OpenSesame</p>
      <p className="lede">Identity console · issuer {issuer}</p>
      <nav className="nav">
        <Link to="/">Sign in</Link>
        <Link to="/device">Authorize CLI</Link>
        <Link to="/claim">Claim ownership</Link>
      </nav>
      <Routes>
        <Route path="/" element={<SignInPage />} />
        <Route path="/device" element={<DevicePage />} />
        <Route path="/claim" element={<ClaimPage />} />
      </Routes>
    </div>
  );
}
