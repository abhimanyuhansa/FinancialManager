"use client";
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from "recharts";
import type { CategoryTotal } from "@/lib/analytics";

const CATEGORY_COLORS: Record<string, string> = {
  food: "#fb923c",
  cafe: "#fb923c",
  transport: "#34d399",
  metro: "#34d399",
  shopping: "#fbbf24",
  clothing: "#fbbf24",
  bills: "#a78bfa",
  phone: "#a78bfa",
  health: "#60a5fa",
  learning: "#60a5fa",
  ott: "#4ade80",
  rent: "#f87171",
  personal: "#f472b6",
  investment: "#6ee7b7",
  work: "#93c5fd",
  other: "#d1c4a8",
};

function categoryColor(category: string): string {
  return CATEGORY_COLORS[category.toLowerCase()] ?? "#d1d5db";
}

type DonutChartCardProps = {
  data: CategoryTotal[];
};

export function DonutChartCard({ data }: DonutChartCardProps) {
  if (data.length === 0) {
    return (
      <div className="bg-white rounded-lg border border-[#E9E9EB]  p-5 h-[280px] flex flex-col">
        <h2 className="text-sm font-semibold text-[#44475B] mb-4">Spending by Category</h2>
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-[#A1A3AD]">No expense data this month</p>
        </div>
      </div>
    );
  }

  const chartData = data.slice(0, 8).map((d) => ({
    name: d.category.charAt(0).toUpperCase() + d.category.slice(1),
    value: Math.round(d.amount),
    category: d.category,
  }));

  return (
    <div className="bg-white rounded-lg border border-[#E9E9EB]  p-5">
      <h2 className="text-sm font-semibold text-[#44475B] mb-4">Spending by Category</h2>
      <ResponsiveContainer width="100%" height={220}>
        <PieChart>
          <Pie
            data={chartData}
            cx="50%"
            cy="50%"
            innerRadius={60}
            outerRadius={90}
            paddingAngle={3}
            dataKey="value"
          >
            {chartData.map((entry) => (
              <Cell key={entry.category} fill={categoryColor(entry.category)} />
            ))}
          </Pie>
          <Tooltip
            formatter={(value) => [`₹${Number(value ?? 0).toLocaleString("en-IN")}`, undefined]}
            contentStyle={{ borderRadius: 12, border: "1px solid #f0f0f0", fontSize: 12 }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
