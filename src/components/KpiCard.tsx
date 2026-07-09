import { getBadgeVariant, BadgeMetric } from "@/lib/analytics";

type KpiCardProps = {
  label: string;
  value: number;
  prevValue: number;
  metric: BadgeMetric;
  prefix?: string;
};

function formatAmount(n: number, prefix = "₹"): string {
  if (n >= 100000) return `${prefix}${(n / 100000).toFixed(1)}L`;
  if (n >= 1000) return `${prefix}${(n / 1000).toFixed(1)}K`;
  return `${prefix}${n.toLocaleString("en-IN")}`;
}

export function KpiCard({ label, value, prevValue, metric, prefix = "₹" }: KpiCardProps) {
  const direction =
    value > prevValue ? "up" : value < prevValue ? "down" : "unchanged";
  const variant = getBadgeVariant(metric, direction);

  const pct =
    prevValue !== 0
      ? Math.abs(Math.round(((value - prevValue) / prevValue) * 100))
      : null;

  const badgeColors = {
    good: "bg-[#e8f5e9] text-green-700",
    bad: "bg-[#fce8e8] text-red-700",
    neutral: "bg-gray-100 text-gray-500",
  };

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 flex flex-col gap-2">
      <span className="text-xs text-gray-500 font-medium uppercase tracking-wide">{label}</span>
      <span className="text-2xl font-semibold text-gray-900">{formatAmount(value, prefix)}</span>
      {pct !== null && (
        <span
          className={`text-xs font-medium px-2 py-0.5 rounded-full w-fit ${badgeColors[variant]}`}
        >
          {direction === "up" ? "↑" : "↓"} {pct}% vs last month
        </span>
      )}
    </div>
  );
}
