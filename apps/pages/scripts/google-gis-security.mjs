/** GIS stays unavailable under enforced opener isolation or an unapproved external policy. */
export function googleGisSources(profile, approved, headerSecurity) {
  const disabled = { script: [], frame: [] };
  if (headerSecurity || !approved.includes("connectors.external"))
    return disabled;
  const network = profile?.instancePolicy?.network;
  if (network?.externalServices !== "allow") return disabled;
  const origins = network.allowedServiceOrigins ?? [];
  if (origins.length && !origins.includes("https://accounts.google.com"))
    return disabled;
  return {
    script: ["https://accounts.google.com/gsi/client"],
    frame: ["https://accounts.google.com"],
  };
}
