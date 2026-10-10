/**
 * One dismissable announcement for the latest claim or drop failure. The tray
 * keeps history; the bar shows at most one message and is replaced, not stacked.
 */

export type ClaimDropBanner = Readonly<{
  title: string;
  body: string;
}>;

type Listener = () => void;

let active: ClaimDropBanner | null = null;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeClaimDropBanner(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function claimDropBannerSnapshot(): ClaimDropBanner | null {
  return active;
}

export function showClaimDropBanner(banner: ClaimDropBanner): void {
  active = banner;
  emit();
}

export function dismissClaimDropBanner(): void {
  if (!active) return;
  active = null;
  emit();
}
