import {
  NOTIFICATION_CHANNEL_KINDS,
  type NotificationChannelKind,
} from "@opensesame/os-domain";
export function parseChannelKinds(
  raw: string | undefined,
  fallback: NotificationChannelKind[],
): NotificationChannelKind[] {
  if (raw === undefined || raw.trim() === "") return [...fallback];
  const wanted = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return NOTIFICATION_CHANNEL_KINDS.filter((kind) => wanted.includes(kind));
}
