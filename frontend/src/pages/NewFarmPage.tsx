import type { FormEvent } from "react";
import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import { useCreateFarm } from "../api/hooks";
import type { GeoPolygon, Irrigation } from "../api/types";
import { Alert, Button, Card, cx, Field, Input, PageSpinner, Select } from "../components/ui";
import type { FlyTo, MapMode } from "../features/map/FieldMap";
import { fieldShape, type LatLon } from "../lib/geo";

const FieldMap = lazy(() => import("../features/map/FieldMap").then((module) => ({ default: module.FieldMap })));

const PRESETS = [
  { label: "Telangana, India", name: "Telangana pilot", lat: 17.0, lon: 78.125 },
  { label: "Machakos, Kenya", name: "Machakos plot", lat: -1.5, lon: 37.3 },
  { label: "Iowa, USA", name: "Iowa field", lat: 42.0, lon: -93.6 },
  { label: "Mato Grosso, Brazil", name: "Mato Grosso field", lat: -12.5, lon: -55.7 },
];

const IRRIGATION: Irrigation[] = ["rainfed", "protective", "full"];
const MODES: MapMode[] = ["pin", "boundary"];

function validPoint(lat: string, lon: string): { lat: number; lon: number } | null {
  const point = { lat: Number(lat), lon: Number(lon) };
  if (lat === "" || lon === "" || !(point.lat >= -90 && point.lat <= 90) || !(point.lon >= -180 && point.lon <= 180)) {
    return null;
  }
  return point;
}

function polygon(corners: LatLon[]): GeoPolygon {
  const ring = corners.map(([lat, lon]) => [lon, lat] as [number, number]);
  return { type: "Polygon", coordinates: [[...ring, ring[0]]] };
}

