import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { Check, Clock3, Download, Keyboard, KeyRound, Lock, Monitor, Moon, Palette, Settings, Sun, Upload, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { motion } from "motion/react";
import { exportWorkspaceArchive, importWorkspaceArchive, requireMasterPassword, saveEncryptedStoreItem, setGlobalShortcuts } from "../lib/desktop";
import type { AppPreferences, AppShortcuts, AutoLockUnit, ThemeMode } from "../lib/store";
import { DEFAULT_AUTO_LOCK, DEFAULT_SHORTCUTS, normalizeAutoLockPreferences } from "../lib/store";
import { checkForUpdate, downloadInstallAndRelaunch, formatUpdaterError, getCurrentAppVersion, type UpdateProgress } from "../lib/updater";
import { cn } from "../lib/utils";
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

const autoLockUnitOptions: { value: AutoLockUnit; label: string }[] = [
  { value: "second", label: "秒" },
  { value: "minute", label: "分钟" },
  { value: "hour", label: "小时" },
];

const autoLockUnitLabels: Record<AutoLockUnit, string> = {
  second: "秒",
  minute: "分钟",
  hour: "小时",
};

const autoLockMaxByUnit: Record<AutoLockUnit, number> = {
  second: 86_400,
  minute: 1_440,
  hour: 24,
};

const shortcutFields: { key: keyof AppShortcuts; label: string; hint: string }[] = [
  { key: "quickPanel", label: "唤起 Quick", hint: "打开快捷动作小窗" },
  { key: "screenshot", label: "截图", hint: "调用系统快捷键复制选区" },
  { key: "colorPicker", label: "取色", hint: "取鼠标位置颜色并复制 HEX" },
  { key: "localDrop", label: "快传", hint: "开启局域网临时上传链接" },
];

const settingSections: { id: SettingSectionId; label: string; description: string; icon: LucideIcon }[] = [
  { id: "appearance", label: "外观", description: "主题与显示", icon: Palette },
  { id: "shortcuts", label: "快捷键", description: "全局动作", icon: Keyboard },
  { id: "migration", label: "迁移", description: "整包导入导出", icon: Upload },
  { id: "updates", label: "升级", description: "桌面自动更新", icon: Download },
  { id: "security", label: "安全", description: "主密码与锁屏", icon: KeyRound },
];

type SettingSectionId = "appearance" | "shortcuts" | "migration" | "updates" | "security";

const modifierNames = new Set(["command", "cmd", "meta", "option", "opt", "alt", "shift", "control", "ctrl", "⌘", "⌥", "⇧", "⌃"]);

function themeIcon(themeMode: ThemeMode) {
  if (themeMode === "dark") return <Moon size={16} />;
  if (themeMode === "light") return <Sun size={16} />;
  return <Monitor size={16} />;
}

function shortcutSignature(shortcuts: AppShortcuts) {
  return `${shortcuts.quickPanel}|${shortcuts.screenshot}|${shortcuts.colorPicker}|${shortcuts.localDrop}`;
}

function hasShortcutMainKey(accelerator: string) {
  const parts = accelerator
    .split("+")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length < 2) return false;
  const mainKey = parts.at(-1);
  return Boolean(mainKey && !modifierNames.has(mainKey));
}

function normalizeShortcutMainKey(event: ReactKeyboardEvent<HTMLElement>) {
  const key = event.key;
  const code = event.code;

  if (key === "Meta" || key === "Control" || key === "Alt" || key === "Shift" || key === "OS") return "";
  if (code.startsWith("Key")) return code.slice(3).toUpperCase();
  if (code.startsWith("Digit")) return code.slice(5);

  const specialKeyMap: Record<string, string> = {
    " ": "Space",
    Spacebar: "Space",
    Enter: "Enter",
    Return: "Enter",
    Escape: "Escape",
    Esc: "Escape",
    Backspace: "Backspace",
    Delete: "Delete",
    Tab: "Tab",
    Minus: "Minus",
    Equal: "Equal",
    BracketLeft: "BracketLeft",
    BracketRight: "BracketRight",
    Backslash: "Backslash",
    Semicolon: "Semicolon",
    Quote: "Quote",
    Comma: "Comma",
    Period: "Period",
    Slash: "Slash",
  };

  if (specialKeyMap[key]) return specialKeyMap[key];
  if (specialKeyMap[code]) return specialKeyMap[code];
  if (key.length === 1) return key.toUpperCase();
  return "";
}

function shortcutFromKeyboardEvent(event: ReactKeyboardEvent<HTMLElement>) {
  const parts: string[] = [];
  if (event.metaKey || event.key === "Meta") parts.push("Command");
  if (event.ctrlKey || event.key === "Control") parts.push("Control");
  if (event.altKey || event.key === "Alt") parts.push("Option");
  if (event.shiftKey || event.key === "Shift") parts.push("Shift");

  const mainKey = normalizeShortcutMainKey(event);
  if (mainKey) parts.push(mainKey);

  return parts.join("+");
}

