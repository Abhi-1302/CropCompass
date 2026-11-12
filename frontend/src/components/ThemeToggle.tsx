import { Moon, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";
import { setTheme, useTheme } from "../lib/theme";
import { cx } from "./ui";

export function ThemeToggle({ className }: { className?: string }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  const label = t(next === "dark" ? "theme.toDark" : "theme.toLight");
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={label}
      title={label}
      className={cx(
        "inline-flex size-9 items-center justify-center rounded-lg border border-stone-300 bg-surface text-stone-700 hover:bg-stone-100",
        className,
      )}
    >
      {theme === "dark" ? <Sun className="size-4" aria-hidden="true" /> : <Moon className="size-4" aria-hidden="true" />}
    </button>
  );
}
