import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { ChevronDown, Info } from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import type en from "../locales/en.json";

function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  busy?: boolean;
};

const BUTTON_VARIANTS = {
  primary: "bg-brand text-white hover:bg-brand-strong shadow-sm",
  secondary: "bg-surface text-stone-800 ring-1 ring-stone-300 hover:bg-stone-50",
  ghost: "text-stone-700 hover:bg-stone-100",
  danger: "bg-surface text-red-700 ring-1 ring-red-200 hover:bg-red-50",
};

export function Button({ variant = "primary", size = "md", busy, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || busy}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        size === "sm" ? "px-3 py-1.5 text-sm" : "px-4 py-2.5 text-sm",
        BUTTON_VARIANTS[variant],
        className,
      )}
    >
      {busy && <Spinner className="size-4" />}
      {children}
    </button>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("rounded-2xl border border-stone-200 bg-surface p-5 shadow-sm", className)}>{children}</div>;
}

type FieldProps = { label: string; hint?: string; children: (id: string) => ReactNode };

export function Field({ label, hint, children }: FieldProps) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-stone-800">
        {label}
      </label>
      {children(id)}
      {hint && <p className="text-xs text-stone-500">{hint}</p>}
    </div>
  );
}

const CONTROL =
  "block w-full rounded-lg border border-stone-300 bg-surface px-3 py-2.5 text-sm shadow-xs placeholder:text-stone-400 focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/20 focus:outline-none";

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cx(CONTROL, className)} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cx(CONTROL, className)}>
      {children}
    </select>
  );
}

const BADGE_TONES = {
  green: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  amber: "bg-amber-50 text-amber-800 ring-amber-200",
  red: "bg-red-50 text-red-700 ring-red-200",
  sky: "bg-sky-50 text-sky-800 ring-sky-200",
  stone: "bg-stone-100 text-stone-700 ring-stone-200",
};

export function Badge({ tone = "stone", children }: { tone?: keyof typeof BADGE_TONES; children: ReactNode }) {
  return (
    <span className={cx("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1", BADGE_TONES[tone])}>
      {children}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cx("animate-spin text-current", className ?? "size-5")} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z" />
    </svg>
  );
}

const ALERT_TONES = {
  error: "border-red-200 bg-red-50 text-red-800",
  info: "border-sky-200 bg-sky-50 text-sky-900",
  warning: "border-amber-200 bg-amber-50 text-amber-900",
};

export function Alert({ tone = "info", children }: { tone?: keyof typeof ALERT_TONES; children: ReactNode }) {
  const { t, i18n } = useTranslation();
  const message = typeof children === "string" && i18n.exists(`guestErrors.${children}`)
    ? t(`guestErrors.${children as keyof typeof en.guestErrors}`) : children;
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cx("rounded-xl border px-4 py-3 text-sm", ALERT_TONES[tone])}>
      {message}
    </div>
  );
}

export function PageSpinner() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center text-emerald-700">
      <Spinner className="size-8" />
    </div>
  );
}

