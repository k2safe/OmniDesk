import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent, ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Camera,
  Clipboard,
  Clock,
  KeyRound,
  Pipette,
  Search,
  UploadCloud,
  X,
} from "lucide-react";
import {
  captureScreenshot,
  hideQuickPanel,
  loadEncryptedStore,
  pickScreenColor,
  startLocalDrop,
  startWindowDrag,
  writeClipboard,
} from "../lib/desktop";
import type { ThemeMode } from "../lib/store";
import { cn } from "../lib/utils";

interface QuickCommand {
  id: string;
  label: string;
  hint: string;
  keywords: string;
  icon: ReactNode;
  run: () => void | Promise<void>;
}

export function QuickPanel() {
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState("输入关键词搜索，回车执行第一项");
  const [isBusy, setIsBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useQuickPanelTheme();

  const handleCaptureScreenshot = async () => {
    setIsBusy(true);
    setStatus("正在唤起系统截图...");
    try {
      const opened = await captureScreenshot();
      setStatus(opened ? "已唤起系统截图，拖选后会复制到剪贴板" : "已取消截图");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  };

  const handlePickColor = async () => {
    setIsBusy(true);
    setStatus("1.2 秒后取鼠标所在位置颜色...");
    try {
      const color = await pickScreenColor(1200);
      if (!color) {
        setStatus("取色已取消");
        return;
      }
      await writeClipboard(color.hex);
      setStatus(`已复制颜色：${color.hex} / ${color.rgb}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "取色失败");
    } finally {
      setIsBusy(false);
    }
  };

  const handleStartLocalDrop = async () => {
    setIsBusy(true);
    setStatus("正在开启局域网快传...");
    try {
      const info = await startLocalDrop();
      if (!info) {
        setStatus("快传只能在桌面版使用");
        return;
      }
      await writeClipboard(info.url);
      setStatus(`快传已开启并复制链接：${info.url}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "快传启动失败");
    } finally {
      setIsBusy(false);
    }
  };

  const handleCopyDraft = async () => {
    if (!draft.trim()) {
      setStatus("草稿为空");
      return;
    }
    await writeClipboard(draft);
    setStatus("草稿已复制到剪贴板");
  };

  const copyText = async (value: string, message: string) => {
    await writeClipboard(value);
    setStatus(message);
  };

  const commands = useMemo<QuickCommand[]>(() => {
    return [
      {
        id: "action-screenshot",
        label: "截图",
        hint: "系统快捷键复制选区",
        keywords: "screenshot capture screen 截图",
        icon: <Camera size={18} />,
        run: handleCaptureScreenshot,
      },
      {
        id: "action-color",
        label: "屏幕取色",
        hint: "复制 HEX 到剪贴板",
        keywords: "color picker hex rgb 取色",
        icon: <Pipette size={18} />,
        run: handlePickColor,
      },
      {
        id: "action-drop",
        label: "局域网快传",
        hint: "开启临时上传链接",
        keywords: "local drop upload file wifi 快传",
        icon: <UploadCloud size={18} />,
        run: handleStartLocalDrop,
      },
      {
        id: "action-copy-draft",
        label: "复制临时草稿",
        hint: "把右侧草稿复制出去",
        keywords: "copy clipboard draft scratch 草稿",
        icon: <Clipboard size={18} />,
        run: handleCopyDraft,
      },
      {
        id: "action-copy-time",
        label: "复制当前时间",
        hint: "YYYY/MM/DD HH:mm:ss",
        keywords: "time now date copy 当前时间",
        icon: <Clock size={18} />,
        run: () => {
          const now = new Date();
          const value = now.toLocaleString("zh-CN", {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
          });
          return copyText(value, `已复制当前时间：${value}`);
        },
      },
      {
        id: "action-copy-timestamp",
        label: "复制时间戳",
        hint: "秒 / 毫秒",
        keywords: "timestamp unix epoch copy 时间戳 秒 毫秒",
        icon: <Clock size={18} />,
        run: () => {
          const millis = Date.now();
          const value = `${Math.floor(millis / 1000)}\n${millis}`;
          return copyText(value, "已复制秒级和毫秒级时间戳");
        },
      },
    ];
  }, [draft]);

  const filteredCommands = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return commands;
    return commands.filter((command) => command.keywords.toLowerCase().includes(normalizedQuery));
  }, [commands, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<string>("omnidesk-quick-status", (event) => {
      setStatus(event.payload);
    })
      .then((dispose) => {
        unlisten = dispose;
      })
      .catch((error) => console.error("Failed to listen quick status", error));

    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void hideQuickPanel();
        return;
      }
      if (event.key === "Enter" && filteredCommands[0]) {
        event.preventDefault();
        void filteredCommands[0].run();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [filteredCommands]);

  const handleTitlePointerDown = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button, input, textarea")) return;
    event.preventDefault();
    void startWindowDrag().catch((error) => console.error("Failed to start quick panel drag", error));
  };

  return (
    <div className="flex h-screen w-screen bg-transparent p-2 text-slate-900">
      <main className="flex h-full w-full flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <header
          data-tauri-drag-region
          onPointerDown={handleTitlePointerDown}
          className="flex h-12 shrink-0 items-center justify-between border-b border-slate-200 bg-gradient-to-r from-emerald-50 via-white to-teal-50 px-4"
        >
          <div data-tauri-drag-region className="flex items-center gap-2 text-sm font-bold text-emerald-700">
            <KeyRound size={17} />
            OmniDesk Quick
          </div>
          <button
            onClick={() => hideQuickPanel()}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
            title="关闭"
          >
            <X size={17} />
          </button>
        </header>

        <section className="p-4">
          <div className="relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-12 w-full rounded-xl border border-slate-200 bg-slate-50 pl-11 pr-4 text-[15px] font-semibold text-slate-900 outline-none transition-all placeholder:text-slate-400 focus:border-emerald-500 focus:bg-white focus:ring-4 focus:ring-emerald-500/10"
              placeholder="搜快捷动作，例如：截图、取色、快传、时间戳..."
            />
          </div>
        </section>

        <section className="grid min-h-0 flex-1 grid-cols-[1.05fr_0.95fr] gap-3 px-4 pb-4">
          <div className="min-h-0 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-2">
            {filteredCommands.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm font-medium text-slate-400">没有匹配项</div>
            ) : (
              <div className="space-y-1.5">
                {filteredCommands.map((command, index) => (
                  <button
                    key={command.id}
                    onClick={() => command.run()}
                    disabled={isBusy}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-all disabled:opacity-60",
                      index === 0
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700 shadow-sm"
                        : "border-transparent bg-white text-slate-700 hover:border-emerald-200 hover:bg-emerald-50/70 hover:text-emerald-700",
                    )}
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white text-emerald-600 shadow-sm">
                      {command.icon}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-bold">{command.label}</span>
                      <span className="mt-0.5 block truncate text-xs font-medium text-slate-400">{command.hint}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <aside className="flex min-h-0 flex-col gap-3">
            <div className="rounded-xl border border-emerald-100 bg-emerald-50/70 p-3">
              <div className="text-xs font-bold uppercase tracking-wide text-emerald-700">状态</div>
              <p className="mt-1 line-clamp-3 break-all text-sm font-semibold text-slate-700">{status}</p>
            </div>

            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white">
              <div className="flex h-10 shrink-0 items-center justify-between border-b border-slate-200 px-3">
                <span className="text-sm font-bold text-slate-900">临时草稿</span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={handleCopyDraft}
                    className="rounded-lg px-2 py-1 text-xs font-semibold text-emerald-600 transition-colors hover:bg-emerald-50"
                  >
                    复制
                  </button>
                  <button
                    onClick={() => setDraft("")}
                    className="rounded-lg px-2 py-1 text-xs font-semibold text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
                  >
                    清空
                  </button>
                </div>
              </div>
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                className="min-h-0 flex-1 resize-none bg-slate-50 p-3 text-sm leading-6 text-slate-800 outline-none placeholder:text-slate-400"
                placeholder="随手贴一点东西，处理完就复制走..."
              />
            </div>
          </aside>
        </section>
      </main>
    </div>
  );
}

function isThemeMode(value: unknown): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

function resolveTheme(themeMode: ThemeMode) {
  if (themeMode !== "system") return themeMode;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function useQuickPanelTheme() {
  useEffect(() => {
    document.documentElement.dataset.window = "quick";
    document.body.dataset.window = "quick";

    let themeMode: ThemeMode = "system";
    let isCancelled = false;
    const media = window.matchMedia("(prefers-color-scheme: dark)");

    const applyTheme = () => {
      const resolvedTheme = resolveTheme(themeMode);
      document.documentElement.dataset.theme = resolvedTheme;
      document.documentElement.style.colorScheme = resolvedTheme;
      document.documentElement.style.background = "transparent";
      document.body.style.background = "transparent";
    };

    void loadEncryptedStore<{ preferences?: { themeMode?: unknown } }>()
      .then((store) => {
        if (isCancelled) return;
        const storedThemeMode = store?.preferences?.themeMode;
        themeMode = isThemeMode(storedThemeMode) ? storedThemeMode : "system";
        applyTheme();
      })
      .catch(() => {
        applyTheme();
      });

    applyTheme();
    media.addEventListener("change", applyTheme);
    return () => {
      isCancelled = true;
      media.removeEventListener("change", applyTheme);
      delete document.documentElement.dataset.window;
      delete document.body.dataset.window;
      document.documentElement.style.background = "";
      document.body.style.background = "";
    };
  }, []);
}
