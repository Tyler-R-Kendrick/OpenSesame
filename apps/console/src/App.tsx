import { NavLink, Route, Routes } from "react-router";
import { ClaimPage } from "./pages/ClaimPage.js";
import { DevicePage } from "./pages/DevicePage.js";
import { SignInPage } from "./pages/SignInPage.js";
import { TaskAccessPage } from "./pages/TaskAccessPage.js";

const issuer =
  import.meta.env.VITE_OPENSESAME_ISSUER ?? "http://127.0.0.1:8788";

export function App() {
  return (
    <div className="shell">
      <header>
        <p className="brand" role="banner">
          OpenSesame
        </p>
        <p className="lede">Identity console · issuer {issuer}</p>
      </header>
      <nav className="nav" aria-label="Console">
        <NavLink to="/" end>
          Sign in
        </NavLink>
        <NavLink to="/device">Authorize CLI</NavLink>
        <NavLink to="/claim">Claim ownership</NavLink>
        <NavLink to="/task-access">Task access</NavLink>
      </nav>
      <Routes>
        <Route path="/" element={<SignInPage />} />
        <Route path="/device" element={<DevicePage />} />
        <Route path="/claim" element={<ClaimPage />} />
        <Route path="/task-access" element={<TaskAccessPage />} />
      </Routes>
    </div>
  );
}
