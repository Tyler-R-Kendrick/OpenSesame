import { Link } from "react-router";

const tools = [
  {
    to: "/authorize",
    title: "Authorize CLI",
    body: "Approve a device user code. Does not transfer ownership.",
  },
  {
    to: "/claim",
    title: "Claim ownership",
    body: "Present and complete an Identity claim token.",
  },
  {
    to: "/task",
    title: "Task ceiling",
    body: "Inspect a live task grant or the labeled synthetic demo.",
  },
  {
    to: "/queue",
    title: "Offline queue",
    body: "Flush ceremony intents staged while offline.",
  },
  {
    to: "/protocol",
    title: "Protocol / ratchet",
    body: "Bearer ≠ DPoP — trust ratchet honesty.",
  },
] as const;

export function ToolsPage() {
  return (
    <section className="vault-panel">
      <h1>Tools</h1>
      <p className="lede tight">
        Ceremonies and diagnostics sit beside the vault — not as a competing home.
      </p>
      <ul className="tool-list">
        {tools.map((t) => (
          <li key={t.to}>
            <Link className="tool-row" to={t.to}>
              <span className="tool-title">{t.title}</span>
              <span className="tool-body">{t.body}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
