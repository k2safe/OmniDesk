import { useState, useEffect, useRef, type PointerEvent, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { View } from "./types";
import { Dock } from "./components/Dock";
import { LockScreen } from "./components/LockScreen";
import { KeyVault } from "./views/KeyVault";
import { Notes } from "./views/Notes";
import { DevTools } from "./views/DevTools";
import { Pomodoro } from "./views/Pomodoro";
import { Bookmarks } from "./views/Bookmarks";
import { TOTPView } from "./views/TOTP";
import { Snippets } from "./views/Snippets";
import { Subscriptions } from "./views/Subscriptions";
import { AnimatePresence } from "motion/react";
import { Launcher } from "./components/Launcher";
import { SecuritySettings } from "./components/SecuritySettings";
import { CommonSettings } from "./components/CommonSettings";
import { ExportNotice } from "./components/ExportNotice";
import { MasterPasswordPrompt, type MasterPasswordRequest } from "./components/MasterPasswordPrompt";
import { getSystemIdleMillis, isDesktopRuntime, lockWorkspace, setGlobalShortcuts, setMasterPasswordRequestHandler, startWindowDrag, toggleQuickPanel } from "./lib/desktop";
import { OmniStoreProvider, autoLockToMilliseconds, saveOmniStore, unlockAndLoadOmniStore, useOmniStore, useStoreField } from "./lib/store";
import type { OmniStore, ThemeMode } from "./lib/store";


function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  });
}

export default function App() {
  const [isLocked, setIsLocked] = useState(true);
  const [store, setStore] = useState<OmniStore | null>(null);
  const [unlockError, setUnlockError] = useState("");

  useThemePreference("system", isLocked);

  const handleUnlock = async (password: string) => {
    try {
      setUnlockError("");
      const loadedStore = await withTimeout(
        unlockAndLoadOmniStore(password),
        30_000,
        "解锁或加载本地数据超时，请重启 OmniDesk 后再试",
      );
      setStore(loadedStore);
      setIsLocked(false);
    } catch (error) {
      setUnlockError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  };

  const handleLock = async () => {
    setIsLocked(true);
    setStore(null);
    await lockWorkspace().catch((error) => console.error("Failed to lock workspace", error));
  };


  if (isLocked) {
    return (
      <DesktopShell>
        <LockScreen onUnlock={handleUnlock} unlockError={unlockError} />
      </DesktopShell>
    );
  }

  if (!store) {
    return (
      <DesktopShell>
        <div className="flex h-full items-center justify-center bg-slate-50 text-sm font-medium text-slate-400">
          正在加载本地加密工作区...
        </div>
      </DesktopShell>
    );
  }

  return (
    <DesktopShell>
      <OmniStoreProvider initialStore={store}>
        <Workspace onLock={handleLock} />
      </OmniStoreProvider>
    </DesktopShell>
  );
}

function useAutoLock(timeoutMs: number, onLock: () => Promise<void>) {
  const onLockRef = useRef(onLock);

  useEffect(() => {
    onLockRef.current = onLock;
  }, [onLock]);

  useEffect(() => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return;

    const idleLimit = Math.max(1_000, timeoutMs);
    const checkInterval = Math.min(15_000, Math.max(1_000, Math.floor(idleLimit / 4)));
    let localLastActivity = Date.now();
    let isLocking = false;

    const checkIdle = async (fallbackIdleOverride?: number) => {
      if (isLocking) return false;

      const systemIdleMillis = await getSystemIdleMillis();
      const fallbackIdleMillis = fallbackIdleOverride ?? Date.now() - localLastActivity;
      const idleMillis = systemIdleMillis ?? fallbackIdleMillis;

      if (idleMillis >= idleLimit) {
        isLocking = true;
        await onLockRef.current();
        return true;
      }

      return false;
    };

    const markActivity = () => {
      const idleBeforeActivity = Date.now() - localLastActivity;
      localLastActivity = Date.now();
      if (idleBeforeActivity >= idleLimit) {
        void checkIdle(idleBeforeActivity);
      }
    };

    const checkResumeIdle = () => {
      void checkIdle();
    };

    const events = ["pointerdown", "keydown", "wheel", "touchstart", "mousemove"];
    events.forEach((event) => window.addEventListener(event, markActivity, { passive: true, capture: true }));
    window.addEventListener("focus", checkResumeIdle);
    document.addEventListener("visibilitychange", checkResumeIdle);
    const interval = window.setInterval(checkIdle, checkInterval);

    return () => {
      events.forEach((event) => window.removeEventListener(event, markActivity, { capture: true }));
      window.removeEventListener("focus", checkResumeIdle);
      document.removeEventListener("visibilitychange", checkResumeIdle);
      window.clearInterval(interval);
    };
  }, [timeoutMs]);
}

