import { ArrowLeft, ArrowRight, CircleHelp, X } from "lucide-react";
import { createContext, useContext, useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";
import { buildTour, placeTooltip, savedTourStatus, saveTourStatus, TARGET_WAIT_MS, type FarmTourScope, type Rect, type TourId, type TourStep, type Viewport } from "./model";
import styles from "./tour.module.css";

type ActiveTour = { id: TourId; steps: TourStep[]; index: number; origin: string; scroll: [number, number] };
type TourContextValue = { start: () => void; active: boolean; setFarm: Dispatch<SetStateAction<FarmTourScope | null>> };
const TourContext = createContext<TourContextValue | null>(null);

export function useTour() {
  const context = useContext(TourContext);
  if (!context) throw new Error("useTour requires TourProvider");
  return context;
}

export function useFarmTourScope(farm: { id: string; region: string | null } | undefined, verified: boolean, adviceAvailable: boolean) {
  const { setFarm } = useTour();
  useEffect(() => {
    if (!farm) return;
    setFarm({ id: farm.id, region: farm.region, verified, adviceAvailable });
    return () => setFarm(null);
  }, [farm?.id, farm?.region, verified, adviceAvailable, setFarm]);
}

export function TourButton() {
  const { t } = useTranslation();
  const { start, active } = useTour();
  return <button type="button" data-tour-id="tour-replay" onClick={start} disabled={active}
    className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium text-stone-600 hover:bg-stone-100">
    <CircleHelp className="size-4 shrink-0" aria-hidden="true" />{t("tour.replay")}
  </button>;
}

function currentViewport(): Viewport {
  const viewport = window.visualViewport;
  return { left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0,
    width: Math.min(viewport?.width ?? innerWidth, document.documentElement.clientWidth), height: viewport?.height ?? innerHeight };
}

function visibleTarget(anchor: string): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>(`[data-tour-id="${anchor}"]`)]
    .find((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden") ?? null;
}

export function TourProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const route = `${location.pathname}${location.search}${location.hash}`;
  const [farm, setFarm] = useState<FarmTourScope | null>(null);
  const [active, setActive] = useState<ActiveTour | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const transition = useRef<{ from: string; to: string } | null>(null);

  const startTour = (id: TourId) => {
    if (!userId || active || document.querySelector('.sprout-panel:not([hidden]), dialog[open]')) return;
    let steps = buildTour(id, route, farm, Boolean(visibleTarget("sprout-launcher")));
    if (id === "gettingStarted" && location.pathname !== "/") {
      steps = location.pathname === "/farms/new" ? steps.slice(1).map((step) => ({ ...step, route })) : [
        { id: "farms", target: "nav-farms", title: "farmsTitle", description: "farmsBody", route },
        { id: "account", target: "nav-account", title: "accountTitle", description: "accountBody", route },
      ];
    }
    if (id === "farm" && document.querySelector("main form")) steps = steps.map((step) => ({ ...step, route }));
    if (!steps.length) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    saveTourStatus(userId, id, "started");
    transition.current = { from: route, to: steps[0].route };
    setActive({ id, steps, index: 0, origin: route, scroll: [window.scrollX, window.scrollY] });
    if (route !== steps[0].route) navigate(steps[0].route, { replace: true, state: location.state });
  };
  const autoStart = useEffectEvent(() => {
    if (active || !userId) return;
    if (location.pathname === "/" && !savedTourStatus(userId, "gettingStarted")) startTour("gettingStarted");
    else if (farm && location.pathname === `/farms/${farm.id}` && !savedTourStatus(userId, "farm")) startTour("farm");
  });
  useEffect(() => { autoStart(); }, [userId, location.pathname, farm?.id]);

  const close = (completed: boolean, restore = true) => {
    if (!active) return;
    saveTourStatus(userId, active.id, completed ? "completed" : "dismissed");
    const previous = active;
    setActive(null);
    transition.current = null;
    if (restore) {
      if (route !== previous.origin) navigate(previous.origin, { replace: true, state: location.state });
      requestAnimationFrame(() => {
        window.scrollTo({ left: previous.scroll[0], top: previous.scroll[1], behavior: "instant" });
        const target = returnFocus.current?.isConnected && returnFocus.current !== document.body
          ? returnFocus.current : visibleTarget("tour-replay");
        target?.focus({ preventScroll: true });
      });
    }
  };
  const routeChanged = useEffectEvent(() => {
    if (!active) return;
    const expected = transition.current;
    if (route === active.steps[active.index].route) transition.current = null;
    else if (!expected || (route !== expected.from && route !== expected.to)) close(false, false);
  });
  useEffect(() => { routeChanged(); }, [route]);
  const move = (direction: number) => {
    if (!active) return;
    const index = active.index + direction;
    if (index < 0) return;
    if (index >= active.steps.length) { close(true); return; }
    const next = active.steps[index];
    transition.current = { from: route, to: next.route };
    setActive({ ...active, index });
    if (next.route !== route) navigate(next.route, { replace: true, state: location.state });
  };

  return <TourContext value={{ start: () => startTour(farm && location.pathname === `/farms/${farm.id}` ? "farm" : "gettingStarted"), active: Boolean(active), setFarm }}>
    {children}
    {active && createPortal(<TourOverlay key={active.id} step={active.steps[active.index]} routeReady={route === active.steps[active.index].route}
      index={active.index} total={active.steps.length} name={t(active.id === "farm" ? "tour.farmTour" : "tour.gettingStarted")}
      onBack={() => move(-1)} onNext={() => move(1)} onClose={() => close(false)} />, document.body)}
  </TourContext>;
}

