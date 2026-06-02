import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { BookmarkEntry, NoteEntry, View } from "../types";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

let memoryStore: unknown = {};

export interface SavedNoteImage {
  markdownSrc: string;
  fileName: string;
}

export interface SavedVaultFile {
  id: string;
  fileName: string;
  encryptedFileName: string;
  size: number;
  createdAt: number;
}

export interface PickedColor {
  hex: string;
  rgb: string;
  red: number;
  green: number;
  blue: number;
  x: number;
  y: number;
}

export interface LocalDropInfo {
  url: string;
  inboxPath: string;
  token: string;
  port: number;
  expiresAt: number;
}

export interface ExportResult {
  exported: boolean;
  fileName: string;
  path?: string | null;
}

export interface GlobalShortcutConfig {
  action: string;
  accelerator: string;
}

export interface ChromeBookmarkImportResult {
  found: number;
  imported: number;
  skipped: number;
  profiles: string[];
}

export interface CachedBookmarkIcon {
  iconUrl: string;
  fileName: string;
}

type MasterPasswordRequestHandler = (reason: string) => Promise<boolean>;

type NoteSearchRecord = Pick<NoteEntry, "id" | "title" | "content" | "tags">;
type BookmarkSearchRecord = Pick<BookmarkEntry, "id" | "title" | "url" | "description" | "tags">;

let masterPasswordRequestHandler: MasterPasswordRequestHandler | null = null;

export const EXPORT_RESULT_EVENT = "omnidesk-export-result";

export function setMasterPasswordRequestHandler(handler: MasterPasswordRequestHandler | null) {
  masterPasswordRequestHandler = handler;
}

export function isDesktopRuntime() {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

async function invokeDesktop<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isDesktopRuntime()) {
    throw new Error("OmniDesk desktop runtime is not available.");
  }
  return invoke<T>(command, args);
}

export async function unlockWorkspace(password: string) {
  if (!isDesktopRuntime()) return;
  await invokeDesktop<void>("unlock", { password });
}

export async function unlockAndLoadEncryptedStore<T>(password: string) {
  if (!isDesktopRuntime()) {
    return memoryStore as T;
  }
  return invokeDesktop<T>("unlock_and_load_store", { password });
}

export async function changeMasterPassword(currentPassword: string, newPassword: string) {
  if (!isDesktopRuntime()) return;
  await invokeDesktop<void>("change_master_password", { currentPassword, newPassword });
}

export async function verifyMasterPassword(password: string) {
  if (!isDesktopRuntime()) return true;
  await invokeDesktop<void>("verify_password", { password });
  return true;
}

export async function lockWorkspace() {
  if (!isDesktopRuntime()) return;
  await invokeDesktop<void>("lock_store");
}

export async function getSystemIdleMillis() {
  if (!isDesktopRuntime()) return null;
  try {
    return await invokeDesktop<number>("system_idle_millis");
  } catch {
    return null;
  }
}

export async function loadEncryptedStore<T>() {
  if (!isDesktopRuntime()) {
    return memoryStore as T;
  }
  return invokeDesktop<T>("load_store");
}

export async function saveEncryptedStore(store: unknown) {
  if (!isDesktopRuntime()) {
    memoryStore = store;
    return;
  }
  await invokeDesktop<void>("save_store", { store });
}

export async function saveEncryptedStoreItem(storeKey: string, value: unknown) {
  if (!isDesktopRuntime()) {
    const currentStore = typeof memoryStore === "object" && memoryStore !== null ? memoryStore : {};
    memoryStore = { ...currentStore, [storeKey]: value };
    return;
  }
  await invokeDesktop<void>("save_store_item", { storeKey, value });
}

