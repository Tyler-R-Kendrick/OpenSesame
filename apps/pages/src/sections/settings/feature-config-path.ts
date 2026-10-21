/** One feature, or one capability inside it, as its own Settings page. */
export function featureConfigPath(
  featureId: string,
  capabilityId?: string,
): string {
  const base = `/settings/features/${encodeURIComponent(featureId)}`;
  return capabilityId ? `${base}/${encodeURIComponent(capabilityId)}` : base;
}
