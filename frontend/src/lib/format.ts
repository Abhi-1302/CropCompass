import type { Probability } from "../api/types";
import i18n from "../i18n";

const DATE_LOCALE: Record<string, string> = { en: "en-GB", hi: "hi-IN", te: "te-IN" };

function locale(): string {
  return DATE_LOCALE[i18n.language] ?? i18n.language;
}

/** "06-16" -> "16 Jun" */
export function monthDay(value: string | null | undefined): string {
  if (!value) return "—";
  const [month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat(locale(), { day: "numeric", month: "short", timeZone: "UTC" }).format(
    Date.UTC(2001, month - 1, day),
  );
}

/** "2026-06-14" -> "14 Jun 2026" */
export function fullDate(value: string | null | undefined): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(locale(), { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${value}T00:00:00Z`),
  );
}

export function monthName(month: number): string {
  return new Intl.DateTimeFormat(locale(), { month: "short", timeZone: "UTC" }).format(Date.UTC(2001, month - 1, 1));
}

export function mm(value: number | null | undefined): string {
  return value == null ? "—" : `${Math.round(value).toLocaleString(locale())} mm`;
}

export function percent(fraction: number | null | undefined): string {
  return fraction == null ? "—" : `${Math.round(fraction * 100)}%`;
}

/** Natural frequencies are easier to read than percentages: 0.33 -> "3 in 10 years". */
export function inTenYears(prob: Probability | null | undefined): string {
  if (!prob || prob.p == null) return "—";
  if (prob.p === 0) return i18n.t("odds.never");
  if (prob.p === 1) return i18n.t("odds.every");
  const count = Math.round(prob.p * 10);
  if (count === 0) return i18n.t("odds.rarely");
  if (count === 10) return i18n.t("odds.almostEvery");
  return i18n.t("odds.inTen", { count });
}

export function ofYears(prob: Probability | null | undefined): string {
  return prob ? i18n.t("odds.ofYears", { k: prob.k, n: prob.n }) : "";
}

export function signed(value: number, digits = 1): string {
  const rounded = value.toFixed(digits);
  return value > 0 ? `+${rounded}` : rounded;
}

/** 123456 INR -> "₹1,23,456" (Indian digit grouping for rupees). */
export function money(value: number | null | undefined, currency = "INR", withSign = false, digits = 0): string {
  if (value == null) return "—";
  const text = new Intl.NumberFormat(currency === "INR" ? `${i18n.language === "en" ? "en" : i18n.language}-IN` : locale(), {
    style: "currency",
    currency,
    maximumFractionDigits: digits,
  }).format(Math.abs(value) < 0.5 / 10 ** digits ? 0 : value);
  return withSign && value > 0 ? `+${text}` : text;
}
