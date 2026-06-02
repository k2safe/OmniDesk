type UpdateProgressPanelProps = {
  downloaded: number;
  progress: number;
  total?: number;
};

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";

  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function UpdateProgressPanel({ downloaded, progress, total }: UpdateProgressPanelProps) {
  const hasTotal = typeof total === "number" && total > 0;
  const safeDownloaded = Math.max(0, downloaded);
  const safeProgress = Math.max(0, Math.min(100, progress));

  return (
    <div className="space-y-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-semibold text-emerald-700">正在下载更新</span>
        <span className="font-mono font-semibold text-emerald-700">{hasTotal ? `${safeProgress}%` : "下载中"}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-emerald-100">
        {hasTotal ? (
          <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${safeProgress}%` }} />
        ) : (
          <div className="update-progress-indeterminate h-full w-1/3 rounded-full bg-emerald-500" />
        )}
      </div>
      <div className="flex items-center justify-between gap-3 text-[11px] font-medium text-slate-500">
        <span>
          {hasTotal
            ? `${formatBytes(safeDownloaded)} / ${formatBytes(total)}`
            : safeDownloaded > 0
              ? `已下载 ${formatBytes(safeDownloaded)}`
              : "正在连接下载源..."}
        </span>
        <span>下载完成后会自动安装并重启</span>
      </div>
    </div>
  );
}
