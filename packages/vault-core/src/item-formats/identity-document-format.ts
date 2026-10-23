/** ICAO 9303 TD1 identity-card MRZ: checks, a parser, and a synthetic generator. */
import { isString } from "@opensesame/os-domain";
import type { FieldValues } from "@opensesame/vault-item-types";
import type { Random } from "./random.js";
import type { ItemFormat } from "./types.js";

const WEIGHTS = [7, 3, 1] as const;
const COUNTRY = /^[A-Z]{3}$/u;
const LINE = /^[A-Z0-9<]+$/u;

function text(values: FieldValues, id: string): string {
  const value = values[id];
  return isString(value) ? value : "";
}

function checkDigit(input: string): string {
  let sum = 0;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? "<";
    const value =
      char === "<"
        ? 0
        : char >= "0" && char <= "9"
          ? Number(char)
          : char >= "A" && char <= "Z"
            ? char.charCodeAt(0) - 55
            : 0;
    sum += value * (WEIGHTS[index % 3] ?? 1);
  }
  return String(sum % 10);
}

function dateFromMrz(raw: string, birthday: boolean): string | null {
  if (!/^\d{6}$/u.test(raw)) return null;
  const yy = Number(raw.slice(0, 2));
  const year = birthday
    ? yy <= new Date().getUTCFullYear() % 100
      ? 2000 + yy
      : 1900 + yy
    : 2000 + yy;
  const month = raw.slice(2, 4);
  const day = raw.slice(4, 6);
  const date = new Date(Date.UTC(year, Number(month) - 1, Number(day)));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day)
  )
    return null;
  return `${year}-${month}-${day}`;
}

function mrzDate(iso: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(iso);
  return match ? `${match[1]?.slice(2)}${match[2]}${match[3]}` : null;
}

function mrzName(value: string): string {
  const parts = value
    .toUpperCase()
    .replaceAll(/[^A-Z ]/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (parts.length === 0) return "";
  const [surname, ...given] = parts;
  return `${surname}${given.length > 0 ? `<<${given.join("<")}` : "<<"}`;
}

function nameFromMrz(value: string): string {
  return value.replaceAll("<", " ").replaceAll(/\s+/gu, " ").trim();
}

function firstLine(values: FieldValues): string | null {
  const country = text(values, "issuingCountry").toUpperCase();
  if (!COUNTRY.test(country)) return null;
  const number = text(values, "documentNumber")
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]/gu, "");
  if (!number) return null;
  return `ID${country}${number.padEnd(9, "<").slice(0, 9)}${checkDigit(number.padEnd(9, "<").slice(0, 9))}${"<".repeat(15)}`;
}

function secondLine(values: FieldValues): string | null {
  const birth = mrzDate(text(values, "dateOfBirth"));
  const expiry = mrzDate(text(values, "expiresAt"));
  if (!birth || !expiry) return null;
  const optional = "<".repeat(11);
  const number = text(values, "documentNumber")
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]/gu, "")
    .padEnd(9, "<")
    .slice(0, 9);
  const composite = checkDigit(
    `${number}${checkDigit(number)}${birth}${checkDigit(birth)}${expiry}${checkDigit(expiry)}${optional}`,
  );
  return `${birth}${checkDigit(birth)}${text(values, "sex") === "M" || text(values, "sex") === "F" ? text(values, "sex") : "<"}${expiry}${checkDigit(expiry)}${text(values, "issuingCountry").toUpperCase()}${optional}${composite}`;
}

function canonical(values: FieldValues): string | null {
  const first = firstLine(values);
  const second = secondLine(values);
  if (!first || !second) return null;
  return `${first}\n${second}\n${mrzName(text(values, "fullName")).padEnd(30, "<").slice(0, 30)}`;
}

function mrzLines(value: string): [string, string, string] | null {
  const lines = value.trim().split(/\r?\n/u);
  if (lines.length !== 3) return null;
  const [first = "", second = "", third = ""] = lines;
  if (first.length !== 30 || second.length !== 30 || third.length !== 30)
    return null;
  if (!LINE.test(first) || !LINE.test(second) || !LINE.test(third)) return null;
  return [first, second, third];
}

function checksPass(second: string): boolean {
  return (
    checkDigit(second.slice(0, 6)) === second[6] &&
    checkDigit(second.slice(8, 14)) === second[14]
  );
}

function compositeOk(first: string, second: string): boolean {
  const composite = `${first.slice(5, 15)}${second.slice(0, 7)}${second.slice(8, 15)}${second.slice(18, 29)}`;
  return checkDigit(composite) === second[29];
}

function datesOf(second: string): {
  dateOfBirth: string;
  expiresAt: string;
} | null {
  const dateOfBirth = dateFromMrz(second.slice(0, 6), true);
  const expiresAt = dateFromMrz(second.slice(8, 14), false);
  return dateOfBirth && expiresAt ? { dateOfBirth, expiresAt } : null;
}

function parse(value: string): FieldValues | null {
  const lines = mrzLines(value);
  if (!lines) return null;
  const [first, second, third] = lines;
  if (first.slice(0, 1) !== "I") return null;
  const country = first.slice(2, 5);
  if (!COUNTRY.test(country)) return null;
  const number = first.slice(5, 14);
  if (checkDigit(number) !== first[14]) return null;
  if (!checksPass(second) || !compositeOk(first, second)) return null;
  const dates = datesOf(second);
  if (!dates) return null;
  return {
    documentKind: "identity card",
    documentNumber: number.replaceAll("<", ""),
    issuingCountry: country,
    fullName: nameFromMrz(third),
    dateOfBirth: dates.dateOfBirth,
    expiresAt: dates.expiresAt,
  };
}

function generate({ random, now }: { random: Random; now: Date }): FieldValues {
  const date = new Date(now.getTime());
  date.setUTCFullYear(date.getUTCFullYear() + 5);
  return {
    documentKind: "identity card",
    documentNumber: random.string("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 9),
    issuingCountry: "GBR",
    fullName: "SPECIMEN TEST",
    dateOfBirth: "1990-01-01",
    expiresAt: date.toISOString().slice(0, 10),
  };
}

export const identityDocumentFormat: ItemFormat = {
  id: "identity-document:mrz-td1",
  typeId: "identity-document",
  label: "Identity card MRZ",
  specificity: 99,
  parse,
  generate,
  canonical,
};
