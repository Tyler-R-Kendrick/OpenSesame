import { deadmanReleaseOffered } from "@opensesame/app-core/lib/deadman/index.js";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useVault } from "../../lib/vault/hooks.js";

/**
 * The one road from a locked screen into a deadman release. Drawn only after
 * the signed record's deadline has passed; the release screen verifies the
 * record and asks for the release key before it opens anything.
 */
export function DeadmanSwitchRoad() {
  const { tomb, guest } = useVault();
  const [offered, setOffered] = useState(() => deadmanReleaseOffered(tomb));
  useEffect(() => {
    const update = () => setOffered(deadmanReleaseOffered(tomb));
    update();
    const timer = setInterval(update, 60_000);
    return () => clearInterval(timer);
  }, [tomb]);
  if (guest || !offered) return null;
  return (
    <Link className="unlock__switch" to="/deadman">
      Open deadman switch
    </Link>
  );
}
