export function Logo({ light = false }: { light?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2">
      <svg viewBox="0 0 32 32" className="size-8" aria-hidden="true">
        <rect width="32" height="32" rx="8" fill={light ? "#ffffff" : "#047857"} />
        <path d="M9 22c0-8 6-13 15-13-1 9-6 15-13 15" fill={light ? "#10b981" : "#a7f3d0"} />
        <path d="M9 24c3-5 7-8 11-10" stroke={light ? "#047857" : "#065f46"} strokeWidth="2" fill="none" strokeLinecap="round" />
      </svg>
      <span className={light ? "text-lg font-semibold text-white" : "text-lg font-semibold text-stone-900"}>CropCompass</span>
    </span>
  );
}
