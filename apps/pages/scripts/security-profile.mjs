import { writeFile } from "node:fs/promises";

export function securityProfile(env) {
  const profile = env.PAGES_DEPLOYMENT_PROFILE ?? "shared_origin_demo";
  const raw =
    env.PAGES_CANONICAL_ORIGIN ?? "https://tyler-r-kendrick.github.io";
  const url = new URL(raw);
  if (url.origin !== raw || url.username || url.password)
    throw new Error("Invalid PAGES_CANONICAL_ORIGIN");
  const local = isLoopback(url.hostname);
  const headerSecurity = env.PAGES_HEADER_SECURITY === "1";
  if (
    ![
      "shared_origin_demo",
      "loopback_development",
      "dedicated_origin",
    ].includes(profile)
  )
    throw new Error("Invalid PAGES_DEPLOYMENT_PROFILE");
  if (
    profile === "dedicated_origin" &&
    (local ||
      raw === "https://tyler-r-kendrick.github.io" ||
      url.protocol !== "https:" ||
      !headerSecurity)
  )
    throw new Error("Dedicated origin requires HTTPS and header security");
  if (profile === "loopback_development" && !local)
    throw new Error("Development profile requires loopback");
  return { version: 1, profile, canonicalOrigin: raw, headerSecurity };
}

function isLoopback(hostname) {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

if (
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], "file:").href
) {
  await writeFile(
    new URL("../public/security-profile.json", import.meta.url),
    `${JSON.stringify(securityProfile(process.env), null, 2)}\n`,
  );
}
