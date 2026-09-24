import { defineAgent } from "eve";

export default defineAgent({
  model: "zai/glm-5.2",
  reasoning: "medium",
  // Blackbox is the GLM 5.2 eve promo provider (free through 2026-08-27).
  // Without this pin, Gateway routes to paid hosts (Alibaba/Baseten/…).
  modelOptions: {
    providerOptions: {
      gateway: {
        only: ["blackbox"],
        order: ["blackbox"],
      },
    },
  },
});
