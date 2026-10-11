/**
 * A key that asks once: the first press arms it, the second fires, and it
 * disarms itself after a few seconds. For a press that deletes values, where
 * a sheet of its own would be more than the act is worth.
 */

import { useEffect, useState } from "react";

const ARMED_MS = 4000;

export function useArmed(fire: () => void): readonly [boolean, () => void] {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), ARMED_MS);
    return () => clearTimeout(timer);
  }, [armed]);
  return [
    armed,
    () => {
      if (!armed) {
        setArmed(true);
        return;
      }
      setArmed(false);
      fire();
    },
  ];
}
