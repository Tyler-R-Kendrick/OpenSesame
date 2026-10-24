import type { BoundaryValue } from "@opensesame/os-domain";
import { expect, it } from "vitest";
import {
  nativeMessagingInventories,
  projectLinqMessagingLines,
  projectMessagebirdMessages,
  projectTelegramCommands,
} from "./native-api-messaging-inventories.js";
import {
  invokeNativeApiResource,
  nativeApiResourceActions,
} from "./native-api-resources.js";
import { nativeAnswers } from "./native-api.test-support.js";

const message = { id: "message-owned", direction: "mt" };
const messages = {
  offset: 0,
  limit: 20,
  count: 1,
  totalCount: 21,
  items: [message],
};
const command = { command: "help", description: "Help & reference" };
const commands = { ok: true, result: [command] };
const cases = [
  {
    id: "messagebird",
    parse: projectMessagebirdMessages,
    body: messages,
    empty: { offset: 0, limit: 20, count: 0, totalCount: 0, items: [] },
  },
  {
    id: "telegram",
    parse: projectTelegramCommands,
    body: commands,
    empty: { ok: true, result: [] },
  },
];
it("registers precisely two real messaging reads and preserves all eleven queued/current prior inventories", () => {
  expect(nativeMessagingInventories.map((row) => row.providerId)).toEqual([
    "messagebird",
    "telegram",
  ]);
  for (const row of nativeMessagingInventories) {
    expect(nativeApiResourceActions(row.providerId, "api-key")).toEqual([
      { id: row.id, label: row.label },
    ]);
    expect(nativeApiResourceActions(row.providerId, "oauth")).toEqual([]);
  }
  for (const id of [
    "buildkite",
    "circleci",
    "digitalocean",
    "doppler",
    "neon",
    "pinecone",
    "n8n",
    "mailgun",
    "brevo",
    "sendgrid",
    "launchdarkly",
  ])
    expect(nativeApiResourceActions(id, "api-key")).toHaveLength(1);
});
it.each(cases)(
  "$id accepts genuine explicit empty inventory",
  ({ parse, empty }) => {
    expect(parse(empty).items).toEqual([]);
  },
);
it.each(cases)(
  "$id rejects missing collections and failed HTTP200 envelopes alongside valid data",
  ({ parse, body }) => {
    expect(() => parse({})).toThrow();
    for (const failure of [
      { error: "denied" },
      { error: { message: "denied" } },
      { errors: ["denied"] },
      { message: "denied" },
      { status: "error" },
      { code: 401 },
      { success: false },
      { ok: false },
    ])
      expect(() => parse({ ...body, ...failure })).toThrow();
  },
);
it("MessageBird preserves only ID and direction, not content, recipients, prices or returned links", () => {
  expect(
    projectMessagebirdMessages({
      ...messages,
      count: 2,
      items: [
        {
          ...message,
          body: "private-body",
          originator: "private-phone",
          recipients: { items: ["private-phone"] },
          price: { amount: 20 },
        },
        {
          id: "inbound-owned",
          direction: "mo",
          href: "https://discard.example",
          recipients: { status: "delivered" },
        },
      ],
      links: { next: "https://discard.example" },
    }),
  ).toEqual({
    label: "Showing 2 messages from first page",
    items: [
      { id: "message-owned", label: "Outbound SMS" },
      { id: "inbound-owned", label: "Inbound SMS" },
    ],
  });
});
it("MessageBird rejects inconsistent and unrequested pagination without following links", () => {
  for (const change of [
    { offset: 1 },
    { limit: 21 },
    { count: 0 },
    { count: 2 },
    { totalCount: 0 },
    { count: -1 },
    { totalCount: 1.5 },
    { totalCount: Number.POSITIVE_INFINITY },
    { totalCount: Number.MAX_SAFE_INTEGER + 1 },
  ])
    expect(() =>
      projectMessagebirdMessages({ ...messages, ...change }),
    ).toThrow();
  for (const field of ["offset", "limit", "count", "totalCount"]) {
    const missing = { ...messages };
    Reflect.deleteProperty(missing, field);
    expect(() => projectMessagebirdMessages(missing)).toThrow();
  }
});
it("MessageBird validates every row, unique ID, direction and exact twenty-row bound", () => {
  for (const row of [
    { id: "", direction: "mt" },
    { id: "bad\nID", direction: "mt" },
    { id: "x".repeat(257), direction: "mt" },
    { id: "owned", direction: "delivered" },
  ])
    expect(() =>
      projectMessagebirdMessages({ ...messages, items: [row] }),
    ).toThrow();
  expect(() =>
    projectMessagebirdMessages({
      ...messages,
      count: 2,
      items: [message, message],
    }),
  ).toThrow();
  const rows = Array.from({ length: 21 }, (_, index) => ({
    id: `message-${index}`,
    direction: "mt",
  }));
  expect(() =>
    projectMessagebirdMessages({ ...messages, count: 20, items: rows }),
  ).toThrow();
  expect(
    projectMessagebirdMessages({
      ...messages,
      count: 20,
      items: rows.slice(0, 20),
    }).items,
  ).toHaveLength(20);
});
it("Telegram labels a complete returned default command set honestly while rendering only twenty", () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({
    command: `command_${index}`,
    description: `Description ${index}`,
    private: "discard",
  }));
  const result = projectTelegramCommands({ ok: true, result: rows });
  expect(result.label).toBe("Showing 20 of 100 returned default bot commands");
  expect(result.items).toHaveLength(20);
  expect(result.items[19]).toEqual({
    id: "command_19",
    label: "/command_19 — Description 19",
  });
  expect(JSON.stringify(result)).not.toContain("discard");
  expect(() =>
    projectTelegramCommands({
      ok: true,
      result: [...rows, { command: "extra", description: "Over bound" }],
    }),
  ).toThrow();
  expect(() =>
    projectTelegramCommands({
      ok: true,
      result: [...rows.slice(0, 99), rows[0]],
    }),
  ).toThrow();
  expect(() =>
    projectTelegramCommands({
      ok: true,
      result: [
        ...rows.slice(0, 99),
        { command: "INVALID", description: "bad" },
      ],
    }),
  ).toThrow();
});
it("Telegram requires official command syntax and explicit successful array results", () => {
  for (const value of [
    "",
    "Uppercase",
    "/help",
    "bad space",
    "a".repeat(33),
    "雪",
  ])
    expect(() =>
      projectTelegramCommands({
        ok: true,
        result: [{ ...command, command: value }],
      }),
    ).toThrow();
  for (const body of [
    { ok: true, result: null },
    { ok: true, result: {} },
    { ok: false, result: [] },
    { result: [] },
    { ok: true, result: [command, command] },
  ])
    expect(() => projectTelegramCommands(body)).toThrow();
});
it("Telegram enforces description character limits without rejecting valid Unicode codepoints", () => {
  expect(
    projectTelegramCommands({
      ok: true,
      result: [{ command: "help", description: "雪".repeat(256) }],
    }).items,
  ).toHaveLength(1);
  expect(
    projectTelegramCommands({
      ok: true,
      result: [{ command: "help", description: "😀".repeat(256) }],
    }).items,
  ).toHaveLength(1);
  for (const description of [
    "",
    "bad\ntext",
    "x".repeat(257),
    "😀".repeat(257),
  ])
    expect(() =>
      projectTelegramCommands({
        ok: true,
        result: [{ command: "help", description }],
      }),
    ).toThrow();
});
it("refuses caller-selected auth, path, filter, language, scope and pagination before any I/O", async () => {
  const { transport, fetch } = nativeAnswers();
  for (const resource of nativeMessagingInventories) {
    for (const field of [
      "url",
      "path",
      "api_key",
      "recipient",
      "offset",
      "limit",
      "scope",
      "language_code",
      "method",
    ])
      await expect(
        resource.read("not-saved", { [field]: "override" }, transport),
      ).rejects.toThrow("does not accept");
    expect(
      invokeNativeApiResource("brevo", "not-saved", resource.id, {}, transport),
    ).toBeNull();
  }
  expect(fetch).not.toHaveBeenCalled();
});

