import { openAuthenticationProjection } from "@opensesame/app-core/lib/secret-fs/authentication-projection.js";
import type { PhysicalAuthenticationSnapshot } from "@opensesame/app-core/lib/vault/physical-authentication-port.js";
import type { PhysicalVaultPublicationPort } from "@opensesame/app-core/lib/vault/physical-vault-publication-port.js";
import { snapshot, unavailable } from "./native-vault-data.js";

import type { NativeVaultContext } from "./native-vault-context.js";
import { releaseInventory } from "./native-vault-inventory.js";

export function publicationPort({ native, capture }: NativeVaultContext) {
  const publication: PhysicalVaultPublicationPort = {
    async capture(tomb, original) {
      const held = capture(original, tomb);
      async function current(expected: PhysicalAuthenticationSnapshot) {
        const value = await snapshot(held.process, tomb);
        if (JSON.stringify(value.snapshot) !== JSON.stringify(expected))
          unavailable();
        return value;
      }
      async function publishHeader(
        expected: PhysicalAuthenticationSnapshot,
        nextHeader: string,
        check?: () => void,
      ) {
        held.check();
        check?.();
        if (!native.custody().writer || !expected.header) unavailable();
        const before = await current(expected);
        if (before.marker !== null) unavailable();
        await releaseInventory(native.custody().credential);
        held.check();
        check?.();
        await held.process.request({
          kind: "publish_header",
          expected: Buffer.from(expected.header).toString("base64"),
          next: Buffer.from(nextHeader).toString("base64"),
        });
        held.check();
        check?.();
        return { ...expected, header: nextHeader };
      }

      return {
        check: held.check,
        close: held.close,
        async collectProjection(expected, vaultKey, check) {
          await current(expected);
          if (!expected.body) unavailable();
          await openAuthenticationProjection(tomb, expected.body, vaultKey);
          held.check();
          check?.();
          return expected;
        },
        async publishHeader(expected, nextHeader, check) {
          return await publishHeader(expected, nextHeader, check);
        },
        async publishProjection(expected, plan, check) {
          if (
            plan.tomb !== tomb ||
            plan.expectedBody !== expected.body ||
            !expected.header ||
            !expected.body
          )
            unavailable();
          const before = await current(expected);
          if (before.marker !== null || !native.custody().writer) unavailable();
          const { decodeAuthenticationProjection } = await import(
            "@opensesame/app-core/lib/secret-fs/authentication-projection.js"
          );
          const records: [string, string][] = [
            [
              "header.json",
              Buffer.from(expected.header).toString("base64"),
            ] satisfies [string, string],
            ...[...decodeAuthenticationProjection(tomb, expected.body)].map(
              ([path, value]): [string, string] => [
                path.slice(tomb.length + 1),
                Buffer.from(value).toString("base64"),
              ],
            ),
          ].sort((left, right) =>
            (left[0] ?? "") < (right[0] ?? "")
              ? -1
              : (left[0] ?? "") > (right[0] ?? "")
                ? 1
                : 0,
          );
          const writes = [...plan.documents, plan.manifest].map(
            (write): [string, string] => [write.path, write.nextB64],
          );
          await releaseInventory(native.custody().credential);
          held.check();
          check?.();
          await held.process.request({
            kind: "publish_projection",
            expected: records,
            writes,
          });
          held.check();
          check?.();
          return { ...expected, body: plan.nextBody };
        },
      };
    },
  };
  return publication;
}
