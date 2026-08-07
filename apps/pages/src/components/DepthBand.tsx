import { NavLink } from "react-router";

const depths = [
  { to: "/", label: "Surface", end: true },
  { to: "/vault", label: "Vault" },
  { to: "/authorize", label: "Ceremonies" },
  { to: "/task", label: "Task" },
  { to: "/protocol", label: "Ratchet" },
] as const;

export function DepthBand() {
  return (
    <div className="depth-band motion-band" role="navigation" aria-label="Authority depth">
      <p className="label">Next decision</p>
      <div className="depth-nav">
        {depths.map((d, i) => (
          <span key={d.to} style={{ display: "contents" }}>
            {i > 0 ? (
              <span className="sep" aria-hidden="true">
                →
              </span>
            ) : null}
            <NavLink to={d.to} end={"end" in d ? d.end : false}>
              {d.label}
            </NavLink>
          </span>
        ))}
        <span className="sep" aria-hidden="true">
          ·
        </span>
        <NavLink to="/settings">Settings</NavLink>
        <NavLink to="/queue">Queue</NavLink>
      </div>
    </div>
  );
}
