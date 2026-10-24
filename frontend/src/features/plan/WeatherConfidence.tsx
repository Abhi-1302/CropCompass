import { Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { WeatherContext } from "../../api/types";
import { Badge } from "../../components/ui";
import { fullDate } from "../../lib/format";

export function WeatherConfidence({ context }: { context?: WeatherContext | null }) {
  const { t } = useTranslation();
  if (context?.mode !== "historical_proxy") return null;
  return (
    <div className="my-4 min-w-0 border-l-4 border-amber-500 bg-amber-50 px-4 py-3 text-sm text-amber-950">
      <Badge tone="amber">{t("plan.confidence.low")}</Badge>
      <p className="mt-2">{t("quality.proxySummary")}</p>
      <details className="mt-2">
        <summary className="w-fit max-w-full cursor-pointer list-none rounded p-1 focus-visible:outline-2 focus-visible:outline-amber-800 [&::-webkit-details-marker]:hidden" title={t("quality.confidenceInfo")} aria-label={t("quality.confidenceInfo")}>
          <Info className="size-5 shrink-0" aria-hidden="true" />
        </summary>
        <p className="mt-2 break-words leading-relaxed">{t("quality.proxyReason", { date: fullDate(context.checked_through), year: context.reference_year })}</p>
        {context.proxy_from && context.proxy_through && <p className="mt-2">{t("quality.proxyDates", { from: fullDate(context.proxy_from), through: fullDate(context.proxy_through) })}</p>}
      </details>
    </div>
  );
}