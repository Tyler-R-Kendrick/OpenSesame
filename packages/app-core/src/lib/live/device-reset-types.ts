import type { ManageGrants } from "../proofs/share-write.js";
import type { DeviceReply } from "./device-messages.js";
import type {
  DeviceResetRequest,
  DeviceResetStatus,
  ResetHumanStatus,
  ResetRequestDetails,
} from "./device-reset-messages.js";
import type { ApproveResult, SeatIdentity } from "./device-types.js";

export const RESET_GRANT_TTL_MS = 60 * 60_000;
export const RESET_ASK_TTL_MS = 10 * 60_000;

export type ResetItem = Readonly<{
  id: string;
  name: string;
  origins: readonly string[];
}>;

export type PendingReset = ResetRequestDetails &
  Readonly<{
    id: string;
    seat: string;
    name: string;
    itemName: string;
    askedAt: number;
    digest: string;
  }>;

export type ResetGrant = ResetRequestDetails &
  Readonly<{
    id: string;
    seat: string;
    name: string;
    itemName: string;
    grantedAt: number;
    digest: string;
    humanStatus: ResetHumanStatus | null;
  }>;

export type ResetDevicesState = Readonly<{
  pending: readonly PendingReset[];
  grants: readonly ResetGrant[];
}>;

export const NO_RESET_DEVICES: ResetDevicesState = { pending: [], grants: [] };

export type ResetSeatRequest = DeviceResetRequest | DeviceResetStatus;

export type ResetSeatDevices = Readonly<{
  handle(request: ResetSeatRequest): Promise<void>;
  close(): void;
}>;

export type ResetSeat = {
  readonly identity: SeatIdentity;
  readonly send: (reply: DeviceReply) => void;
  pending: ResetPendingRecord | null;
  grants: Map<string, ResetGrantRecord>;
};

export type ResetPendingRecord = ResetRequestDetails & {
  readonly id: string;
  readonly req: string;
  readonly digest: string;
  readonly seat: ResetSeat;
  readonly itemName: string;
  readonly askedAt: number;
  readonly askExpiresAt: number;
  outcome: "waiting" | "approved" | "denied";
  timer: ReturnType<typeof setTimeout> | null;
};

export type ResetGrantRecord = ResetRequestDetails & {
  readonly id: string;
  readonly req: string;
  readonly digest: string;
  readonly seat: ResetSeat;
  readonly itemName: string;
  readonly grantedAt: number;
  humanStatus: ResetHumanStatus | null;
  timer: ReturnType<typeof setTimeout> | null;
};

export type ResetApproval<Vault> = (
  id: string,
  authority: ManageGrants<Vault>,
) => ApproveResult;
