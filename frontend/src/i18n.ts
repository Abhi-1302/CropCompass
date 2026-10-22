import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";

declare module "i18next" {
  interface CustomTypeOptions {
    resources: { translation: typeof en };
  }
}

export const LANGUAGES = ["en", "hi", "te"] as const;
export type Language = (typeof LANGUAGES)[number];
/** Each language is listed in its own script, whatever the current language. */
export const LANGUAGE_NAMES: Record<Language, string> = { en: "English", hi: "हिन्दी", te: "తెలుగు" };
const STORAGE_KEY = "af_lang";

// Loaded on demand; typed against English, so a translation missing any key fails the type check.
const LOADERS: Record<Exclude<Language, "en">, () => Promise<{ default: typeof en }>> = {
  hi: () => import("./locales/hi.json"),
  te: () => import("./locales/te.json"),
};

function savedLanguage(): Language {
  const saved = localStorage.getItem(STORAGE_KEY);
  return LANGUAGES.find((code) => code === saved) ?? "en";
}

async function activate(language: Language): Promise<void> {
  if (language !== "en" && !i18n.hasResourceBundle(language, "translation")) {
    i18n.addResourceBundle(language, "translation", (await LOADERS[language]()).default);
  }
  await i18n.changeLanguage(language);
}

export function setLanguage(language: Language): void {
  localStorage.setItem(STORAGE_KEY, language);
  void activate(language);
}

i18n.on("languageChanged", (language) => {
  document.documentElement.lang = language;
});

/** Resolves once the saved language is ready, so the first render is already in that language. */
export const i18nReady: Promise<void> = i18n
  .use(initReactI18next)
  .init({
    resources: { en: { translation: en } },
    lng: "en",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
  })
  .then(() => activate(savedLanguage()))
  .catch(() => undefined);

export default i18n;
