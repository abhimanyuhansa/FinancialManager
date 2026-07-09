"use client";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import type { MonthlyTotal } from "@/lib/analytics";

type BarChartCardProps = {
  data: MonthlyTotal[];
};

function shortMonth(month: string): string {
  const [year, m] = month.split("-");
  const date = new Date(Number(year), Number(m) - 1, 1);
  return date.toLocaleString("en", { month: "short" });
}

function formatK(value: number): string {
  if (value >= 100000) return `${(value / 100000).toFixed(1)}L`;
  if (value >= 1000) return `${(value / 1000).toFixed(0)}K`;
  return String(value);
}

export function BarChartCard({ data }: BarChartCardProps) {
  const chartData = data.map((d) => ({
    month: shortMonth(d.month),
    Income: Math.round(d.income),
    Expenses: Math.round(d.expenses),
  }));

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
      <h2 className="text-sm font-semibold text-gray-700 mb-4">Income vs Expenses (6 months)</h2>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={chartData} barCategoryGap="30%" barGap={4}>
          <XAxis dataKey="month" tick={{ fontSize: 12, fill: "#9ca3af" }} axisLine={false} tickLine={false} />
          <YAxis tickFormatter={formatK} tick={{ fontSize: 12, fill: "#9ca3af" }} axisLine={false} tickLine={false} width={40} />
          <Tooltip
            formatter={(value) => [`₹${Number(value ?? 0).toLocaleString("en-IN")}`, undefined]}
            contentStyle={{ borderRadius: 12, border: "1px solid #f0f0f0", fontSize: 12 }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="Income" fill="#5b7cfa" radius={[4, 4, 0, 0]} />
          <Bar dataKey="Expenses" fill="#f87171" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