export async function writeClipboard(text: string, options?: { clearAfterSeconds?: number }) {
  if (!isDesktopRuntime()) {
    await navigator.clipboard?.writeText(text);
    if (options?.clearAfterSeconds) {
      const expectedText = text;
      window.setTimeout(async () => {
        try {
          if ((await navigator.clipboard?.readText()) === expectedText) {
            await navigator.clipboard?.writeText("");
          }
        } catch {
          // Browser clipboard permissions can be transient; desktop runtime handles this reliably.
        }
      }, options.clearAfterSeconds * 1000);
    }
    return;
  }
  await invokeDesktop<void>("write_clipboard", { text, clearAfterSeconds: options?.clearAfterSeconds });
}

export async function requireMasterPassword(reason: string) {
  if (masterPasswordRequestHandler) {
    return masterPasswordRequestHandler(reason);
  }

  const password = window.prompt(`${reason}\n\n请输入主密码进行二次验证：`);
  if (!password) return false;
  try {
    await verifyMasterPassword(password);
    return true;
  } catch {
    window.alert("主密码验证失败");
    return false;
  }
}

export async function openExternalUrl(url: string) {
  if (!isDesktopRuntime()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  await invokeDesktop<void>("open_external_url", { url });
}

export async function toggleQuickPanel() {
  if (!isDesktopRuntime()) return;
  await invokeDesktop<void>("toggle_quick_panel");
}

export async function setGlobalShortcuts(shortcuts: GlobalShortcutConfig[]) {
  if (!isDesktopRuntime()) return;
  await invokeDesktop<void>("set_global_shortcuts", { shortcuts });
}

export async function hideQuickPanel() {
  if (!isDesktopRuntime()) return;
  await invokeDesktop<void>("hide_quick_panel");
}

export async function startWindowDrag() {
  if (!isDesktopRuntime()) return;
  await getCurrentWindow().startDragging();
}

export async function openMainView(view: View) {
  if (!isDesktopRuntime()) return;
  await invokeDesktop<void>("open_main_view", { view });
}

export async function captureScreenshot() {
  if (!isDesktopRuntime()) return null;
  return invokeDesktop<boolean>("capture_screenshot");
}

export async function pickScreenColor(delayMs = 1200) {
  if (!isDesktopRuntime()) return null;
  return invokeDesktop<PickedColor>("pick_screen_color", { delayMs });
}

export async function startLocalDrop() {
  if (!isDesktopRuntime()) return null;
  return invokeDesktop<LocalDropInfo>("start_local_drop");
}

export async function stopLocalDrop() {
  if (!isDesktopRuntime()) return;
  await invokeDesktop<void>("stop_local_drop");
}

export async function getLocalDropStatus() {
  if (!isDesktopRuntime()) return null;
  return invokeDesktop<LocalDropInfo | null>("local_drop_status");
}

export async function exportJson(defaultFileName: string, data: unknown) {
  if (!isDesktopRuntime()) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = defaultFileName;
    anchor.click();
    URL.revokeObjectURL(objectUrl);
    return { exported: true, fileName: defaultFileName, path: null } satisfies ExportResult;
  }
  const result = await invokeDesktop<ExportResult>("export_json", { defaultFileName, data });
  notifyExportResult(result);
  return result;
}

export async function exportBytes(defaultFileName: string, bytesBase64: string) {
  if (!isDesktopRuntime()) {
    const binary = atob(bytesBase64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const blob = new Blob([bytes]);
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = defaultFileName;
    anchor.click();
    URL.revokeObjectURL(objectUrl);
    return { exported: true, fileName: defaultFileName, path: null } satisfies ExportResult;
  }
  const result = await invokeDesktop<ExportResult>("export_bytes", { defaultFileName, bytesBase64 });
  notifyExportResult(result);
  return result;
}

export async function exportWorkspaceArchive() {
  if (!isDesktopRuntime()) {
    throw new Error("整包导出只能在桌面版使用。");
  }
  const result = await invokeDesktop<ExportResult>("export_workspace_archive");
  notifyExportResult(result);
  return result;
}

export async function importWorkspaceArchive() {
  if (!isDesktopRuntime()) {
    throw new Error("整包导入只能在桌面版使用。");
  }
  return invokeDesktop<ExportResult>("import_workspace_archive");
}

function notifyExportResult(result: ExportResult) {
  if (result.exported && result.path) {
    window.dispatchEvent(new CustomEvent<ExportResult>(EXPORT_RESULT_EVENT, { detail: result }));
  }
}

export async function importJson<T>() {
  if (!isDesktopRuntime()) {
    return new Promise<T | null>((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json,application/json";
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) {
          resolve(null);
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          try {
            resolve(JSON.parse(String(reader.result)) as T);
          } catch (error) {
            reject(error);
          }
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsText(file);
      };
      input.click();
    });
  }
  return invokeDesktop<T | null>("import_json");
}

