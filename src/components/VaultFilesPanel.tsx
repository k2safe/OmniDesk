import { DragEvent, useRef, useState } from "react";
import { Check, Download, FileLock2, FolderOpen, Trash2, Upload } from "lucide-react";
import { deleteVaultFile, exportVaultFile, requireMasterPassword, saveVaultFile } from "../lib/desktop";
import { useStoreField } from "../lib/store";
import { cn } from "../lib/utils";

function readFileAsBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.includes(",") ? result.slice(result.indexOf(",") + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function VaultFilesPanel() {
  const [files, setFiles] = useStoreField("fileVault");
  const [isDragging, setIsDragging] = useState(false);
  const [status, setStatus] = useState("");
  const [busyId, setBusyId] = useState("");
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  const filteredFiles = files.filter((file) => file.fileName.toLowerCase().includes(search.trim().toLowerCase()));

  const importFiles = async (incomingFiles: File[]) => {
    if (incomingFiles.length === 0) return;
    setStatus("正在加密...");
    try {
      const savedFiles = [];
      for (const file of incomingFiles) {
        const bytesBase64 = await readFileAsBase64(file);
        savedFiles.push(await saveVaultFile(file.name, bytesBase64));
      }
      setFiles((prev) => [...savedFiles, ...prev]);
      setStatus(`已加密 ${savedFiles.length} 个文件`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    void importFiles(Array.from(event.dataTransfer.files));
  };

  const handleExport = async (entryId: string, encryptedFileName: string, fileName: string) => {
    const verified = await requireMasterPassword("导出并解密保险箱文件");
    if (!verified) return;
    setBusyId(entryId);
    try {
      const result = await exportVaultFile(encryptedFileName, fileName);
      if (result.exported) {
        setStatus(`已导出 ${result.fileName}`);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "导出失败");
    } finally {
      setBusyId("");
    }
  };

  const handleDelete = async (entryId: string, encryptedFileName: string) => {
    const verified = await requireMasterPassword("删除保险箱加密文件");
    if (!verified) return;
    setBusyId(entryId);
    try {
      await deleteVaultFile(encryptedFileName);
      setFiles((prev) => prev.filter((file) => file.id !== entryId));
    } finally {
      setBusyId("");
    }
  };

  return (
    <div className="grid grid-cols-1 gap-6">
      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex items-center gap-2 font-medium text-slate-900">
              <FileLock2 size={18} className="text-emerald-600" />
              加密文件
            </div>
            <p className="mt-1 text-sm text-slate-400">拖入私密文件后会本地加密保存，导出前需要主密码二次验证。</p>
          </div>
          <button
            onClick={() => inputRef.current?.click()}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-600"
          >
            <Upload size={16} /> 添加文件
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              void importFiles(Array.from(event.target.files ?? []));
              event.currentTarget.value = "";
            }}
          />
        </div>

        <div
          onDragOver={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          className={cn(
            "flex min-h-44 flex-col items-center justify-center rounded-2xl border border-dashed bg-slate-50 p-8 text-center transition-colors",
            isDragging ? "border-emerald-400 bg-emerald-50" : "border-slate-200",
          )}
        >
          <FileLock2 size={40} className="mb-4 text-emerald-600" />
          <div className="text-lg font-semibold text-slate-900">拖拽文件到保险箱</div>
          <div className="mt-2 text-sm text-slate-400">单个文件最多 100MB，文件内容不会明文落盘。</div>
          {status && (
            <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-emerald-100 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-700">
              <Check size={14} /> {status}
            </div>
          )}
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 font-medium text-slate-900">
            <FolderOpen size={18} className="text-emerald-600" />
            文件列表
          </div>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索文件名..."
            className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-700 outline-none transition-all placeholder:text-slate-400 focus:border-emerald-500 focus:bg-white sm:w-64"
          />
        </div>

        <div className="grid gap-3">
          {filteredFiles.map((file) => (
            <div key={file.id} className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
                  <FolderOpen size={19} />
                </div>
                <div className="min-w-0">
                  <div className="truncate font-semibold text-slate-900">{file.fileName}</div>
                  <div className="mt-1 text-xs text-slate-400">
                    {formatBytes(file.size)} · {new Date(file.createdAt).toLocaleString("zh-CN")}
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  onClick={() => handleExport(file.id, file.encryptedFileName, file.fileName)}
                  disabled={busyId === file.id}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900 disabled:opacity-50"
                >
                  <Download size={15} /> 导出
                </button>
                <button
                  onClick={() => handleDelete(file.id, file.encryptedFileName)}
                  disabled={busyId === file.id}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-red-50 hover:text-red-500 disabled:opacity-50"
                  title="删除"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}

          {files.length > 0 && filteredFiles.length === 0 && (
            <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 py-14 text-center text-sm font-medium text-slate-400">
              未找到匹配的文件
            </div>
          )}

          {files.length === 0 && (
            <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 py-14 text-center text-sm font-medium text-slate-400">
              暂无加密文件
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