function useThemePreference(themeMode: ThemeMode, enabled = true) {
  useEffect(() => {
    if (!enabled) return;

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const resolvedTheme = themeMode === "system" ? (media.matches ? "dark" : "light") : themeMode;
      document.documentElement.dataset.theme = resolvedTheme;
      document.documentElement.style.colorScheme = resolvedTheme;
    };

    applyTheme();
    if (themeMode !== "system") return;
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [enabled, themeMode]);
}

function DesktopShell({ children }: { children: ReactNode }) {
  const showDesktopTitleBar = isDesktopRuntime();

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-slate-50 font-sans">
      {showDesktopTitleBar && <DesktopTitleBar />}
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      <HotkeyNotice />
    </div>
  );
}

function HotkeyNotice() {
  const [message, setMessage] = useState("");
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<string>("omnidesk-hotkey-status", (event) => {
      setMessage(event.payload);
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setMessage(""), 4500);
    })
      .then((dispose) => {
        unlisten = dispose;
      })
      .catch((error) => console.error("Failed to listen hotkey status", error));

    return () => {
      unlisten?.();
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, []);

  if (!message) return null;

  return (
    <div className="fixed right-5 top-14 z-[100] max-w-[min(460px,calc(100vw-40px))] rounded-xl border border-emerald-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-2xl dark:border-emerald-500/40 dark:bg-slate-900 dark:text-slate-100">
      {message}
    </div>
  );
}

function DesktopTitleBar() {
  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    void startWindowDrag().catch((error) => console.error("Failed to start window drag", error));
  };

  return (
    <div
      data-tauri-drag-region
      onPointerDown={handlePointerDown}
      className="relative z-30 flex h-11 shrink-0 items-center justify-center bg-gradient-to-r from-emerald-50 via-white to-teal-50 text-slate-500"
    >
      <div
        data-tauri-drag-region
        className="pointer-events-none select-none text-[13px] font-bold tracking-wide text-emerald-700/90"
      >
        OmniDesk
      </div>
    </div>
  );
}

