import { useEffect, useRef } from "react";
import { bootAmbientAuth } from "../lib/ambient-auth/boot.js";

/** Runs the ambient-auth boot once per mount of the app shell. */
export function useAmbientAuthBoot(
  hasAuthCallback: boolean,
  pathname: string,
): void {
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    bootAmbientAuth(hasAuthCallback, pathname);
  }, [hasAuthCallback, pathname]);
}
