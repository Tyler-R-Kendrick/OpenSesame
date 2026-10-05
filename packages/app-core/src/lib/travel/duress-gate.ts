/** Whether a duress incident holds this device, or it has been retired (ADR 0130). */
export async function duressActive(): Promise<boolean> {
  const { duressSessionFence } = await import("../duress/session/fence.js");
  const fence = duressSessionFence.readFence();
  return fence.activeIncidentIds.length > 0 || fence.retiredDevice;
}
