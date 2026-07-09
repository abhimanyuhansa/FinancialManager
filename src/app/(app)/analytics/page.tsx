"use client";
import { useEffect, useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
  PieChart, Pie, Cell, Tooltip as PieTooltip,
} from "recharts";

type MonthlyTotal = { month: string; income: number; expenses: number };
type CategoryItem = { category: string; amount: number };
type Kpis = { netWorth: number; income: number; expenses: number };

type DashboardData = {
  currentMonth: Kpis;
  monthlyTotals: MonthlyTotal[];
  categoryBreakdown: CategoryItem[];
};

const COLOURS = ["#5b7cfa", "#f97316", "#22c55e", "#a855f7", "#ec4899", "#14b8a6", "#f59e0b", "#64748b"];

const fmt = (n: number) =>
  n >= 100000 ? `₹${(n / 100000).toFixed(1)}L` : n >= 1000 ? `₹${(n / 1000).toFixed(1)}K` : `₹${n}`;

export default function AnalyticsPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/analytics/dashboard")
      .then((r) => r.json())
      .then((d) => setData(d))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="p-6 max-w-4xl">
        <h1 className="text-2xl font-semibold text-gray-900 mb-6">Analytics</h1>
        <div className="grid grid-cols-1 gap-4">
          {[...Array(3)].map((_, i) => <div key={i} className="h-48 bg-gray-100 rounded-2xl animate-pulse" />)}
        </div>
      </div>
    );
  }

  if (!data) return null;

  const { currentMonth, monthlyTotals, categoryBreakdown } = data;
  const savingsRate = currentMonth.income > 0
    ? Math.round(((currentMonth.income - currentMonth.expenses) / currentMonth.income) * 100)
    : 0;

  const topCategories = [...categoryBreakdown]
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 8);

  const totalSpend = topCategories.reduce((s, c) => s + c.amount, 0);

  return (
    <div className="p-6 max-w-4xl">
      <h1 className="text-2xl font-semibold text-gray-900 mb-1">Analytics</h1>
      <p className="text-sm text-gray-500 mb-6">
        {new Date().toLocaleString("en-IN", { month: "long", year: "numeric" })}
      </p>

      {/* Summary KPI row */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        {[
          { label: "Income", value: currentMonth.income, colour: "text-blue-600" },
          { label: "Spent", value: currentMonth.expenses, colour: "text-red-500" },
          { label: "Savings Rate", value: null, display: `${savingsRate}%`, colour: savingsRate >= 20 ? "text-green-600" : "text-amber-500" },
        ].map(({ label, value, display, colour }) => (
          <div key={label} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">{label}</p>
            <p className={`text-2xl font-bold ${colour}`}>{display ?? fmt(value ?? 0)}</p>
          </div>
        ))}
      </div>

      {/* Monthly bar chart */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 mb-6">
        <h2 className="text-sm font-semibold text-gray-700 mb-4">Income vs Expenses (6 months)</h2>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={monthlyTotals} barCategoryGap="30%" barGap={4}>
            <XAxis dataKey="month" tick={{ fontSize: 12 }} />
            <YAxis tickFormatter={(v) => fmt(v)} tick={{ fontSize: 11 }} />
            <Tooltip formatter={(v) => fmt(Number(v ?? 0))} />
            <Legend />
            <Bar dataKey="income" name="Income" fill="#5b7cfa" radius={[4, 4, 0, 0]} />
            <Bar dataKey="expenses" name="Expenses" fill="#f87171" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Category breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Donut */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">Spending by Category</h2>
          {topCategories.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">No expense data this month.</p>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={topCategories} dataKey="amount" nameKey="category" cx="50%" cy="50%" innerRadius={55} outerRadius={85}>
                  {topCategories.map((_, i) => <Cell key={i} fill={COLOURS[i % COLOURS.length]} />)}
                </Pie>
                <PieTooltip formatter={(v) => fmt(Number(v ?? 0))} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Category list */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">Category Breakdown</h2>
          <div className="flex flex-col gap-2">
            {topCategories.map((c, i) => {
              const pct = totalSpend > 0 ? Math.round((c.amount / totalSpend) * 100) : 0;
              return (
                <div key={c.category}>
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-xs text-gray-600 capitalize">{c.category}</span>
                    <span className="text-xs font-medium text-gray-900">{fmt(c.amount)} <span className="text-gray-400">({pct}%)</span></span>
                  </div>
                  <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: COLOURS[i % COLOURS.length] }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
