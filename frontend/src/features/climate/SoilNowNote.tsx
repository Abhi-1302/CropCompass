import { useTranslation } from "react-i18next";
import { useCatalog } from "../../api/hooks";
import type { SoilNow } from "../../api/types";
import { Button, cx } from "../../components/ui";
import { fullDate } from "../../lib/format";
import { cropName } from "../crops/text";

/** What the soil-water figure assumes about crops grown since the replay start (journal, usual crop, or bare). */
export function SoilNowNote({ soil, onOpenHistory }: { soil: SoilNow; onOpenHistory?: () => void }) {
  const { t } = useTranslation();
  const catalog = useCatalog().data;
  const assumed = soil.assumed[0];
  const guessed = Boolean(assumed) || (soil.replayed.length === 0 && !soil.recorded_fallow);
  const text = assumed
    ? t("soilNow.assumed", {
        season: t(`history.seasonName.${assumed.season}`),
        year: assumed.season_year,
        crop: cropName(catalog, assumed.crop),
      })
    : soil.recorded_fallow
      ? t("quality.fallow")
      : soil.replayed.length === 0
      ? t("soilNow.bare", { date: fullDate(soil.since) })
      : t("soilNow.journal");
  return (
    <div className={cx("rounded-xl px-3 py-2 text-xs leading-snug", guessed ? "bg-amber-50 text-amber-900" : "bg-stone-50 text-stone-600")}>
      <p>{text}</p>
      {guessed && onOpenHistory && (
        <Button size="sm" variant="secondary" className="mt-2" onClick={onOpenHistory}>
          {t("soilNow.log")}
        </Button>
      )}
    </div>
  );
}
