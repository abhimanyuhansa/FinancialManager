"use client";

export type LookbackPeriod = "1m" | "3m" | "6m";

type StepPickerProps = {
  value: LookbackPeriod;
  onChange: (p: LookbackPeriod) => void;
  onConfirm: () => void;
  loading: boolean;
};

const options: { value: LookbackPeriod; label: string; desc: string }[] = [
  { value: "1m", label: "Last 1 month", desc: "~30 days of emails" },
  { value: "3m", label: "Last 3 months", desc: "~90 days of emails" },
  { value: "6m", label: "Last 6 months (recommended)", desc: "~180 days — best coverage" },
];

export function StepPicker({ value, onChange, onConfirm, loading }: StepPickerProps) {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-900">How far back should we scan?</h2>
        <p className="text-sm text-gray-500 mt-1">We&apos;ll look at email metadata only — no email bodies read yet.</p>
      </div>

      <div className="flex flex-col gap-3">
        {options.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={`flex items-center gap-4 p-4 rounded-xl border text-left transition-colors ${
              value === opt.value
                ? "border-[#5b7cfa] bg-[#f0f3ff]"
                : "border-gray-200 bg-white hover:border-gray-300"
            }`}
          >
            <div
              className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                value === opt.value ? "border-[#5b7cfa]" : "border-gray-300"
              }`}
            >
              {value === opt.value && <div className="w-2 h-2 rounded-full bg-[#5b7cfa]" />}
            </div>
            <div>
              <div className="text-sm font-medium text-gray-900">{opt.label}</div>
              <div className="text-xs text-gray-500">{opt.desc}</div>
            </div>
          </button>
        ))}
      </div>

      <button
        onClick={onConfirm}
        disabled={loading}
        className="w-full py-3 rounded-xl bg-[#5b7cfa] text-white text-sm font-medium hover:bg-[#4a6be8] transition-colors disabled:opacity-60"
      >
        {loading ? "Scanning..." : "Scan My Gmail"}
      </button>
    </div>
  );
}