export function NewFarmPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const create = useCreateFarm();
  const [form, setForm] = useState({ name: "", lat: "", lon: "", area: "", irrigation: "rainfed" as Irrigation });
  const [mode, setMode] = useState<MapMode>("pin");
  const [corners, setCorners] = useState<LatLon[]>([]);
  const [flyTo, setFlyTo] = useState<FlyTo | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [manualArea, setManualArea] = useState(false);

  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => {
    if (key === "area") setManualArea(event.target.value !== "");
    setForm((current) => ({ ...current, [key]: event.target.value }));
  };
  const pin = validPoint(form.lat, form.lon);
  const shape = fieldShape(corners);

  function moveTo(lat: number, lon: number, zoom: number, name?: string) {
    setMode("pin");
    setCorners([]);
    setForm((current) => ({ ...current, area: manualArea ? current.area : "", name: current.name || name || "", lat: lat.toFixed(5), lon: lon.toFixed(5) }));
    setFlyTo({ lat, lon, zoom });
  }

  function drawCorners(next: LatLon[]) {
    setCorners(next);
    const drawn = fieldShape(next);
    if (drawn) {
      setForm((current) => ({
        ...current,
        lat: drawn.lat.toFixed(5),
        lon: drawn.lon.toFixed(5),
        area: manualArea ? current.area : drawn.areaHa.toFixed(2),
      }));
    } else {
      setForm((current) => ({ ...current, area: manualArea ? current.area : "", lat: "", lon: "" }));
    }
  }

  function locate() {
    setProblem(null);
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false);
        moveTo(position.coords.latitude, position.coords.longitude, 16);
      },
      () => {
        setLocating(false);
        setProblem(t("newFarm.locationError"));
      },
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const boundary = mode === "boundary" ? corners : [];
    if (mode === "boundary" && boundary.length < 3) {
      setProblem(t("newFarm.boundaryNeedsThree"));
      return;
    }
    if (!pin) {
      setProblem(t("newFarm.invalidCoords"));
      return;
    }
    setProblem(null);
    create.mutate(
      {
        name: form.name.trim(),
        lat: pin.lat,
        lon: pin.lon,
        area_ha: form.area ? Number(form.area) : null,
        boundary: boundary.length >= 3 ? polygon(boundary) : null,
        irrigation: form.irrigation,
      },
      { onSuccess: (farm) => navigate(`/farms/${farm.id}`) },
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <Link to="/" className="text-sm font-medium text-emerald-700 hover:text-emerald-800">
        ← {t("common.back")}
      </Link>
      <h1 className="mt-3 text-2xl font-semibold">{t("newFarm.title")}</h1>
      <p className="mt-1 text-sm text-stone-500">{t("newFarm.subtitle")}</p>

      <Card className="mt-6">
        <form className="space-y-5" onSubmit={submit}>
          <Field label={t("newFarm.name")}>
            {(id) => (
              <Input
                id={id}
                required
                maxLength={80}
                placeholder={t("newFarm.namePlaceholder")}
                value={form.name}
                onChange={set("name")}
              />
            )}
          </Field>

          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-medium text-stone-800">{t("newFarm.mapTitle")}</h2>
                <p className="text-xs text-stone-500">{t(mode === "pin" ? "newFarm.pinHint" : "newFarm.boundaryHint")}</p>
              </div>
              <div role="radiogroup" aria-label={t("newFarm.mapTitle")} className="inline-flex rounded-xl bg-stone-100 p-1">
                {MODES.map((key) => (
                  <button
                    key={key}
                    type="button"
                    role="radio"
                    aria-checked={mode === key}
                    onClick={() => { if (key !== mode) drawCorners([]); setMode(key); }}
                    className={cx(
                      "rounded-lg px-3 py-1.5 text-sm font-medium transition",
                      mode === key ? "bg-white text-stone-900 shadow-sm" : "text-stone-600 hover:text-stone-900",
                    )}
                  >
                    {t(key === "pin" ? "newFarm.modePin" : "newFarm.modeBoundary")}
                  </button>
                ))}
              </div>
            </div>
            <Suspense fallback={<PageSpinner />}>
              <FieldMap
                mode={mode}
                pin={pin}
                corners={corners}
                flyTo={flyTo}
                onPin={(lat, lon) => setForm((current) => ({ ...current, lat: lat.toFixed(5), lon: lon.toFixed(5) }))}
                onCorners={drawCorners}
                onSearch={(place) => (mode === "pin" ? moveTo(place.lat, place.lon, place.zoom) : setFlyTo(place))}
              />
            </Suspense>
            {mode === "boundary" && (
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span className="text-stone-700">
                  {shape
                    ? t("newFarm.drawnArea", { area: shape.areaHa.toFixed(2), count: corners.length })
                    : t("newFarm.cornersSoFar", { count: corners.length })}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={!corners.length}
                  onClick={() => drawCorners(corners.slice(0, -1))}
                >
                  {t("newFarm.undo")}
                </Button>
                <Button type="button" size="sm" variant="ghost" disabled={!corners.length} onClick={() => drawCorners([])}>
                  {t("newFarm.clear")}
                </Button>
              </div>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("newFarm.lat")} hint={t("newFarm.coordsHint")}>
              {(id) => (
                <Input
                  id={id}
                  required
                  inputMode="decimal"
                  placeholder="17.0000"
                  readOnly={mode === "boundary"}
                  value={form.lat}
                  onChange={set("lat")}
                  onBlur={() => pin && setFlyTo({ ...pin, zoom: 15 })}
                />
              )}
            </Field>
            <Field label={t("newFarm.lon")}>
              {(id) => (
                <Input
                  id={id}
                  required
                  inputMode="decimal"
                  placeholder="78.1250"
                  readOnly={mode === "boundary"}
                  value={form.lon}
                  onChange={set("lon")}
                  onBlur={() => pin && setFlyTo({ ...pin, zoom: 15 })}
                />
              )}
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="secondary" size="sm" busy={locating} onClick={locate}>
              {locating ? t("newFarm.locating") : t("newFarm.useLocation")}
            </Button>
            <span className="text-xs text-stone-500">{t("newFarm.presets")}:</span>
            {PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className="rounded-full bg-stone-100 px-3 py-1 text-xs font-medium text-stone-700 hover:bg-emerald-50 hover:text-emerald-800"
                onClick={() => moveTo(preset.lat, preset.lon, 12, preset.name)}
              >
                {preset.label}
              </button>
            ))}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("newFarm.area")} hint={mode === "boundary" ? t("newFarm.areaFromDrawing") : undefined}>
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min="0.01"
                  step="0.01"
                  inputMode="decimal"
                  value={form.area}
                  onChange={set("area")}
                />
              )}
            </Field>
            <Field label={t("newFarm.irrigation")}>
              {(id) => (
                <Select id={id} value={form.irrigation} onChange={set("irrigation")}>
                  {IRRIGATION.map((option) => (
                    <option key={option} value={option}>
                      {t(`farms.irrigation.${option}`)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>

          {(problem || create.error) && <Alert tone="error">{problem ?? create.error?.message}</Alert>}

          <div className="flex justify-end">
            <Button type="submit" busy={create.isPending}>
              {t("newFarm.submit")}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
