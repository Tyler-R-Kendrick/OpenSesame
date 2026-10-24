/** Documented non-PCI first-page cards; synthetic values are not live accounts. */
export const LITHIC_PROBE_REPLY = {
  data: [
    {
      token: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      state: "OPEN",
      type: "VIRTUAL",
    },
  ],
  has_more: false,
};
export const LITHIC_READ = {
  id: "provider.cards.read",
  label: "List cards",
  method: "GET",
  url: "https://sandbox.lithic.com/v1/cards?page_size=20",
  headers: { "api-version": "2026-07-01" },
  absentHeaders: ["lithic-version"],
  reply: LITHIC_PROBE_REPLY,
  result: {
    label: "Showing 1 cards from first page",
    items: [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
        label: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1 — OPEN (VIRTUAL)",
      },
    ],
  },
  excludedText: [],
};
