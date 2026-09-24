import { StringCodec as StringCodecImpl, connect as connectImpl } from "nats";

export const natsSeams = {
  connect: connectImpl,
  StringCodec: StringCodecImpl,
};