function ShortcutCaptureField({
  value,
  placeholder,
  onChange,
}: {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const [isCapturing, setIsCapturing] = useState(false);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const nextShortcut = shortcutFromKeyboardEvent(event);
    if (nextShortcut) onChange(nextShortcut);
  };

  return (
    <button
      type="button"
      onFocus={() => setIsCapturing(true)}
      onBlur={() => setIsCapturing(false)}
      onKeyDown={handleKeyDown}
      className={cn(
        "flex h-12 w-full items-center justify-between rounded-xl border bg-white px-4 text-left font-mono text-sm font-bold text-slate-900 outline-none transition-all",
        isCapturing
          ? "border-emerald-500 ring-4 ring-emerald-500/10"
          : "border-slate-200 hover:border-slate-300 hover:bg-slate-50",
      )}
    >
      <span className={cn("truncate", !value && "text-slate-400")}>{value || placeholder}</span>
      <span className={cn("ml-3 shrink-0 rounded-full px-2 py-1 text-[11px] font-semibold", isCapturing ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-400")}>
        {isCapturing ? "按键中" : "点击录入"}
      </span>
    </button>
  );
}

export function CommonSettings({
  preferences,
  onPreferencesChange,
  onClose,
  onOpenSecurity,
  onLock,
}: CommonSettingsProps) {
  const [status, setStatus] = useState("");
  const [activeSection, setActiveSection] = useState<SettingSectionId>("appearance");
  const [isMigrating, setIsMigrating] = useState(false);
  const [autoLockValueDraft, setAutoLockValueDraft] = useState(String(preferences.autoLock?.value ?? DEFAULT_AUTO_LOCK.value));
  const [shortcutDraft, setShortcutDraft] = useState<AppShortcuts>(preferences.shortcuts ?? DEFAULT_SHORTCUTS);
  const [shortcutStatus, setShortcutStatus] = useState("");
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [updateStatus, setUpdateStatus] = useState("");
  const [updateProgress, setUpdateProgress] = useState(0);
  const [updateTransfer, setUpdateTransfer] = useState<UpdateProgress>({ downloaded: 0 });
  const [currentVersion, setCurrentVersion] = useState("");
  const autoApplyTimer = useRef<number | null>(null);
  const lastAppliedShortcuts = useRef(shortcutSignature(preferences.shortcuts ?? DEFAULT_SHORTCUTS));
  const autoLock = normalizeAutoLockPreferences(preferences.autoLock);

  useEffect(() => {
    const nextShortcuts = preferences.shortcuts ?? DEFAULT_SHORTCUTS;
    lastAppliedShortcuts.current = shortcutSignature(nextShortcuts);
    setShortcutDraft(nextShortcuts);
  }, [preferences.shortcuts]);

  useEffect(() => {
    setAutoLockValueDraft(String(autoLock.value));
  }, [autoLock.value, autoLock.unit]);

  useEffect(() => {
    void getCurrentAppVersion()
      .then(setCurrentVersion)
      .catch(() => setCurrentVersion(""));
  }, []);

  const updateTheme = (themeMode: ThemeMode) => {
    onPreferencesChange({ ...preferences, themeMode });
  };

  const commitAutoLock = (value: string, unit = autoLock.unit) => {
    const nextAutoLock = normalizeAutoLockPreferences({ value, unit });
    setAutoLockValueDraft(String(nextAutoLock.value));
    onPreferencesChange({ ...preferences, autoLock: nextAutoLock });
  };

  const updateAutoLockUnit = (unit: AutoLockUnit) => {
    commitAutoLock(autoLockValueDraft, unit);
  };

  const updateShortcutDraft = (key: keyof AppShortcuts, value: string) => {
    setShortcutDraft((prev) => ({ ...prev, [key]: value }));
    if (value && !hasShortcutMainKey(value)) {
      setShortcutStatus(`已捕获 ${value}，继续按一个主键完成组合，例如 ${value}+Space。`);
    } else {
      setShortcutStatus("");
    }
  };

  const applyShortcuts = async (shortcuts = shortcutDraft, source: "manual" | "auto" = "manual") => {
    setShortcutStatus("");
    const invalidShortcut = shortcutFields.find((field) => !hasShortcutMainKey(shortcuts[field.key]));
    if (invalidShortcut) {
      setShortcutStatus(`${invalidShortcut.label} 需要“修饰键 + 主键”，例如 Option+Space。`);
      return;
    }
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
    const allShortcutsReady = shortcutFields.every((field) => hasShortcutMainKey(shortcutDraft[field.key]));
    if (!allShortcutsReady) return;

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

  const installUpdate = async (update: Update) => {
    setInstallingUpdate(true);
    setUpdateStatus(`发现新版本 v${update.version}，正在下载安装...`);
    setUpdateProgress(0);
    setUpdateTransfer({ downloaded: 0 });

    await downloadInstallAndRelaunch(update, ({ downloaded, total }) => {
      setUpdateTransfer({ downloaded, total });
      setUpdateProgress(total ? Math.max(0, Math.min(100, Math.round((downloaded / total) * 100))) : 0);
    });
  };

  const handleCheckUpdate = async () => {
    let reachedInstall = false;
    setUpdateStatus("");
    setAvailableUpdate(null);
    setCheckingUpdate(true);
    setInstallingUpdate(false);
    setUpdateProgress(0);
    setUpdateTransfer({ downloaded: 0 });
    try {
      const update = await checkForUpdate();
      if (!update) {
        setUpdateStatus(currentVersion ? `当前已经是最新版本 v${currentVersion}。` : "当前已经是最新版本。");
        return;
      }

      setAvailableUpdate(update);
      setCheckingUpdate(false);
      reachedInstall = true;
      await installUpdate(update);
    } catch (error) {
      setUpdateStatus(`${reachedInstall ? "更新安装失败" : "检查更新失败"}：${formatUpdaterError(error)}`);
      setInstallingUpdate(false);
    } finally {
      setCheckingUpdate(false);
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
        className="max-h-[calc(100vh-48px)] w-full max-w-5xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
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

        <div className="grid max-h-[calc(100vh-150px)] min-h-[520px] grid-cols-[210px_minmax(0,1fr)] overflow-hidden">
          <aside className="border-r border-slate-200 bg-slate-50/70 p-4">
            <div className="space-y-2">
              {settingSections.map((section) => {
                const Icon = section.icon;
                const selected = activeSection === section.id;
                return (
                  <button
                    key={section.id}
                    type="button"
                    onClick={() => setActiveSection(section.id)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left transition-all",
                      selected
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700 shadow-sm"
                        : "border-transparent text-slate-500 hover:border-slate-200 hover:bg-white hover:text-slate-900",
                    )}
                  >
                    <Icon size={17} className="shrink-0" />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-bold">{section.label}</span>
                      <span className="block truncate text-[11px] font-semibold opacity-70">{section.description}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>

          <div className="min-h-0 overflow-y-auto p-5">
            {activeSection === "appearance" && (
              <section className="space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2 text-base font-bold text-slate-900">
                      <Palette size={18} className="text-emerald-600" />
                      外观
                    </div>
                    <div className="mt-1 text-xs font-semibold text-slate-400">系统主题和显示偏好</div>
                  </div>
                </div>

                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <label className="grid grid-cols-[160px_minmax(0,1fr)] items-center gap-4">
                    <span className="flex items-center gap-2 text-sm font-bold text-slate-700">
                      {themeIcon(preferences.themeMode)}
                      主题
                    </span>
                    <OptionSelect value={preferences.themeMode} options={themeOptions} onChange={updateTheme} />
                  </label>
                </div>

                <div className="flex items-center gap-2 rounded-xl border border-emerald-100 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700">
                  <Check size={15} />
                  默认跟随 macOS 外观，系统切到暗黑模式后会自动同步。
                </div>
              </section>
            )}

            {activeSection === "shortcuts" && (
              <section className="space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2 text-base font-bold text-slate-900">
                      <Keyboard size={18} className="text-emerald-600" />
                      快捷键
                    </div>
                    <div className="mt-1 text-xs font-semibold text-slate-400">点击输入框后直接按键即可录入</div>
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

                <div className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
                  {shortcutFields.map((field) => (
                    <div key={field.key} className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-4 p-4">
                      <div>
                        <div className="text-sm font-bold text-slate-900">{field.label}</div>
                        <div className="mt-1 text-xs font-semibold text-slate-400">{field.hint}</div>
                      </div>
                      <ShortcutCaptureField
                        value={shortcutDraft[field.key]}
                        placeholder={DEFAULT_SHORTCUTS[field.key]}
                        onChange={(value) => updateShortcutDraft(field.key, value)}
                      />
                    </div>
                  ))}
                </div>

                <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-400">
                  支持直接按 Option、Command、Shift、Control 捕获修饰键；注册全局快捷键时需要补一个主键，例如 Option+Space。
                </div>

                {shortcutStatus && (
                  <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-500">
                    {shortcutStatus}
                  </div>
                )}
              </section>
            )}

            {activeSection === "migration" && (
              <section className="space-y-4">
                <div>
                  <div className="flex items-center gap-2 text-base font-bold text-slate-900">
                    <Upload size={18} className="text-emerald-600" />
                    整包迁移
                  </div>
                  <div className="mt-1 text-xs font-semibold text-slate-400">本地数据库和资源文件一并迁移</div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={handleExportWorkspace}
                    disabled={isMigrating}
                    className="inline-flex h-24 flex-col items-center justify-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 text-sm font-bold text-emerald-700 transition-colors hover:bg-emerald-100 disabled:opacity-60"
                  >
                    <Download size={18} />
                    导出整包
                  </button>
                  <button
                    type="button"
                    onClick={handleImportWorkspace}
                    disabled={isMigrating}
                    className="inline-flex h-24 flex-col items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-60"
                  >
                    <Upload size={18} />
                    空项目导入
                  </button>
                </div>

                {status && (
                  <div className="break-all rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-500">
                    {status}
                  </div>
                )}
              </section>
            )}

            {activeSection === "updates" && (
              <section className="space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 text-base font-bold text-slate-900">
                      <Download size={18} className="text-emerald-600" />
                      桌面自动升级
                    </div>
                    <div className="mt-1 text-xs font-semibold text-slate-400">发现新版本后自动下载安装并重启</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {currentVersion && (
                      <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-500">
                        当前 v{currentVersion}
                      </span>
                    )}
                    {availableUpdate && (
                      <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">
                        新版 v{availableUpdate.version}
                      </span>
                    )}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleCheckUpdate}
                  disabled={checkingUpdate || installingUpdate}
                  className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 text-sm font-bold text-emerald-700 transition-colors hover:bg-emerald-100 disabled:opacity-60"
                >
                  <Download size={17} />
                  {checkingUpdate ? "检查中..." : installingUpdate ? "下载安装中..." : "检查并自动升级"}
                </button>

                {(checkingUpdate || installingUpdate) && (
                  <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-500">
                    {checkingUpdate ? "正在检查最新版本..." : "下载完成后会自动安装并重启。"}
                  </div>
                )}
                {installingUpdate && (
                  <UpdateProgressPanel
                    downloaded={updateTransfer.downloaded}
                    progress={updateProgress}
                    total={updateTransfer.total}
                  />
                )}
                {updateStatus && (
                  <div className="break-all rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-500">
                    {updateStatus}
                  </div>
                )}
              </section>
            )}

            {activeSection === "security" && (
              <section className="space-y-4">
                <div>
                  <div className="flex items-center gap-2 text-base font-bold text-slate-900">
                    <KeyRound size={18} className="text-emerald-600" />
                    安全
                  </div>
                  <div className="mt-1 text-xs font-semibold text-slate-400">主密码和锁屏入口</div>
                </div>

                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <div className="mb-4 flex items-start justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2 text-sm font-bold text-slate-900">
                        <Clock3 size={17} className="text-emerald-600" />
                        自动锁屏
                      </div>
                      <div className="mt-1 text-xs font-semibold text-slate-400">超过设定时长无操作后自动锁定，解锁需要主密码。</div>
                    </div>
                    <span className="shrink-0 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700">
                      {autoLock.value} {autoLockUnitLabels[autoLock.unit]}
                    </span>
                  </div>

                  <div className="grid grid-cols-[minmax(0,1fr)_170px] gap-3">
                    <label className="block">
                      <span className="mb-2 block text-xs font-bold text-slate-500">时长</span>
                      <input
                        type="number"
                        min={1}
                        max={autoLockMaxByUnit[autoLock.unit]}
                        step={1}
                        value={autoLockValueDraft}
                        onChange={(event) => setAutoLockValueDraft(event.target.value)}
                        onBlur={() => commitAutoLock(autoLockValueDraft)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                        }}
                        className="h-12 w-full rounded-xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-900 outline-none transition-all focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-2 block text-xs font-bold text-slate-500">单位</span>
                      <OptionSelect value={autoLock.unit} options={autoLockUnitOptions} onChange={updateAutoLockUnit} />
                    </label>
                  </div>

                  <div className="mt-3 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-500">
                    当前策略：无操作 {autoLock.value} {autoLockUnitLabels[autoLock.unit]} 后自动回到锁屏页。
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      onOpenSecurity();
                    }}
                    className="inline-flex h-24 flex-col items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-600 transition-colors hover:bg-slate-50"
                  >
                    <KeyRound size={18} />
                    主密码设置
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      void onLock();
                    }}
                    className="inline-flex h-24 flex-col items-center justify-center gap-2 rounded-xl border border-red-100 bg-red-50 px-4 text-sm font-bold text-red-600 transition-colors hover:bg-red-100"
                  >
                    <Lock size={18} />
                    锁定系统
                  </button>
                </div>
              </section>
            )}
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