export function SectionHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-lg font-semibold text-stone-900">{title}</h2>
        {subtitle && <p className="mt-0.5 text-sm text-stone-500">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

type Choice<K extends string> = { key: K; label: string; title?: string; icon?: ReactNode };

/** Page-level navigation: a quiet underline tab bar. `idPrefix` gives each tab a tour anchor. */
export function Tabs<K extends string>({ items, value, onChange, label, idPrefix, className }: {
  items: Choice<K>[];
  value: K;
  onChange: (key: K) => void;
  label: string;
  idPrefix?: string;
  className?: string;
}) {
  return (
    <div role="tablist" aria-label={label} className={cx("flex max-w-full gap-1 overflow-x-auto border-b border-stone-200", className)}>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="tab"
          title={item.title}
          aria-selected={value === item.key}
          data-tour-id={idPrefix ? `${idPrefix}${item.key}` : undefined}
          onClick={() => onChange(item.key)}
          className={cx(
            "-mb-px inline-flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm font-medium transition-colors",
            value === item.key
              ? "border-emerald-600 text-stone-900"
              : "border-transparent text-stone-500 hover:border-stone-300 hover:text-stone-800",
          )}
        >
          {item.icon && <span className={value === item.key ? "text-emerald-600" : "text-stone-400"}>{item.icon}</span>}
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** A compact choice between a few options (season, water supply...). */
export function Segmented<K extends string>({ items, value, onChange, label, size = "md", className }: {
  items: Choice<K>[];
  value: K | undefined;
  onChange: (key: K) => void;
  label: string;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cx("inline-flex max-w-full rounded-lg bg-stone-100 p-1", className)}>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="radio"
          title={item.title}
          aria-checked={value === item.key}
          onClick={() => onChange(item.key)}
          className={cx(
            "flex-1 whitespace-nowrap rounded-md font-medium transition-colors",
            size === "sm" ? "px-2.5 py-1 text-xs" : "px-3.5 py-1.5 text-sm",
            value === item.key ? "bg-surface text-stone-900 shadow-sm" : "text-stone-600 hover:text-stone-900",
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Supporting notes (sources, assumptions, method) folded behind one quiet link, so each view keeps
 * a single place for its fine print instead of scattered footnotes.
 */
export function AboutData({ children, label }: { children: ReactNode; label?: string }) {
  const { t } = useTranslation();
  return (
    <details className="group text-xs text-stone-500">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md py-1 font-medium hover:text-stone-800 [&::-webkit-details-marker]:hidden">
        <Info className="size-3.5" aria-hidden="true" />
        {label ?? t("common.aboutData")}
        <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="mt-2 max-w-3xl space-y-1.5 border-l-2 border-stone-200 pl-3 leading-relaxed">{children}</div>
    </details>
  );
}

const DOT_TONES = { warn: "bg-amber-500", good: "bg-emerald-500", neutral: "bg-stone-500", bad: "bg-red-500" };

/** "k in 10 years" as ten marks, filled for the years it happened. */
export function DotScale({ p, tone = "neutral", className }: { p: number | null | undefined; tone?: keyof typeof DOT_TONES; className?: string }) {
  const filled = p == null ? 0 : Math.round(Math.min(1, Math.max(0, p)) * 10);
  return (
    <span className={cx("inline-flex gap-[3px]", className)} aria-hidden="true">
      {Array.from({ length: 10 }, (_, index) => (
        <span key={index} className={cx("h-2.5 w-1.5 rounded-[2px]", index < filled ? DOT_TONES[tone] : "bg-stone-200")} />
      ))}
    </span>
  );
}

/** A horizontal 0-100% bar. */
export function Meter({ value, tone = "sky", className }: { value: number | null | undefined; tone?: "sky" | "emerald" | "amber"; className?: string }) {
  const width = value == null ? 0 : Math.round(Math.min(1, Math.max(0, value)) * 100);
  const color = { sky: "bg-sky-500", emerald: "bg-emerald-500", amber: "bg-amber-500" }[tone];
  return (
    <span className={cx("block h-1.5 overflow-hidden rounded-full bg-stone-200", className)} aria-hidden="true">
      <span className={cx("block h-full rounded-full", color)} style={{ width: `${width}%` }} />
    </span>
  );
}

export const STATUS_DOT = { green: "bg-emerald-500", amber: "bg-amber-500", red: "bg-red-500", sky: "bg-sky-500", stone: "bg-stone-400" };

/** A labelled number inside a <dl>. */
export function Metric({ label, value, detail, warn }: { label: string; value: string; detail?: string; warn?: boolean }) {
  return (
    <div>
      <dt className="text-xs font-medium text-stone-500">{label}</dt>
      <dd className={cx("mt-0.5 text-lg font-semibold", warn ? "text-amber-700" : "text-stone-900")}>{value}</dd>
      {detail && <dd className="text-xs leading-snug text-stone-500">{detail}</dd>}
    </div>
  );
}

export { cx };
