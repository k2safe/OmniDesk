import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import {
  BookmarkEntry,
  FileVaultEntry,
  FocusSessionEntry,
  NoteEntry,
  PasswordEntry,
  SnippetEntry,
  SubscriptionEntry,
  TOTPEntry,
  View,
} from "../types";
import { loadEncryptedStore, saveEncryptedStore, saveEncryptedStoreItem } from "./desktop";

const VALID_VIEWS: View[] = ["vault", "totp", "bookmarks", "notes", "snippets", "subscriptions", "devtools", "pomodoro"];

export const DEFAULT_PINNED: View[] = ["vault", "totp", "notes", "devtools", "pomodoro"];

export type ThemeMode = "system" | "light" | "dark";

export interface AppShortcuts {
  quickPanel: string;
  screenshot: string;
  colorPicker: string;
  localDrop: string;
}

export const DEFAULT_SHORTCUTS: AppShortcuts = {
  quickPanel: "Option+Space",
  screenshot: "Option+Shift+S",
  colorPicker: "Option+Shift+C",
  localDrop: "Option+Shift+D",
};

export interface AppPreferences {
  themeMode: ThemeMode;
  shortcuts: AppShortcuts;
}

export interface OmniStore {
  pinnedViews: View[];
  currentView: View;
  preferences: AppPreferences;
  vault: PasswordEntry[];
  fileVault: FileVaultEntry[];
  notes: NoteEntry[];
  bookmarkGroups: string[][];
  bookmarks: BookmarkEntry[];
  totp: TOTPEntry[];
  snippets: SnippetEntry[];
  subscriptions: SubscriptionEntry[];
  focusSessions: FocusSessionEntry[];
}

type StoreSetter = Dispatch<SetStateAction<OmniStore>>;

interface StoreContextValue {
  store: OmniStore;
  setStore: StoreSetter;
}

const StoreContext = createContext<StoreContextValue | null>(null);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray<T>(value: unknown, fallback: T[]): T[] {
  return Array.isArray(value) ? (value as T[]) : fallback;
}

function isView(value: unknown): value is View {
  return typeof value === "string" && VALID_VIEWS.includes(value as View);
}

function normalizePreferences(value: unknown): AppPreferences {
  const defaults: AppPreferences = {
    themeMode: "system",
    shortcuts: DEFAULT_SHORTCUTS,
  };
  if (!isRecord(value)) return defaults;

  const shortcuts = isRecord(value.shortcuts) ? value.shortcuts : {};

  return {
    themeMode: value.themeMode === "light" || value.themeMode === "dark" || value.themeMode === "system"
      ? value.themeMode
      : defaults.themeMode,
    shortcuts: {
      quickPanel: typeof shortcuts.quickPanel === "string" ? shortcuts.quickPanel : defaults.shortcuts.quickPanel,
      screenshot: typeof shortcuts.screenshot === "string" ? shortcuts.screenshot : defaults.shortcuts.screenshot,
      colorPicker: typeof shortcuts.colorPicker === "string" ? shortcuts.colorPicker : defaults.shortcuts.colorPicker,
      localDrop: typeof shortcuts.localDrop === "string" ? shortcuts.localDrop : defaults.shortcuts.localDrop,
    },
  };
}

function getNextMonthDate() {
  const date = new Date();
  date.setMonth(date.getMonth() + 1);
  return date.toISOString().split("T")[0];
}

export function createDefaultStore(): OmniStore {
  const now = Date.now();
  return {
    pinnedViews: DEFAULT_PINNED,
    currentView: DEFAULT_PINNED[0],
    preferences: {
      themeMode: "system",
      shortcuts: DEFAULT_SHORTCUTS,
    },
    vault: [
      { id: "1", title: "GitHub 个人服务器", username: "user@github.com", passwordEncrypted: "8*x9s$2mAQ!", createdAt: now },
      { id: "2", title: "本地离线数据库", username: "admin", passwordEncrypted: "local_dev_only", createdAt: now },
    ],
    fileVault: [],
    notes: [
      {
        id: "1",
        title: "Regex Cheat Sheet",
        content:
          "# Regex Basics\n\n- `^` Start of string\n- `$` End of string\n- `*` 0 or more\n- `+` 1 or more\n\n## JavaScript matching\n```javascript\nconst pattern = /hello/g;\n```",
        tags: ["regex", "开发"],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "2",
        title: "Docker Commands",
        content: "## Useful Docker Stuff\n\nClean all containers:\n`docker system prune -a`\n\nBuild:\n`docker build -t my-app .`",
        tags: ["docker", "命令"],
        createdAt: now,
        updatedAt: now,
      },
    ],
    bookmarkGroups: [],
    bookmarks: [
      { id: "1", title: "GitHub", url: "https://github.com", tags: ["dev", "work"], createdAt: now },
      { id: "2", title: "Vite Docs", url: "https://vitejs.dev", tags: ["dev", "react", "tooling"], createdAt: now },
      { id: "3", title: "Lucide Icons", url: "https://lucide.dev", tags: ["design", "ui"], createdAt: now },
    ],
    totp: [
      { id: "1", issuer: "GitHub", account: "dev@example.com", secret: "JBSWY3DPEHPK3PXP", note: "开发环境示例账号", tags: ["开发", "代码"], createdAt: now },
      { id: "2", issuer: "Google", account: "user@gmail.com", secret: "HXDMVJECJJWSRB3HWIZR4IFUGFTMXBOZ", note: "个人邮箱验证器", tags: ["个人", "邮箱"], createdAt: now },
    ],
    snippets: [
      {
        id: "1",
        title: "React local cache hook",
        language: "typescript",
        tags: ["react", "本地存储"],
        createdAt: now,
        code: `useEffect(() => {
  let isMounted = true;
  async function load() {
    const cached = await desktopStore.load('notes');
    if (isMounted) setNotes(cached);
  }
  load();
  return () => { isMounted = false; };
}, []);`,
      },
    ],
    subscriptions: [
      { id: "1", name: "ChatGPT Plus", cost: "$20.00", cycle: "monthly", nextDate: getNextMonthDate() },
      { id: "2", name: "GitHub Copilot", cost: "$100.00", cycle: "yearly", nextDate: "2027-01-01" },
    ],
    focusSessions: [],
  };
}