function Workspace({ onLock }: { onLock: () => void | Promise<void> }) {
  const { store } = useOmniStore();
  const [pinnedViews, setPinnedViews] = useStoreField("pinnedViews");
  const [currentView, setCurrentView] = useStoreField("currentView");
  const [preferences, setPreferences] = useStoreField("preferences");
  const [isLauncherOpen, setIsLauncherOpen] = useState(false);
  const [isSecurityOpen, setIsSecurityOpen] = useState(false);
  const [isCommonSettingsOpen, setIsCommonSettingsOpen] = useState(false);
  const [masterPasswordRequest, setMasterPasswordRequest] = useState<MasterPasswordRequest | null>(null);

  useThemePreference(preferences.themeMode);

  useEffect(() => {
    const shortcuts = preferences.shortcuts;
    void setGlobalShortcuts([
      { action: "quickPanel", accelerator: shortcuts.quickPanel },
      { action: "screenshot", accelerator: shortcuts.screenshot },
      { action: "colorPicker", accelerator: shortcuts.colorPicker },
      { action: "localDrop", accelerator: shortcuts.localDrop },
    ]).catch((error) => {
      console.error("Failed to apply global shortcuts", error);
    });
  }, [preferences.shortcuts]);

  useEffect(() => {
    setMasterPasswordRequestHandler((reason) => {
      return new Promise<boolean>((resolve) => {
        setMasterPasswordRequest({
          id: Date.now(),
          reason,
          resolve,
        });
      });
    });

    return () => setMasterPasswordRequestHandler(null);
  }, []);

  useEffect(() => {
    if (!pinnedViews.includes(currentView) && pinnedViews.length > 0) {
      setCurrentView(pinnedViews[0]);
    }
  }, [pinnedViews, currentView, setCurrentView]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.altKey && event.code === "Space") {
        event.preventDefault();
        void toggleQuickPanel();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setIsLauncherOpen(true);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    if (!isDesktopRuntime()) return;

    const validViews: View[] = ["vault", "totp", "bookmarks", "notes", "snippets", "subscriptions", "devtools", "pomodoro"];
    let unlisten: (() => void) | undefined;
    void listen<string>("omnidesk-open-view", (event) => {
      if (validViews.includes(event.payload as View)) {
        setCurrentView(event.payload as View);
        setIsLauncherOpen(false);
      }
    }).then((dispose) => {
      unlisten = dispose;
    });

    return () => unlisten?.();
  }, [setCurrentView]);

  const renderView = () => {
    switch (currentView) {
      case 'vault': return <KeyVault />;
      case 'bookmarks': return <Bookmarks />;
      case 'totp': return <TOTPView />;
      case 'snippets': return <Snippets />;
      case 'subscriptions': return <Subscriptions />;
      case 'notes': return <Notes />;
      case 'devtools': return <DevTools />;
      case 'pomodoro': return <Pomodoro />;
      default: return <KeyVault />;
    }
  };

  const togglePin = (view: View) => {
    setPinnedViews(prev => 
      prev.includes(view) ? prev.filter(v => v !== view) : [...prev, view]
    );
  };

  const handleLock = async () => {
    await saveOmniStore(store);
    await onLock();
  };

  useAutoLock(autoLockToMilliseconds(preferences.autoLock), handleLock);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-slate-50 font-sans">
      <main className="flex-1 overflow-hidden relative">
        <div className="absolute top-0 right-0 w-96 h-96 bg-emerald-500/5 rounded-full blur-3xl pointer-events-none mix-blend-screen -translate-y-1/2 translate-x-1/4"></div>
        <div className="h-full w-full pb-24">
          {renderView()}
        </div>
      </main>

      <Dock 
        currentView={currentView} 
        setCurrentView={setCurrentView} 
        pinnedViews={pinnedViews}
        onReorder={setPinnedViews}
        onOpenLauncher={() => setIsLauncherOpen(true)}
        onOpenCommonSettings={() => setIsCommonSettingsOpen(true)}
      />

      <AnimatePresence>
        {isLauncherOpen && (
          <Launcher 
            onClose={() => setIsLauncherOpen(false)}
            currentView={currentView}
            setCurrentView={setCurrentView}
            pinnedViews={pinnedViews}
            onTogglePin={togglePin}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isSecurityOpen && (
          <SecuritySettings onClose={() => setIsSecurityOpen(false)} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isCommonSettingsOpen && (
          <CommonSettings
            preferences={preferences}
            onPreferencesChange={setPreferences}
            onClose={() => setIsCommonSettingsOpen(false)}
            onOpenSecurity={() => setIsSecurityOpen(true)}
            onLock={handleLock}
          />
        )}
      </AnimatePresence>

      <ExportNotice />

      <AnimatePresence>
        {masterPasswordRequest && (
          <MasterPasswordPrompt
            request={masterPasswordRequest}
            onClose={() => setMasterPasswordRequest(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
