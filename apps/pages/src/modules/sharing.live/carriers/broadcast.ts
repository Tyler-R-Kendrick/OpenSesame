/**
 * This browser's own tabs as a carrier: an owner and a joiner on one device
 * (two profiles side by side, a kiosk, a test) pair with nothing leaving it.
 */

import type { Carrier } from "@opensesame/app-core/lib/live/rendezvous.js";
import { isString } from "@opensesame/os-domain";

export function broadcastCarrier(topic: string): Carrier {
  const channel = new BroadcastChannel(`osm-live-${topic}`);
  const stops = new Set<() => void>();
  return {
    async post(text) {
      channel.postMessage(text);
    },
    listen(onText) {
      const handler = (event: MessageEvent) => {
        if (isString(event.data)) onText(event.data);
      };
      channel.addEventListener("message", handler);
      const stop = () => channel.removeEventListener("message", handler);
      stops.add(stop);
      return stop;
    },
    close() {
      for (const stop of stops) stop();
      channel.close();
    },
  };
}