function TourOverlay({ step, routeReady, index, total, name, onBack, onNext, onClose }: {
  step: TourStep; routeReady: boolean; index: number; total: number; name: string;
  onBack: () => void; onNext: () => void; onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const descriptionId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [waiting, setWaiting] = useState(true);
  const [fallback, setFallback] = useState(false);
  const [rect, setRect] = useState<Rect | null>(null);
  const [viewport, setViewport] = useState(currentViewport);
  const [size, setSize] = useState({ width: 352, height: 280 });

  useEffect(() => {
    let frame = 0;
    let expired = false;
    let located: HTMLElement | null = null;
    setTarget(null);
    setRect(null);
    setWaiting(true);
    setFallback(false);
    const find = () => {
      if (!routeReady) return;
      const primary = visibleTarget(step.target);
      const fallbacks = Array.isArray(step.fallback) ? step.fallback : step.fallback ? [step.fallback] : [];
      const found = primary ?? (expired ? fallbacks.map(visibleTarget).find((element) => element !== null) ?? null : null);
      if (found) {
        setTarget(found);
        setWaiting(false);
        setFallback(!primary);
        if (located !== found) {
          located = found;
          found.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
          const header = document.querySelector("header");
          if (header && !header.contains(found)) {
            const top = header.getBoundingClientRect().bottom + 10;
            if (found.getBoundingClientRect().top < top) window.scrollBy({ top: found.getBoundingClientRect().top - top, behavior: "instant" });
          }
        }
        const bounds = found.getBoundingClientRect();
        const nextRect = { top: bounds.top, left: bounds.left, width: bounds.width, height: bounds.height };
        setRect((previous) => JSON.stringify(previous) === JSON.stringify(nextRect) ? previous : nextRect);
      } else {
        setTarget(null);
        setRect(null);
        if (expired) { setWaiting(false); setFallback(true); }
      }
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(find); };
    const observer = new MutationObserver(schedule);
    const root = document.getElementById("root");
    if (root) observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden", "data-tour-id"] });
    const timeout = window.setTimeout(() => { expired = true; find(); if (!routeReady) { setWaiting(false); setFallback(true); } }, TARGET_WAIT_MS);
    find();
    return () => { observer.disconnect(); clearTimeout(timeout); cancelAnimationFrame(frame); };
  }, [step, routeReady]);

  useLayoutEffect(() => {
    let frame = 0;
    const measure = () => {
      const nextViewport = currentViewport();
      setViewport((previous) => JSON.stringify(previous) === JSON.stringify(nextViewport) ? previous : nextViewport);
      const bounds = target?.isConnected ? target.getBoundingClientRect() : null;
      const next = bounds && bounds.width && bounds.height ? { top: bounds.top, left: bounds.left, width: bounds.width, height: bounds.height } : null;
      setRect((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
      if (dialog.current) {
        const nextSize = { width: dialog.current.offsetWidth, height: dialog.current.offsetHeight };
        setSize((previous) => previous.width === nextSize.width && previous.height === nextSize.height ? previous : nextSize);
      }
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    const root = document.getElementById("root");
    if (root) observer.observe(root);
    if (target) observer.observe(target);
    if (dialog.current) observer.observe(dialog.current);
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    measure();
    return () => {
      observer.disconnect(); cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, true); window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule); window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [target, index, waiting, i18n.language]);

  const keyboard = useEffectEvent((event: KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
    if (event.key === "Tab") {
      const buttons = [...dialog.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []];
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.shiftKey ? (current <= 0 ? buttons.length - 1 : current - 1) : (current + 1) % buttons.length;
      event.preventDefault(); buttons[next]?.focus(); return;
    }
    if ((event.target as HTMLElement)?.closest("input, textarea, select, [contenteditable='true']")) return;
    if (event.key === "ArrowRight") { event.preventDefault(); onNext(); }
    if (event.key === "ArrowLeft") { event.preventDefault(); onBack(); }
  });
  useLayoutEffect(() => {
    const root = document.getElementById("root");
    const previousInert = root?.inert ?? false;
    const hidden = root?.getAttribute("aria-hidden");
    dialog.current?.focus({ preventScroll: true });
    if (root) { root.inert = true; root.setAttribute("aria-hidden", "true"); }
    const handleKey = (event: KeyboardEvent) => keyboard(event);
    const focus = (event: FocusEvent) => { if (event.target instanceof Node && !dialog.current?.contains(event.target)) dialog.current?.focus({ preventScroll: true }); };
    document.addEventListener("keydown", handleKey, true);
    document.addEventListener("focusin", focus);
    return () => {
      if (root) { root.inert = previousInert; if (hidden == null) root.removeAttribute("aria-hidden"); else root.setAttribute("aria-hidden", hidden); }
      document.removeEventListener("keydown", handleKey, true); document.removeEventListener("focusin", focus);
    };
  }, []);

  const position = placeTooltip(rect, size, viewport);
  const left = Math.max(viewport.left + 4, (rect?.left ?? 0) - 6);
  const top = Math.max(viewport.top + 4, (rect?.top ?? 0) - 6);
  const right = Math.min(viewport.left + viewport.width - 4, (rect?.left ?? 0) + (rect?.width ?? 0) + 6);
  const bottom = Math.min(viewport.top + viewport.height - 4, (rect?.top ?? 0) + (rect?.height ?? 0) + 6);
  const highlighted = rect && right > left && bottom > top;
  return <div className={styles.overlay} data-tour-overlay="true">
    {highlighted ? <div className={styles.spotlight} aria-hidden="true" style={{ left, top, width: right - left, height: bottom - top }} /> : <div className={styles.shade} aria-hidden="true" />}
    <div ref={dialog} role="dialog" aria-modal="true" aria-busy={waiting} data-tour-step={step.id} aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1}
      className={styles.popover} style={{ ...position, width: Math.min(352, viewport.width - 24), maxHeight: viewport.height - 24 }}>
      <div className={styles.header}>
        <img src="/sprout.png" width="40" height="40" alt="" />
        <span>{name}</span>
        <button type="button" className={styles.close} onClick={onClose} aria-label={t("tour.close")} title={t("tour.close")}><X size={18} aria-hidden="true" /></button>
      </div>
      <div className={styles.copy} aria-live="polite" aria-atomic="true">
        <p className={styles.progress}>{t("tour.progress", { current: index + 1, total })}</p>
        <h2 id={titleId}>{t(`tour.${step.title}`)}</h2>
        <p id={descriptionId}>{t(`tour.${step.description}`)}</p>
        {waiting && <p className={styles.notice} role="status">{t("tour.waiting")}</p>}
        {fallback && <p className={styles.notice}>{t("tour.unavailable")}</p>}
      </div>
      <div className={styles.controls}>
        <button type="button" onClick={onClose}>{t("tour.skip")}</button>
        <button type="button" onClick={onBack} disabled={index === 0}><ArrowLeft size={15} aria-hidden="true" />{t("tour.back")}</button>
        <button type="button" className={styles.next} onClick={onNext}>{t(index === total - 1 ? "tour.finish" : "tour.next")}<ArrowRight size={15} aria-hidden="true" /></button>
      </div>
    </div>
  </div>;
}