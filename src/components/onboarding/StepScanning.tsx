"use client";

type StepScanningProps = {
  emailCount: number;
};

export function StepScanning({ emailCount }: StepScanningProps) {
  return (
    <div className="flex flex-col items-center gap-6 py-8">
      <div className="w-12 h-12 rounded-full border-4 border-[#e8ecf8] border-t-[#5b7cfa] animate-spin" />
      <div className="text-center">
        <h2 className="text-xl font-semibold text-gray-900">Scanning your Gmail</h2>
        <p className="text-sm text-gray-500 mt-1">Reading email metadata only — no email content accessed yet.</p>
      </div>
      {emailCount > 0 && (
        <div className="bg-[#f0f3ff] px-6 py-3 rounded-xl">
          <span className="text-2xl font-semibold text-[#5b7cfa]">{emailCount.toLocaleString()}</span>
          <span className="text-sm text-gray-600 ml-2">emails scanned</span>
        </div>
      )}
    </div>
  );
}
