import "leaflet/dist/leaflet.css";
import L from "leaflet";
import type { KeyboardEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input } from "../../components/ui";
import type { LatLon } from "../../lib/geo";

export type MapMode = "pin" | "boundary";
export type FlyTo = { lat: number; lon: number; zoom: number };

const MAX_CORNERS = 200;
const INDIA_VIEW: FlyTo = { lat: 20.5, lon: 78.9, zoom: 5 };
const TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const PIN_ICON = L.divIcon({
  className: "",
  html: '<div class="size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-emerald-600 shadow-md ring-4 ring-emerald-600/30"></div>',
  iconSize: [0, 0],
});
const CORNER_ICON = L.divIcon({
  className: "",
  html: '<div class="size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-emerald-700 bg-white shadow"></div>',
  iconSize: [0, 0],
});

type Place = { lat: string; lon: string; display_name: string; place_id: number };

/** Place search on OpenStreetMap's Nominatim; its usage policy allows searching on request, not as-you-type. */
function PlaceSearch({ onPick }: { onPick: (place: FlyTo) => void }) {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState("");
  const [places, setPlaces] = useState<Place[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function search() {
    const text = query.trim();
    if (!text) return;
    setBusy(true);
    setFailed(false);
    try {
      const params = new URLSearchParams({ q: text, format: "jsonv2", limit: "5", "accept-language": i18n.language });
      const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`);
      if (!response.ok) throw new Error(String(response.status));
      setPlaces((await response.json()) as Place[]);
    } catch {
      setFailed(true);
      setPlaces(null);
    } finally {
      setBusy(false);
    }
  }

  function onKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      void search();
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          type="search"
          aria-label={t("newFarm.search")}
          placeholder={t("newFarm.search")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKey}
        />
        <Button type="button" variant="secondary" busy={busy} onClick={() => void search()}>
          {t("newFarm.searchButton")}
        </Button>
      </div>
      {failed && <p className="text-sm text-red-700">{t("newFarm.searchFailed")}</p>}
      {places && places.length === 0 && <p className="text-sm text-stone-500">{t("newFarm.noResults")}</p>}
      {places && places.length > 0 && (
        <ul className="divide-y divide-stone-100 rounded-lg border border-stone-200 text-sm">
          {places.map((place) => (
            <li key={place.place_id}>
              <button
                type="button"
                className="w-full px-3 py-2 text-left hover:bg-emerald-50"
                onClick={() => {
                  onPick({ lat: Number(place.lat), lon: Number(place.lon), zoom: 15 });
                  setPlaces(null);
                }}
              >
                {place.display_name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type Props = {
  readOnly?: boolean;
  mode: MapMode;
  pin: { lat: number; lon: number } | null;
  corners: LatLon[];
  flyTo: FlyTo | null;
  onPin: (lat: number, lon: number) => void;
  onCorners: (corners: LatLon[]) => void;
  onSearch: (place: FlyTo) => void;
};

export function FieldMap({ mode, pin, corners, flyTo, onPin, onCorners, onSearch, readOnly = false }: Props) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const group = useRef<L.LayerGroup | null>(null);
  const latest = useRef({ mode, corners, onPin, onCorners, readOnly });

  useEffect(() => {
    latest.current = { mode, corners, onPin, onCorners, readOnly };
  });

  useEffect(() => {
    const start = pin ? { ...pin, zoom: 15 } : INDIA_VIEW;
    const instance = L.map(box.current!, { center: [start.lat, start.lon], zoom: start.zoom });
    L.tileLayer(TILES, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(instance);
    group.current = L.layerGroup().addTo(instance);
    instance.on("click", (event: L.LeafletMouseEvent) => {
      if (latest.current.readOnly || instance.getZoom() !== Math.round(instance.getZoom())) return;
      const { mode: current, corners: drawn } = latest.current;
      if (current === "pin") latest.current.onPin(event.latlng.lat, event.latlng.lng);
      else if (drawn.length < MAX_CORNERS) latest.current.onCorners([...drawn, [event.latlng.lat, event.latlng.lng]]);
    });
    map.current = instance;
    return () => {
      instance.remove();
      map.current = null;
    };
    // Created once: later pins arrive through the effects below, and the map moves via `flyTo`.
  }, []);

  useEffect(() => {
    const layers = group.current;
    if (!layers) return;
    layers.clearLayers();
    if (mode === "pin" && pin) {
      const marker = L.marker([pin.lat, pin.lon], { icon: PIN_ICON, draggable: !readOnly });
      marker.on("dragend", () => {
        const at = marker.getLatLng();
        latest.current.onPin(at.lat, at.lng);
      });
      layers.addLayer(marker);
    }
    if (mode === "boundary") {
      if (corners.length >= 2) {
        layers.addLayer(L.polygon(corners, { color: "#047857", weight: 2, fillColor: "#10b981", fillOpacity: 0.2 }));
      }
      corners.forEach((corner, index) => {
        const handle = L.marker(corner, { icon: CORNER_ICON, draggable: !readOnly });
        handle.on("dragend", () => {
          const at = handle.getLatLng();
          const next = [...latest.current.corners];
          next[index] = [at.lat, at.lng];
          latest.current.onCorners(next);
        });
        layers.addLayer(handle);
      });
    }
    if (readOnly && corners.length >= 3) map.current?.fitBounds(L.latLngBounds(corners), { padding: [24, 24], maxZoom: 18 });
  }, [mode, pin, corners, readOnly]);

  useEffect(() => {
    if (flyTo && map.current) map.current.flyTo([flyTo.lat, flyTo.lon], flyTo.zoom, { duration: 0.8 });
  }, [flyTo]);

  return (
    <div className="space-y-3">
      {!readOnly && <PlaceSearch onPick={onSearch} />}
      <div ref={box} className="h-80 w-full overflow-hidden rounded-xl border border-stone-200 sm:h-96" aria-label={t("newFarm.mapTitle")} />
    </div>
  );
}