function line(index = 0) {
  return {
    id: `550e8400-e29b-41d4-a716-${String(index).padStart(12, "0")}`,
    phone_number: "+12025551234",
    line_type: "iMessage",
    reputation: {
      status: "HEALTHY",
      doc_url:
        "https://docs.linqapp.com/channel/imessage/guides/phone-numbers/phone-reputation#healthy",
    },
    forwarding_number: "+12025559999",
    private_data: "private-linq-data",
  };
}
const reply = { phone_numbers: [line()] };
type InvalidReply = { name: string; body: BoundaryValue };
function invalidLine<T extends object>(name: string, changes: T) {
  return { name, body: { phone_numbers: [{ ...line(), ...changes }] } };
}
const invalidReplies: InvalidReply[] = [
  { name: "missing collection", body: {} },
  { name: "wrong collection", body: { phone_numbers: {} } },
  invalidLine("invalid UUID", { id: "foreign" }),
  invalidLine("invalid E.164", { phone_number: "12025551234" }),
  invalidLine("invalid line type", { line_type: "SMS" }),
  invalidLine("invalid reputation", {
    reputation: { status: "UNKNOWN", doc_url: "https://docs.linqapp.com" },
  }),
  invalidLine("missing reputation URL", { reputation: { status: "HEALTHY" } }),
  {
    name: "case-folded duplicate",
    body: {
      phone_numbers: [line(), { ...line(), id: line().id.toUpperCase() }],
    },
  },
  {
    name: "failed envelope",
    body: { ...reply, error: { message: "safe provider error" } },
  },
  {
    name: "invalid hidden row",
    body: {
      phone_numbers: [
        ...Array.from({ length: 20 }, (_, i) => line(i)),
        { ...line(21), phone_number: "invalid" },
      ],
    },
  },
];
it.each(invalidReplies)(
  "$name is rejected by the same parser used before Save and resource projection",
  ({ body }) => {
    expect(() => projectLinqMessagingLines(body)).toThrow();
  },
);
it("preserves empty inventory and validates every returned line before showing at most twenty", () => {
  expect(projectLinqMessagingLines({ phone_numbers: [] })).toEqual({
    label: "Showing 0 of 0 returned messaging lines",
    items: [],
  });
  expect(
    projectLinqMessagingLines({
      phone_numbers: Array.from({ length: 25 }, (_, i) => line(i)),
    }),
  ).toMatchObject({
    label: "Showing 20 of 25 returned messaging lines",
    items: expect.any(Array),
  });
  const noType = line();
  Reflect.deleteProperty(noType, "line_type");
  const projected = projectLinqMessagingLines({ phone_numbers: [noType] });
  expect(projected.items).toEqual([
    { id: line().id, label: "+12025551234 — HEALTHY" },
  ]);
});
