import { useTranslation } from "react-i18next";
import { Link } from "react-router";

export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 p-8 text-center">
      <p className="text-5xl font-semibold text-emerald-700">404</p>
      <h1 className="text-xl font-semibold">{t("common.notFound")}</h1>
      <Link to="/" className="text-sm font-medium text-emerald-700 hover:text-emerald-800">
        {t("common.goHome")}
      </Link>
    </div>
  );
}
