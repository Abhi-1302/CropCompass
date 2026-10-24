import type { FormEvent } from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSaveSeason } from "../../api/hooks";
import type { Catalog, SeasonInput, SeasonName, SeasonRecord } from "../../api/types";
import { Dialog } from "../../components/Dialog";
import { Alert, Button, cx, Field, Input, Select } from "../../components/ui";
import { catalogLabel, cropName, problemName } from "../crops/text";

export type SeasonDraft = {
  crops: string[];
  season: SeasonName | "";
  sow_date: string;
  harvest_date: string;
  status: "harvested" | "in_field";
  residue: string;
  irrigations: string;
  yield_kg_ha: string;
  problems: string[];
  herbicide: string;
  notes: string;
  source: "farmer" | "satellite";
};

export const EMPTY_DRAFT: SeasonDraft = {
  crops: [],
  season: "",
  sow_date: "",
  harvest_date: "",
  status: "harvested",
  residue: "",
  irrigations: "",
  yield_kg_ha: "",
  problems: [],
  herbicide: "",
  notes: "",
  source: "farmer",
};

export function draftFromRecord(record: SeasonRecord): SeasonDraft {
  return {
    crops: record.crops,
    season: record.season,
    sow_date: record.sow_date,
    harvest_date: record.harvest_date ?? "",
    status: record.status === "in_field" ? "in_field" : "harvested",
    residue: record.residue ?? "",
    irrigations: record.irrigations?.toString() ?? "",
    yield_kg_ha: record.yield_kg_ha?.toString() ?? "",
    problems: record.problems,
    herbicide: record.herbicide ?? "",
    notes: record.notes ?? "",
    source: record.source,
  };
}

function toInput(draft: SeasonDraft, isIndia: boolean): SeasonInput {
  const harvested = draft.status === "harvested";
  const number = (value: string) => (value.trim() === "" ? null : Number(value));
  return {
    crops: draft.crops,
    season: isIndia && draft.season ? draft.season : null,
    sow_date: draft.sow_date,
    harvest_date: draft.harvest_date || null,
    status: draft.status,
    residue: harvested && draft.residue ? draft.residue : null,
    irrigations: number(draft.irrigations),
    yield_kg_ha: harvested ? number(draft.yield_kg_ha) : null,
    problems: draft.problems,
    herbicide: draft.herbicide.trim() || null,
    notes: draft.notes.trim() || null,
    source: draft.source,
  };
}

type Props = {
  farmId: string;
  isIndia: boolean;
  catalog: Catalog;
  recordId?: string;
  initial: SeasonDraft;
  onClose: () => void;
};

