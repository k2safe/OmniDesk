import { useEffect, useRef, useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { Check, Download, Keyboard, KeyRound, Lock, Monitor, Moon, Palette, Settings, Sun, Upload, X } from "lucide-react";
import { motion } from "motion/react";
import { exportWorkspaceArchive, importWorkspaceArchive, requireMasterPassword, saveEncryptedStoreItem, setGlobalShortcuts } from "../lib/desktop";
import type { AppPreferences, AppShortcuts, ThemeMode } from "../lib/store";
import { DEFAULT_SHORTCUTS } from "../lib/store";
import { checkForUpdate, downloadInstallAndRelaunch, formatUpdaterError, type UpdateProgress } from "../lib/updater";
import { OptionSelect } from "./OptionSelect";
import { UpdateProgressPanel } from "./UpdateProgressPanel";

interface CommonSettingsProps {
  preferences: AppPreferences;
  onPreferencesChange: (preferences: AppPreferences) => void;
  onClose: () => void;
  onOpenSecurity: () => void;
  onLock: () => void | Promise<void>;
}

const themeOptions: { value: ThemeMode; label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

const shortcutFields: { key: keyof AppShortcuts; label: string; hint: string }[] = [
  { key: "quickPanel", label: "唤起 Quick", hint: "打开快捷动作小窗" },
  { key: "screenshot", label: "截图", hint: "调用系统快捷键复制选区" },
  { key: "colorPicker", label: "取色", hint: "取鼠标位置颜色并复制 HEX" },
  { key: "localDrop", label: "快传", hint: "开启局域网临时上传链接" },
];

function themeIcon(themeMode: ThemeMode) {
  if (themeMode === "dark") return <Moon size={16} />;
  if (themeMode === "light") return <Sun size={16} />;
  return <Monitor size={16} />;
}

function shortcutSignature(shortcuts: AppShortcuts) {
  return `${shortcuts.quickPanel}|${shortcuts.screenshot}|${shortcuts.colorPicker}|${shortcuts.localDrop}`;
}

export function CommonSettings({
  preferences,
  onPreferencesChange,
  onClose,
  onOpenSecurity,
  onLock,
}: CommonSettingsProps) {
  const [status, setStatus] = useState("");
  const [isMigrating, setIsMigrating] = useState(false);
  const [shortcutDraft, setShortcutDraft] = useState<AppShortcuts>(preferences.shortcuts ?? DEFAULT_SHORTCUTS);
  const [shortcutStatus, setShortcutStatus] = useState("");
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [updateStatus, setUpdateStatus] = useState("");
  const [updateProgress, setUpdateProgress] = useState(0);
  const [updateTransfer, setUpdateTransfer] = useState<UpdateProgress>({ downloaded: 0 });
  const autoApplyTimer = useRef<number | null>(null);
  const lastAppliedShortcuts = useRef(shortcutSignature(preferences.shortcuts ?? DEFAULT_SHORTCUTS));

  useEffect(() => {
    const nextShortcuts = preferences.shortcuts ?? DEFAULT_SHORTCUTS;
    lastAppliedShortcuts.current = shortcutSignature(nextShortcuts);
    setShortcutDraft(nextShortcuts);
  }, [preferences.shortcuts]);

  const updateTheme = (themeMode: ThemeMode) => {
    onPreferencesChange({ ...preferences, themeMode });
  };

  const updateShortcutDraft = (key: keyof AppShortcuts, value: string) => {
    setShortcutDraft((prev) => ({ ...prev, [key]: value }));
  };

  const applyShortcuts = async (shortcuts = shortcutDraft, source: "manual" | "auto" = "manual") => {
    setShortcutStatus("");
    try {
      await setGlobalShortcuts([
        { action: "quickPanel", accelerator: shortcuts.quickPanel },
        { action: "screenshot", accelerator: shortcuts.screenshot },
        { action: "colorPicker", accelerator: shortcuts.colorPicker },
        { action: "localDrop", accelerator: shortcuts.localDrop },
      ]);
      const nextPreferences = { ...preferences, shortcuts };
      await saveEncryptedStoreItem("preferences", nextPreferences);
      lastAppliedShortcuts.current = shortcutSignature(shortcuts);
      onPreferencesChange(nextPreferences);
      setShortcutStatus(source === "auto"
        ? "快捷键已自动保存并注册。截图会调用系统快捷键复制选区；如果被拦截，请允许 OmniDesk 辅助功能权限。"
        : "快捷键已注册。截图会调用系统快捷键复制选区；如果被拦截，请在系统设置里允许 OmniDesk 辅助功能权限。");
    } catch (error) {
      setShortcutStatus(error instanceof Error ? error.message : "快捷键设置失败");
    }
  };

  useEffect(() => {
    const signature = shortcutSignature(shortcutDraft);
    if (signature === lastAppliedShortcuts.current) return;

    if (autoApplyTimer.current) window.clearTimeout(autoApplyTimer.current);
    autoApplyTimer.current = window.setTimeout(() => {
      void applyShortcuts(shortcutDraft, "auto");
    }, 650);

    return () => {
      if (autoApplyTimer.current) window.clearTimeout(autoApplyTimer.current);
    };
  }, [shortcutDraft]);

  const resetShortcuts = () => {
    setShortcutDraft(DEFAULT_SHORTCUTS);
    void applyShortcuts(DEFAULT_SHORTCUTS);
  };

  const handleCheckUpdate = async () => {
    setUpdateStatus("");
    setAvailableUpdate(null);
    setCheckingUpdate(true);
    setUpdateProgress(0);
    setUpdateTransfer({ downloaded: 0 });
    try {
      const update = await checkForUpdate();
      if (!update) {
        setUpdateStatus("当前已经是最新版本。");
        return;
      }

      setAvailableUpdate(update);
      setUpdateStatus(`发现新版本 ${update.version}${update.body ? `：${update.body}` : ""}`);
    } catch (error) {
      setUpdateStatus(`检查更新失败：${formatUpdaterError(error)}`);
    } finally {
      setCheckingUpdate(false);
    }
  };

  const handleInstallUpdate = async () => {
    if (!availableUpdate) return;
    setInstallingUpdate(true);
    setUpdateStatus("开始下载更新...");
    setUpdateProgress(0);
    setUpdateTransfer({ downloaded: 0 });
    try {
      await downloadInstallAndRelaunch(availableUpdate, ({ downloaded, total }) => {
        setUpdateTransfer({ downloaded, total });
        setUpdateProgress(total ? Math.max(0, Math.min(100, Math.round((downloaded / total) * 100))) : 0);
      });
    } catch (error) {
      setUpdateStatus(`更新安装失败：${formatUpdaterError(error)}`);
      setInstallingUpdate(false);
    }
  };

  const handleExportWorkspace = async () => {
    const verified = await requireMasterPassword("导出 OmniDesk 整个本地工作区");
    if (!verified) return;
    setStatus("");
    setIsMigrating(true);
    try {
      const result = await exportWorkspaceArchive();
      if (result.path) setStatus(`整包已导出：${result.path}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "整包导出失败");
    } finally {
      setIsMigrating(false);
    }
  };

  const handleImportWorkspace = async () => {
    const confirmed = window.confirm("整包导入只允许空项目执行。导入后会替换本地数据库和资源，并需要使用备份中的主密码登录。继续吗？");
    if (!confirmed) return;
    setStatus("");
    setIsMigrating(true);
    try {
      const result = await importWorkspaceArchive();
      if (!result.exported) {
        setStatus("已取消导入");
        return;
      }
      window.alert("整包导入完成，应用会重新加载。请使用备份中的主密码登录。");
      window.location.reload();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "整包导入失败");
    } finally {
      setIsMigrating(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/20 p-6 backdrop-blur-sm"
    >
      <motion.div
        initial={{ opacity: 0, y: 18, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 12, scale: 0.98 }}
        className="max-h-[calc(100vh-48px)] w-full max-w-2xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600">
              <Settings size={19} />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900">公共设置</h2>
              <p className="text-xs text-slate-400">主题、快捷键、迁移和安全入口</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-900"
            title="关闭"
          >
            <X size={18} />
          </button>
        </div>

        <div className="max-h-[calc(100vh-150px)] space-y-4 overflow-y-auto p-5">
          <section className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-900">
              <Palette size={16} className="text-emerald-600" />
              外观
            </div>
            <div className="grid gap-3">
              <label className="block">
                <span className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-slate-500">
                  {themeIcon(preferences.themeMode)}
                  主题
                </span>
                <OptionSelect value={preferences.themeMode} options={themeOptions} onChange={updateTheme} />
              </label>
            </div>
          </section>

          <section className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-900">
              <Keyboard size={16} className="text-emerald-600" />
              快捷键
            </div>
            <div className="grid gap-3">
              {shortcutFields.map((field) => (
                <label key={field.key} className="grid gap-1.5">
                  <span className="flex items-center justify-between gap-3 text-xs font-semibold text-slate-500">
                    <span>{field.label}</span>
                    <span className="font-medium text-slate-400">{field.hint}</span>
                  </span>
                  <input
                    value={shortcutDraft[field.key]}
                    onChange={(event) => updateShortcutDraft(field.key, event.target.value)}
                    className="h-10 rounded-lg border border-slate-200 bg-white px-3 font-mono text-sm font-semibold text-slate-800 outline-none transition-all placeholder:text-slate-400 focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10"
                    placeholder={DEFAULT_SHORTCUTS[field.key]}
                  />
                </label>
              ))}
            </div>
            <div className="mt-3 flex items-center justify-between gap-2">
              <div className="text-xs font-medium text-slate-400">
                格式示例：Option+Space、Option+Shift+S、Command+Shift+C。取色授权后要重启应用。
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  onClick={resetShortcuts}
                  className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-500 transition-colors hover:bg-slate-50"
                >
                  默认
                </button>
                <button
                  type="button"
                  onClick={() => void applyShortcuts()}
                  className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700 transition-colors hover:bg-emerald-100"
                >
                  应用
                </button>
              </div>
            </div>
            {shortcutStatus && (
              <div className="mt-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-500">
                {shortcutStatus}
              </div>
            )}
          </section>

          <section className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="mb-3 text-sm font-bold text-slate-900">整包迁移</div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={handleExportWorkspace}
                disabled={isMigrating}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-700 transition-colors hover:bg-emerald-100 disabled:opacity-60"
              >
                <Download size={16} />
                导出整包
              </button>
              <button
                type="button"
                onClick={handleImportWorkspace}
                disabled={isMigrating}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-60"
              >
                <Upload size={16} />
                空项目导入
              </button>
            </div>
            {status && (
              <div className="mt-3 break-all rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-500">
                {status}
              </div>
            )}
          </section>

          <section className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-bold text-slate-900">桌面自动升级</div>
                <div className="mt-1 text-xs font-medium text-slate-400">通过 GitHub Release 获取签名更新包。</div>
              </div>
              {availableUpdate && (
                <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">
                  v{availableUpdate.version}
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={handleCheckUpdate}
                disabled={checkingUpdate || installingUpdate}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-60"
              >
                <Download size={16} />
                {checkingUpdate ? "检查中..." : "检查更新"}
              </button>
              <button
                type="button"
                onClick={handleInstallUpdate}
                disabled={!availableUpdate || installingUpdate}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-700 transition-colors hover:bg-emerald-100 disabled:opacity-50"
              >
                <Check size={16} />
                {installingUpdate ? "安装中..." : "下载安装"}
              </button>
            </div>
            {installingUpdate && (
              <div className="mt-3">
                <UpdateProgressPanel
                  downloaded={updateTransfer.downloaded}
                  progress={updateProgress}
                  total={updateTransfer.total}
                />
              </div>
            )}
            {updateStatus && (
              <div className="mt-3 break-all rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-500">
                {updateStatus}
              </div>
            )}
          </section>

          <section className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => {
                onClose();
                onOpenSecurity();
              }}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-600 transition-colors hover:bg-slate-50"
            >
              <KeyRound size={16} />
              主密码设置
            </button>
            <button
              type="button"
              onClick={() => {
                onClose();
                void onLock();
              }}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-red-100 bg-red-50 px-4 py-2.5 text-sm font-semibold text-red-600 transition-colors hover:bg-red-100"
            >
              <Lock size={16} />
              锁定系统
            </button>
          </section>

          <div className="flex items-center gap-2 rounded-xl border border-emerald-100 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700">
            <Check size={15} />
            默认跟随 macOS 外观，系统切到暗黑模式后会自动同步。
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
