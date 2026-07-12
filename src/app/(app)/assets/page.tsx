"use client";
import { useEffect, useState } from "react";

type Asset = {
  id: string;
  name: string;
  type: string;
  value: number;
  currency: string;
  asOf: string;
};

type FormState = {
  name: string;
  type: string;
  value: string;
  currency: string;
  asOf: string;
};

const ASSET_TYPES = ["savings", "investment", "property", "vehicle", "crypto", "retirement", "other"];

const ASSET_ICONS: Record<string, string> = {
  savings: "🏦", investment: "📈", property: "🏠", vehicle: "🚗",
  crypto: "₿", retirement: "🏖️", other: "💼",
};

const emptyForm = (): FormState => ({
  name: "", type: "savings", value: "", currency: "INR",
  asOf: new Date().toISOString().split("T")[0],
});

export default function AssetsPage() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const fetchAssets = () => {
    setLoading(true);
    fetch("/api/assets")
      .then((r) => r.json())
      .then((d: { assets: Asset[] }) => setAssets(d.assets ?? []))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchAssets(); }, []);

  const totalValue = assets.reduce((sum, a) => sum + a.value, 0);

  const openAdd = () => { setEditId(null); setForm(emptyForm()); setError(""); setShowForm(true); };
  const openEdit = (a: Asset) => {
    setEditId(a.id);
    setForm({ name: a.name, type: a.type, value: String(a.value), currency: a.currency, asOf: a.asOf.split("T")[0] });
    setError("");
    setShowForm(true);
  };

  const handleSave = async () => {
    const value = parseFloat(form.value);
    if (!form.name || isNaN(value) || value <= 0) { setError("Name and a positive value are required."); return; }
    setSaving(true);
    setError("");
    try {
      const payload = { name: form.name, type: form.type, value, currency: form.currency, asOf: form.asOf };
      const res = editId
        ? await fetch(`/api/assets/${editId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
        : await fetch("/api/assets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!res.ok) { const d = await res.json() as { error: string }; throw new Error(d.error); }
      setShowForm(false);
      fetchAssets();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save asset");
    } finally { setSaving(false); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this asset?")) return;
    await fetch(`/api/assets/${id}`, { method: "DELETE" });
    fetchAssets();
  };

  return (
    <div className="p-6 max-w-3xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-[#44475B]">Assets</h1>
          <p className="text-sm text-[#7C7E8C] mt-0.5">Portfolio total: ₹{totalValue.toLocaleString("en-IN")}</p>
        </div>
        <button
          onClick={openAdd}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[#04B488] text-white text-sm font-medium hover:bg-[#03a07a] transition-colors"
        >
          <span className="text-base leading-none">+</span> Add Asset
        </button>
      </div>

      {/* Add/Edit form */}
      {showForm && (
        <div className="bg-white rounded-lg border border-[#E9E9EB] p-5 mb-6">
          <h2 className="text-sm font-semibold text-[#44475B] mb-4">{editId ? "Edit Asset" : "Add Asset"}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2">
              <label className="block text-xs text-[#7C7E8C] mb-1">Name</label>
              <input
                type="text"
                placeholder="e.g. HDFC Savings Account"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-[#E9E9EB] text-sm focus:outline-none focus:ring-2 focus:ring-[#04B488]"
              />
            </div>
            <div>
              <label className="block text-xs text-[#7C7E8C] mb-1">Type</label>
              <select
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-[#E9E9EB] text-sm focus:outline-none focus:ring-2 focus:ring-[#04B488]"
              >
                {ASSET_TYPES.map((t) => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-[#7C7E8C] mb-1">Value (₹)</label>
              <input
                type="number"
                placeholder="0"
                value={form.value}
                onChange={(e) => setForm({ ...form, value: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-[#E9E9EB] text-sm focus:outline-none focus:ring-2 focus:ring-[#04B488]"
              />
            </div>
            <div>
              <label className="block text-xs text-[#7C7E8C] mb-1">As of Date</label>
              <input
                type="date"
                value={form.asOf}
                onChange={(e) => setForm({ ...form, asOf: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-[#E9E9EB] text-sm focus:outline-none focus:ring-2 focus:ring-[#04B488]"
              />
            </div>
          </div>
          {error && <p className="text-xs text-[#ED5533] mt-2">{error}</p>}
          <div className="flex gap-2 mt-4">
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 bg-[#04B488] text-white rounded-lg text-sm font-medium hover:bg-[#03a07a] disabled:opacity-60 transition-colors"
            >
              {saving ? "Saving..." : editId ? "Update" : "Add"}
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="px-4 py-2 border border-[#E9E9EB] text-[#7C7E8C] rounded-lg text-sm hover:bg-[#F8F8F8] transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Assets list */}
      {loading ? (
        <div className="flex flex-col gap-3">
          {[...Array(3)].map((_, i) => <div key={i} className="h-16 bg-[#F8F8F8] rounded-lg animate-pulse" />)}
        </div>
      ) : assets.length === 0 ? (
        <div className="bg-white rounded-lg border border-[#E9E9EB] p-12 text-center">
          <p className="text-sm text-[#A1A3AD]">No assets yet. Add your first asset to track your portfolio.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {assets.map((a) => (
            <div key={a.id} className="bg-white rounded-lg border border-[#E9E9EB] p-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-2xl">{ASSET_ICONS[a.type] ?? "💼"}</span>
                <div>
                  <p className="text-sm font-semibold text-[#44475B]">{a.name}</p>
                  <p className="text-xs text-[#7C7E8C] capitalize">
                    {a.type} · as of {new Date(a.asOf).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold text-[#44475B]">
                  ₹{a.value.toLocaleString("en-IN")}
                </span>
                <div className="flex gap-1">
                  <button
                    onClick={() => openEdit(a)}
                    className="p-1.5 rounded-lg text-[#A1A3AD] hover:text-[#44475B] hover:bg-[#F8F8F8] transition-colors"
                    title="Edit"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                  </button>
                  <button
                    onClick={() => handleDelete(a.id)}
                    className="p-1.5 rounded-lg text-[#A1A3AD] hover:text-[#ED5533] hover:bg-[#FAE9E5] transition-colors"
                    title="Delete"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                      <path d="M10 11v6M14 11v6" />
                      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