export function SeasonForm({ farmId, isIndia, catalog, recordId, initial, onClose }: Props) {
  const { t } = useTranslation();
  const save = useSaveSeason(farmId);
  const [draft, setDraft] = useState<SeasonDraft>(initial);
  const set = <K extends keyof SeasonDraft>(key: K, value: SeasonDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const groups = Object.entries(catalog.groups).map(([group, label]) => ({
    label: catalogLabel("group", group, label),
    crops: catalog.crops.filter((crop) => crop.group === group),
  }));
  const cropOptions = (exclude?: string, mainOnly = false) =>
    groups.map((group) => (
      <optgroup key={group.label} label={group.label}>
        {group.crops
          .filter((crop) => crop.id !== exclude && (mainOnly || crop.id !== "fallow"))
          .map((crop) => (
            <option key={crop.id} value={crop.id}>
              {cropName(catalog, crop.id)}
            </option>
          ))}
      </optgroup>
    ));

  const harvested = draft.status === "harvested";

  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate({ id: recordId, body: toInput(draft, isIndia) }, { onSuccess: onClose });
  }

  return (
    <Dialog open title={t(recordId ? "history.formEditTitle" : "history.formAddTitle")} closeLabel={t("history.close")} onClose={onClose}>
      <form className="space-y-5" onSubmit={submit}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("history.mainCrop")}>
            {(id) => (
              <Select
                id={id}
                required
                value={draft.crops[0] ?? ""}
                onChange={(event) => set("crops", [event.target.value, ...draft.crops.slice(1).filter((c) => c !== event.target.value)])}
              >
                <option value="" disabled>
                  {t("history.chooseCrop")}
                </option>
                {cropOptions(undefined, true)}
              </Select>
            )}
          </Field>
          <Field label={t("history.intercrop")}>
            {(id) => (
              <Select
                id={id}
                value={draft.crops[1] ?? ""}
                disabled={!draft.crops[0]}
                onChange={(event) => set("crops", event.target.value ? [draft.crops[0], event.target.value] : [draft.crops[0]])}
              >
                <option value="">{t("history.none")}</option>
                {cropOptions(draft.crops[0])}
              </Select>
            )}
          </Field>
        </div>

        <fieldset>
          <legend className="mb-1.5 block text-sm font-medium text-stone-800">{t("history.status")}</legend>
          <div className="inline-flex rounded-xl bg-stone-100 p-1">
            {(["harvested", "in_field"] as const).map((status) => (
              <button
                key={status}
                type="button"
                aria-pressed={draft.status === status}
                onClick={() => set("status", status)}
                className={cx(
                  "rounded-lg px-4 py-1.5 text-sm font-medium transition",
                  draft.status === status ? "bg-white text-stone-900 shadow-sm" : "text-stone-600 hover:text-stone-900",
                )}
              >
                {t(status === "harvested" ? "history.harvested" : "history.inField")}
              </button>
            ))}
          </div>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={t(draft.crops.includes("fallow") ? "quality.fallowStart" : "history.sowDate")}>
            {(id) => (
              <Input id={id} type="date" required value={draft.sow_date} onChange={(event) => set("sow_date", event.target.value)} />
            )}
          </Field>
          <Field label={t(draft.crops.includes("fallow") ? "quality.fallowEnd" : harvested ? "history.harvestDate" : "history.expectedHarvest")}>
            {(id) => (
              <Input
                id={id}
                type="date"
                required={harvested}
                min={draft.sow_date || undefined}
                value={draft.harvest_date}
                onChange={(event) => set("harvest_date", event.target.value)}
              />
            )}
          </Field>
          {isIndia && (
            <Field label={t("history.season")}>
              {(id) => (
                <Select id={id} value={draft.season} onChange={(event) => set("season", event.target.value as SeasonName | "")}>
                  <option value="">{t("history.seasonAuto")}</option>
                  {(["kharif", "rabi", "summer", "other"] as const).map((season) => (
                    <option key={season} value={season}>
                      {t(`history.seasonLong.${season}`)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
        </div>

        {harvested && (
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t("history.residue")}>
              {(id) => (
                <Select id={id} value={draft.residue} onChange={(event) => set("residue", event.target.value)}>
                  <option value="">{t("history.residueUnknown")}</option>
                  {Object.entries(catalog.residue).map(([key, label]) => (
                    <option key={key} value={key}>
                      {catalogLabel("residue", key, label)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t("history.yieldLabel")}>
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min="0"
                  step="10"
                  inputMode="numeric"
                  value={draft.yield_kg_ha}
                  onChange={(event) => set("yield_kg_ha", event.target.value)}
                />
              )}
            </Field>
            <Field label={t("history.irrigationsLabel")}>
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min="0"
                  max="60"
                  inputMode="numeric"
                  value={draft.irrigations}
                  onChange={(event) => set("irrigations", event.target.value)}
                />
              )}
            </Field>
          </div>
        )}

        <fieldset>
          <legend className="mb-1.5 block text-sm font-medium text-stone-800">{t("history.problems")}</legend>
          <div className="flex flex-wrap gap-2">
            {Object.keys(catalog.problems).map((key) => {
              const active = draft.problems.includes(key);
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => set("problems", active ? draft.problems.filter((p) => p !== key) : [...draft.problems, key])}
                  className={cx(
                    "rounded-full px-3 py-1 text-xs font-medium ring-1 transition",
                    active ? "bg-amber-50 text-amber-900 ring-amber-300" : "bg-white text-stone-600 ring-stone-200 hover:bg-stone-50",
                  )}
                >
                  {problemName(catalog, key)}
                </button>
              );
            })}
          </div>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("history.herbicide")} hint={t("history.herbicideHint")}>
            {(id) => <Input id={id} maxLength={120} value={draft.herbicide} onChange={(event) => set("herbicide", event.target.value)} />}
          </Field>
          <Field label={t("history.notes")}>
            {(id) => (
              <textarea
                id={id}
                rows={3}
                maxLength={1000}
                value={draft.notes}
                onChange={(event) => set("notes", event.target.value)}
                className="block w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/20 focus:outline-none"
              />
            )}
          </Field>
        </div>

        {save.error && <Alert tone="error">{save.error.message}</Alert>}

        <div className="flex justify-end gap-2 border-t border-stone-100 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("history.cancel")}
          </Button>
          <Button type="submit" busy={save.isPending} disabled={!draft.crops[0]}>
            {t("history.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
