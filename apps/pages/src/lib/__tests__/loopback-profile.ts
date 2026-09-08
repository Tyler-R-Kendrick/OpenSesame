import { mayPairLocalAuthority } from "../deployment-profile.js";

/** A local deployment fixture, not an authenticated grant or operator credential. */
export function loopbackProfileEligible(): boolean {
  return mayPairLocalAuthority("http://localhost:5180", {
    version: 1,
    profile: "loopback_development",
    canonicalOrigin: "http://localhost:5180",
    headerSecurity: false,
  });
}
