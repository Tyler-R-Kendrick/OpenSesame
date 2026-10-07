import type { BoundaryValue } from "@opensesame/os-domain";
import { FILL_MESSAGE, PAIR_MESSAGE } from "../fill/protocol";
import {
  type PairRequest,
  type PopupRequest,
  pairReply,
  statusReply,
  triggerReply,
} from "../fill/wire";
import type { PanelPorts } from "./panel";

export type PopupSecurity = {
  permit(): string | undefined;
  requireProduction(): Promise<void>;
};
export type PopupTransport = {
  sendMessage(message: PopupRequest | PairRequest): Promise<BoundaryValue>;
  request(origins: readonly string[]): Promise<boolean>;
};

/** The production popup's actual protocol and browser prompt, outside page content. */
export function popupOperation(
  security: PopupSecurity,
  transport: PopupTransport,
): PanelPorts {
  const permit = security.permit();
  const check = () => {
    if (security.permit() !== permit)
      throw new Error("The popup owner changed.");
  };
  const authorize = async () => {
    check();
    await security.requireProduction();
    check();
  };
  const ask = async (message: PopupRequest | PairRequest) => {
    try {
      await authorize();
      check();
      const reply = await transport.sendMessage({
        ...message,
        securityPermit: permit,
      });
      check();
      await authorize();
      check();
      return reply;
    } catch {
      return null;
    }
  };
  return {
    check,
    status: async () =>
      statusReply.parse(await ask({ type: FILL_MESSAGE, op: "status" })),
    trigger: async (reference) =>
      triggerReply.parse(
        await ask({ type: FILL_MESSAGE, op: "trigger", reference }),
      ),
    enable: async (origin) =>
      statusReply.parse(
        await ask({ type: FILL_MESSAGE, op: "enable", origin }),
      ),
    disable: async () =>
      statusReply.parse(await ask({ type: FILL_MESSAGE, op: "disable" })),
    pair: async () => pairReply.parse(await ask({ type: PAIR_MESSAGE })),
    request: async (origins) => {
      try {
        await authorize();
        check();
        const granted = await transport.request(origins);
        check();
        await authorize();
        check();
        return granted;
      } catch {
        return false;
      }
    },
  };
}
