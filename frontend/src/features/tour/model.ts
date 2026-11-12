import type en from "../../locales/en.json";

export type TourId = "gettingStarted" | "farm";
export type TourStatus = "started" | "completed" | "dismissed";
export type FarmTourScope = { id: string; region: string | null; verified: boolean; adviceAvailable: boolean };
export type TourStep = {
  id: string;
  target: string;
  fallback?: string | string[];
  title: keyof typeof en.tour;
  description: keyof typeof en.tour;
  route: string;
};
export type Rect = { top: number; left: number; width: number; height: number };
export type Viewport = Rect;

export const TOUR_VERSION = 1;
export const TARGET_WAIT_MS = 5000;

export function tourCookieName(userId: string, tourId: TourId): string {
  return `cc_tour_v${TOUR_VERSION}_${encodeURIComponent(userId)}_${tourId}`;
}

export function cookieStatus(cookies: string, userId: string, tourId: TourId): TourStatus | null {
  const prefix = `${tourCookieName(userId, tourId)}=`;
  const value = cookies.split(";").map((entry) => entry.trim()).find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
  return value === "started" || value === "completed" || value === "dismissed" ? value : null;
}

const sessionSeen = new Map<string, TourStatus>();

export function savedTourStatus(userId: string, tourId: TourId): TourStatus | null {
  const key = tourCookieName(userId, tourId);
  try { return cookieStatus(document.cookie, userId, tourId) ?? sessionSeen.get(key) ?? null; }
  catch { return sessionSeen.get(key) ?? null; }
}

export function saveTourStatus(userId: string, tourId: TourId, status: TourStatus): void {
  const key = tourCookieName(userId, tourId);
  sessionSeen.set(key, status);
  try {
    document.cookie = `${key}=${status}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
  } catch {}
}

export function buildTour(tourId: TourId, origin: string, farm: FarmTourScope | null, sprout: boolean): TourStep[] {
  if (tourId === "gettingStarted") {
    return [
      { id: "farms", target: "farms-heading", fallback: "nav-farms", title: "farmsTitle", description: "farmsBody", route: "/" },
      { id: "location", target: "new-farm-location", title: "locationTitle", description: "locationBody", route: "/farms/new" },
      { id: "water", target: "new-farm-water", title: "waterTitle", description: "waterBody", route: "/farms/new" },
      { id: "create", target: "new-farm-create", title: "createTitle", description: "createBody", route: "/farms/new" },
    ];
  }
  if (!farm) return [];
  const base = `/farms/${farm.id}`;
  const original = new URL(origin, "http://tour.local");
  const route = (tab?: string) => {
    const params = new URLSearchParams(original.search);
    if (tab) params.set("tab", tab);
    return `${base}${params.size ? `?${params}` : ""}`;
  };
  const steps: TourStep[] = [
    { id: "readiness", target: "farm-readiness", fallback: "farm-heading", title: "readinessTitle", description: "readinessBody", route: route() },
    { id: "climate", target: "farm-tab-climate", title: "climateTitle", description: farm.verified ? "climateBody" : "climatePendingBody", route: route() },
    { id: "soil", target: "soil-edit", fallback: "farm-tab-soil", title: "soilTitle", description: "soilBody", route: route("soil") },
    { id: "history", target: "farm-tab-history", title: "historyTitle", description: "historyBody", route: route("soil") },
  ];
  if (farm.region === "IN") {
    steps.push(
      { id: "preview", target: "field-crops", fallback: ["field-search", "farm-tab-field"], title: "previewTitle", description: farm.adviceAvailable ? "previewBody" : "previewPendingBody", route: route("field") },
      { id: "plan", target: "farm-tab-plan", title: "planTitle", description: "planBody", route: route("field") },
    );
  }
  if (sprout) steps.push({ id: "sprout", target: "sprout-launcher", fallback: "tour-replay", title: "sproutTitle", description: "sproutBody", route: route(farm.region === "IN" ? "field" : "soil") });
  return steps;
}

export function placeTooltip(target: Rect | null, size: { width: number; height: number }, viewport: Viewport): { left: number; top: number } {
  const margin = 12;
  const gap = 14;
  const minLeft = viewport.left + margin;
  const minTop = viewport.top + margin;
  const maxLeft = Math.max(minLeft, viewport.left + viewport.width - size.width - margin);
  const maxTop = Math.max(minTop, viewport.top + viewport.height - size.height - margin);
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  if (!target) return { left: clamp(viewport.left + (viewport.width - size.width) / 2, minLeft, maxLeft), top: clamp(viewport.top + (viewport.height - size.height) / 2, minTop, maxTop) };
  const candidates = [
    { left: target.left + target.width + gap, top: clamp(target.top, minTop, maxTop) },
    { left: target.left - size.width - gap, top: clamp(target.top, minTop, maxTop) },
    { left: clamp(target.left, minLeft, maxLeft), top: target.top + target.height + gap },
    { left: clamp(target.left, minLeft, maxLeft), top: target.top - size.height - gap },
  ];
  const best = candidates.find((point) => point.left >= minLeft && point.left <= maxLeft && point.top >= minTop && point.top <= maxTop)
    ?? { left: minLeft, top: maxTop };
  return { left: clamp(best.left, minLeft, maxLeft), top: clamp(best.top, minTop, maxTop) };
}