export async function importChromeBookmarks() {
  if (!isDesktopRuntime()) {
    throw new Error("Chrome 书签导入只能在桌面版使用。");
  }
  return invokeDesktop<ChromeBookmarkImportResult>("import_chrome_bookmarks");
}

export async function cacheBookmarkIcon(url: string, iconUrl?: string) {
  if (!isDesktopRuntime()) return null;
  return invokeDesktop<CachedBookmarkIcon | null>("cache_bookmark_icon", { url, iconUrl });
}

export async function readBookmarkIcon(src: string) {
  if (!isDesktopRuntime()) return src;
  return invokeDesktop<string>("read_bookmark_icon", { src });
}

function searchNoteIdsLocally(query: string, notes: NoteSearchRecord[]) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [];

  return notes
    .filter((note) => `${note.title} ${note.content} ${(note.tags ?? []).join(" ")}`.toLowerCase().includes(normalizedQuery))
    .map((note) => note.id);
}

export async function searchNotes(query: string, notes: NoteSearchRecord[]) {
  if (!isDesktopRuntime()) {
    return searchNoteIdsLocally(query, notes);
  }
  return invokeDesktop<string[]>("search_notes", { query, notes });
}

function searchBookmarkIdsLocally(query: string, bookmarks: BookmarkSearchRecord[]) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [];

  return bookmarks
    .filter((bookmark) => `${bookmark.title} ${bookmark.url} ${bookmark.description ?? ""} ${bookmark.tags.join(" ")}`.toLowerCase().includes(normalizedQuery))
    .map((bookmark) => bookmark.id);
}

export async function searchBookmarks(query: string, bookmarks: BookmarkSearchRecord[]) {
  if (!isDesktopRuntime()) {
    return searchBookmarkIdsLocally(query, bookmarks);
  }
  return invokeDesktop<string[]>("search_bookmarks", { query, bookmarks });
}

export async function saveNoteImage(mimeType: string, bytesBase64: string) {
  if (!isDesktopRuntime()) {
    return {
      markdownSrc: `data:${mimeType};base64,${bytesBase64}`,
      fileName: `pasted-image.${mimeType.split("/")[1] || "png"}`,
    } satisfies SavedNoteImage;
  }
  return invokeDesktop<SavedNoteImage>("save_note_image", { mimeType, bytesBase64 });
}

export async function readNoteImage(src: string) {
  if (!isDesktopRuntime()) return src;
  return invokeDesktop<string>("read_note_image", { src });
}

export async function saveVaultFile(fileName: string, bytesBase64: string) {
  if (!isDesktopRuntime()) {
    throw new Error("保险箱文件只能在桌面版使用。");
  }
  return invokeDesktop<SavedVaultFile>("save_vault_file", { fileName, bytesBase64 });
}

export async function exportVaultFile(encryptedFileName: string, fileName: string) {
  if (!isDesktopRuntime()) return { exported: false, fileName, path: null } satisfies ExportResult;
  const result = await invokeDesktop<ExportResult>("export_vault_file", { encryptedFileName, fileName });
  notifyExportResult(result);
  return result;
}

export async function deleteVaultFile(encryptedFileName: string) {
  if (!isDesktopRuntime()) return;
  await invokeDesktop<void>("delete_vault_file", { encryptedFileName });
}
