import { useEffect, useRef, useState } from "react";
import { CheckCircle2, X } from "lucide-react";
import { EXPORT_RESULT_EVENT, type ExportResult } from "../lib/desktop";

export function ExportNotice() {
  const [result, setResult] = useState<ExportResult | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const handleExportResult = (event: Event) => {
      const detail = (event as CustomEvent<ExportResult>).detail;
      if (!detail?.exported) return;
      setResult(detail);
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setResult(null), 4500);
    };

    window.addEventListener(EXPORT_RESULT_EVENT, handleExportResult);
    return () => {
      window.removeEventListener(EXPORT_RESULT_EVENT, handleExportResult);
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, []);

  if (!result) return null;

  return (
    <div className="fixed right-6 top-16 z-[95] w-[min(420px,calc(100vw-48px))] rounded-2xl border border-emerald-200 bg-white p-4 text-slate-900 shadow-2xl">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600">
          <CheckCircle2 size={19} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold">导出完成</div>
          <div className="mt-1 truncate text-sm font-semibold text-slate-600">{result.fileName}</div>
          {result.path && <div className="mt-1 break-all text-xs font-medium text-slate-400">{result.path}</div>}
        </div>
        <button
          type="button"
          onClick={() => setResult(null)}
          className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-900"
          title="关闭"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
