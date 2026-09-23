import {
  type RemoteSupportPayload,
  type SupportRequest,
  remoteSupportPayload,
} from "@opensesame/support-agent";

export type AgUiOutboundBody = RemoteSupportPayload;
/** Remote v2 is intentionally smaller than the on-device model context. */
export function buildAgUiOutboundBody(
  request: SupportRequest,
): AgUiOutboundBody {
  return remoteSupportPayload(request);
}
