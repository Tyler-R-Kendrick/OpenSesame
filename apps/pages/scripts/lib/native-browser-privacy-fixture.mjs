/** Documented read-only first-page cards; synthetic values are not live accounts. */
export const PRIVACY_PROBE_REPLY = {
  data: [
    {
      token: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
      state: "OPEN",
      type: "UNLOCKED",
    },
  ],
  page: 1,
  total_entries: 1,
  total_pages: 1,
};
export const PRIVACY_READ = {
  id: "provider.cards.read",
  label: "List cards",
  method: "GET",
  url: "https://sandbox.privacy.com/v1/cards?page=1&page_size=20",
  headers: {},
  absentHeaders: ["api-version", "lithic-version", "privacy-version"],
  reply: PRIVACY_PROBE_REPLY,
  result: {
    label: "Showing 1 cards from first page",
    items: [
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
        label: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1 — OPEN (UNLOCKED)",
      },
    ],
  },
  excludedText: [],
};
