import type { useTranslation } from "react-i18next";
import type { Catalog, RuleEffect } from "../../api/types";
import i18n from "../../i18n";
import { fullDate } from "../../lib/format";

export type T = ReturnType<typeof useTranslation>["t"];

type CatalogKind = "crop" | "family" | "group" | "problem" | "residue" | "hostGroup" | "product";

/** Crop-pack names are English; Hindi and Telugu ones live under `catalog` in those locale files. */
export function catalogLabel(kind: CatalogKind, id: string | null | undefined, english?: string): string {
  if (!id) return english ?? "";
  const key = `catalog.${kind}.${id}`;
  return i18n.exists(key) ? (i18n.t as (key: string) => string)(key) : (english ?? id);
}

export function yieldText(t: T, kg: number | null | undefined): string {
  if (kg == null) return "—";
  return kg >= 10_000
    ? t("crops.tonnes", { value: (kg / 1000).toFixed(1) })
    : t("crops.kg", { value: Math.round(kg).toLocaleString() });
}

export function cropName(catalog: Catalog | undefined, id: string | null | undefined): string {
  return catalogLabel("crop", id, catalog?.crops.find((crop) => crop.id === id)?.name);
}

export function familyName(catalog: Catalog | undefined, id: string | null | undefined): string {
  return catalogLabel("family", id, id ? catalog?.families[id]?.name : undefined);
}

export function problemName(catalog: Catalog | undefined, id: string): string {
  return catalogLabel("problem", id, catalog?.problems[id]?.name);
}

export function ruleText(t: T, rule: RuleEffect, catalog?: Catalog): string {
  const facts = rule.facts;
  const crop = cropName(catalog, facts.crop);
  const pct = Math.round((1 - rule.factor) * 100);
  switch (rule.rule) {
    case "same_crop":
      if (rule.kind === "block") {
        const problems = (facts.problems ?? []).map((p) => problemName(catalog, p)).join(", ");
        return t("crops.rule.sameCropBlocked", { problems });
      }
      return t("crops.rule.sameCrop", { pct });
    case "same_family":
      return t("crops.rule.sameFamily", { crop, pct, family: familyName(catalog, facts.family) });
    case "shared_pest": {
      const group = catalogLabel("hostGroup", facts.group, catalog?.host_groups[facts.group ?? ""]);
      return facts.reported ? t("crops.rule.sharedPestReported", { crop, group }) : t("crops.rule.sharedPest", { crop, group });
    }
    case "legume_credit":
      return t("crops.rule.legumeCredit", { crop, kg: facts.kg });
    case "n_lockup":
      return t("crops.rule.nLockup", { crop, kg: facts.kg });
    case "residue_toxic":
      return t("crops.rule.residueToxic", { crop, days: facts.wait_days });
    case "herbicide":
      return rule.kind === "block"
        ? t("crops.rule.herbicideBlocked", { herbicide: facts.herbicide })
        : t("crops.rule.herbicide", { herbicide: facts.herbicide });
    case "calendar":
      return t("crops.rule.calendar", { crop, ready: fullDate(facts.ready), windowEnd: fullDate(facts.window_end) });
    case "window_passed":
      return t("crops.rule.windowPassed", { date: fullDate(facts.window_end) });
  }
}

export const RULE_DOT: Record<RuleEffect["kind"], string> = {
  block: "bg-red-500",
  penalty: "bg-amber-500",
  risk: "bg-amber-300",
  benefit: "bg-emerald-500",
  warning: "bg-sky-500",
};
