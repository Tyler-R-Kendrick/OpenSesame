import type { Account, Session, User, Verification } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { describe, expect, it } from "vitest";
import {
  type AccountSecretCodec,
  sealedAccountAdapter,
} from "../account-secret-adapter.js";

const codec: AccountSecretCodec = {
  lookup: (purpose, value) =>
    `lookup:${Buffer.from(JSON.stringify([purpose, value])).toString("base64url")}`,
  seal: (purpose, owner, value) =>
    `sealed:${Buffer.from(JSON.stringify([purpose, owner, value])).toString("base64url")}`,
  open(purpose, owner, value) {
    if (!value.startsWith("sealed:")) return value;
    const [storedPurpose, storedOwner, plaintext] = JSON.parse(
      Buffer.from(value.slice(7), "base64url").toString(),
    );
    if (storedPurpose !== purpose || storedOwner !== owner)
      throw new Error("wrong secret context");
    return plaintext;
  },
};

type AccountMemoryRows = {
  account: Account[];
  session: Session[];
  user: User[];
  verification: Verification[];
};

function fixture() {
  const rows: AccountMemoryRows = {
    account: [],
    user: [],
    session: [],
    verification: [],
  };
  const adapter = sealedAccountAdapter(memoryAdapter(rows), codec)({});
  return { rows, adapter };
}

const account = (userId: string, accountId: string) => ({
  userId,
  accountId,
  providerId: "upstream",
  accessToken: "access-plaintext",
  refreshToken: "refresh-plaintext",
  idToken: "id-plaintext",
  password: "password-hash",
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe("account secret persistence", () => {
  it("seals every account secret and reads selected fields transparently", async () => {
    const { rows, adapter } = fixture();
    const created = await adapter.create({
      model: "account",
      data: account("alice", "subject-a"),
    });
    expect(created.accessToken).toBe("access-plaintext");
    expect(JSON.stringify(rows.account)).not.toContain("access-plaintext");
    expect(JSON.stringify(rows.account)).not.toContain("refresh-plaintext");
    expect(JSON.stringify(rows.account)).not.toContain("id-plaintext");
    expect(JSON.stringify(rows.account)).not.toContain("password-hash");
    const found = await adapter.findOne({
      model: "account",
      where: [{ field: "userId", value: "alice" }],
      select: ["accessToken"],
    });
    expect(found).toEqual({ accessToken: "access-plaintext" });
  });

  it("updates secrets and applies bulk writes with each account owner", async () => {
    const { rows, adapter } = fixture();
    await adapter.create({
      model: "account",
      data: account("alice", "subject-a"),
    });
    await adapter.create({
      model: "account",
      data: account("bob", "subject-b"),
    });
    await adapter.update({
      model: "account",
      where: [{ field: "userId", value: "alice" }],
      update: { accessToken: "replacement" },
    });
    expect(JSON.stringify(rows.account)).not.toContain("replacement");
    expect(
      await adapter.updateMany({
        model: "account",
        where: [{ field: "providerId", value: "upstream" }],
        update: { refreshToken: "bulk-replacement" },
      }),
    ).toBe(2);
    const found = await adapter.findMany<{ refreshToken: string }>({
      model: "account",
    });
    expect(found.map((row) => row.refreshToken)).toEqual([
      "bulk-replacement",
      "bulk-replacement",
    ]);
  });

  it("keeps transaction adapters sealed", async () => {
    const { rows, adapter } = fixture();
    await adapter.transaction(async (transaction) => {
      await transaction.create({
        model: "account",
        data: account("alice", "subject-a"),
      });
      await transaction.update({
        model: "account",
        where: [{ field: "userId", value: "alice" }],
        update: { accessToken: "transaction-token" },
      });
      expect(
        await transaction.findOne({
          model: "account",
          where: [{ field: "userId", value: "alice" }],
          select: ["accessToken"],
        }),
      ).toEqual({ accessToken: "transaction-token" });
    });
    expect(JSON.stringify(rows.account)).not.toContain("transaction-token");
  });

  it("rejects transplanted ciphertext and account identity mutation", async () => {
    const { rows, adapter } = fixture();
    await adapter.create({
      model: "account",
      data: account("alice", "subject-a"),
    });
    await adapter.create({
      model: "account",
      data: account("bob", "subject-b"),
    });
    await expect(
      adapter.update({
        model: "account",
        where: [{ field: "userId", value: "alice" }],
        update: { userId: "bob" },
      }),
    ).rejects.toThrow("immutable");
    const first = rows.account?.[0];
    const second = rows.account?.[1];
    if (!first || !second) throw new Error("missing account fixtures");
    second.accessToken = first.accessToken;
    await expect(
      adapter.findOne({
        model: "account",
        where: [{ field: "userId", value: "bob" }],
      }),
    ).rejects.toThrow("wrong secret context");
  });
});
