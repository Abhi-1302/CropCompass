import { useTranslation } from "react-i18next";
import { LANGUAGE_NAMES, LANGUAGES, setLanguage, type Language } from "../i18n";
import { cx } from "./ui";

export function LanguageSwitcher({ className }: { className?: string }) {
  const { t, i18n } = useTranslation();
  return (
    <select
      aria-label={t("nav.language")}
      value={i18n.language}
      onChange={(event) => setLanguage(event.target.value as Language)}
      className={cx(
        "rounded-lg border border-stone-300 bg-white px-2 py-1.5 text-sm text-stone-700 focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/20 focus:outline-none",
        className,
      )}
    >
      {LANGUAGES.map((code) => (
        <option key={code} value={code} lang={code}>
          {LANGUAGE_NAMES[code]}
        </option>
      ))}
    </select>
  );
}
