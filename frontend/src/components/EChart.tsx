import { BarChart, LineChart, ScatterChart } from "echarts/charts";
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
} from "echarts/components";
import * as echarts from "echarts/core";
import type { EChartsCoreOption } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useMemo, useRef } from "react";
import { useTheme } from "../lib/theme";

echarts.use([
  BarChart,
  LineChart,
  ScatterChart,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
  CanvasRenderer,
]);

export const AXIS_STYLE = { axisLine: { lineStyle: { color: "#a8a29e" } }, axisLabel: { color: "#57534e" } };
export const SPLIT_LINE = { splitLine: { lineStyle: { color: "#e7e5e4" } } };

type Props = { option: EChartsCoreOption; label: string; height?: number };

/** Chart options are written for light mode; in dark mode the light-mode inks and grid greys are swapped. */
const DARK_INKS: Record<string, string> = {
  "#44403c": "#bec7c2",
  "#57534e": "#a2ada7",
  "#78716c": "#85918b",
  "#a8a29e": "#56625c",
  "#e7e5e4": "#252e2a",
  "#047857": "#6cb592",
};

function forDark(value: unknown): unknown {
  if (typeof value === "string") return DARK_INKS[value.toLowerCase()] ?? value;
  if (Array.isArray(value)) return value.map(forDark);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, forDark(item)]));
  }
  return value;
}

echarts.registerTheme("cc-dark", {
  backgroundColor: "transparent",
  textStyle: { color: "#bec7c2" },
  tooltip: { backgroundColor: "#19201d", borderColor: "#36413c", textStyle: { color: "#e9eeeb" } },
  legend: { textStyle: { color: "#bec7c2" } },
});

export function EChart({ option, label, height = 300 }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<ReturnType<typeof echarts.init> | null>(null);
  const theme = useTheme();
  const themed = useMemo(() => (theme === "dark" ? (forDark(option) as EChartsCoreOption) : option), [option, theme]);

  useEffect(() => {
    if (!container.current) return;
    const instance = echarts.init(container.current, theme === "dark" ? "cc-dark" : undefined, { renderer: "canvas" });
    chart.current = instance;
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(container.current);
    return () => {
      observer.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, [theme]);

  useEffect(() => {
    chart.current?.setOption(themed, true);
  }, [themed]);

  return <div ref={container} role="img" aria-label={label} style={{ height }} className="w-full" />;
}