export function normalizeStore(value: unknown): OmniStore {
  const defaults = createDefaultStore();
  if (!isRecord(value)) return defaults;

  const pinnedViews = asArray<View>(value.pinnedViews, defaults.pinnedViews).filter(isView);
  const safePinnedViews = pinnedViews.length > 0 ? pinnedViews : defaults.pinnedViews;
  const currentView = isView(value.currentView) && safePinnedViews.includes(value.currentView)
    ? value.currentView
    : safePinnedViews[0];

  return {
    pinnedViews: safePinnedViews,
    currentView,
    preferences: normalizePreferences(value.preferences),
    vault: asArray<PasswordEntry>(value.vault, defaults.vault),
    fileVault: asArray<FileVaultEntry>(value.fileVault, defaults.fileVault),
    notes: asArray<NoteEntry>(value.notes, defaults.notes),
    bookmarkGroups: asArray<string[]>(value.bookmarkGroups, defaults.bookmarkGroups),
    bookmarks: asArray<BookmarkEntry>(value.bookmarks, defaults.bookmarks),
    totp: asArray<TOTPEntry>(value.totp, defaults.totp),
    snippets: asArray<SnippetEntry>(value.snippets, defaults.snippets),
    subscriptions: asArray<SubscriptionEntry>(value.subscriptions, defaults.subscriptions),
    focusSessions: asArray<FocusSessionEntry>(value.focusSessions, defaults.focusSessions),
  };
}

export async function loadOmniStore() {
  const encryptedStore = await loadEncryptedStore<unknown>();
  return normalizeStore(encryptedStore);
}

export async function saveOmniStore(store: OmniStore) {
  await saveEncryptedStore(store);
}

export async function saveOmniStoreField<K extends keyof OmniStore>(key: K, value: OmniStore[K]) {
  await saveEncryptedStoreItem(key, value);
}

export function OmniStoreProvider({ children, initialStore }: { children: ReactNode; initialStore: OmniStore }) {
  const [store, setStore] = useState(initialStore);
  const hasMounted = useRef(false);
  const previousStore = useRef(initialStore);
  const pendingKeys = useRef(new Set<keyof OmniStore>());

  useEffect(() => {
    if (!hasMounted.current) {
      hasMounted.current = true;
      return;
    }

    const keys = Object.keys(store) as (keyof OmniStore)[];
    for (const key of keys) {
      if (store[key] !== previousStore.current[key]) {
        pendingKeys.current.add(key);
      }
    }
    previousStore.current = store;
    if (pendingKeys.current.size === 0) return;

    const timeout = window.setTimeout(() => {
      const keysToSave = [...pendingKeys.current];
      pendingKeys.current.clear();
      void Promise.all(keysToSave.map((key) => saveOmniStoreField(key, store[key]))).catch((error) => {
        console.error("Failed to save OmniDesk store", error);
      });
    }, 120);

    return () => window.clearTimeout(timeout);
  }, [store]);

  return <StoreContext.Provider value={{ store, setStore }}>{children}</StoreContext.Provider>;
}

export function useOmniStore() {
  const context = useContext(StoreContext);
  if (!context) {
    throw new Error("useOmniStore must be used inside OmniStoreProvider");
  }
  return context;
}

export function useStoreField<K extends keyof OmniStore>(
  key: K,
): readonly [OmniStore[K], Dispatch<SetStateAction<OmniStore[K]>>] {
  const { store, setStore } = useOmniStore();

  const setValue = useCallback<Dispatch<SetStateAction<OmniStore[K]>>>(
    (nextValue) => {
      setStore((previous) => {
        const resolvedValue =
          typeof nextValue === "function"
            ? (nextValue as (value: OmniStore[K]) => OmniStore[K])(previous[key])
            : nextValue;
        return { ...previous, [key]: resolvedValue };
      });
    },
    [key, setStore],
  );

  return [store[key], setValue] as const;
}
