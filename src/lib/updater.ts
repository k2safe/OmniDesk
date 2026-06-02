import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";

export type UpdateProgress = {
  downloaded: number;
  total?: number;
};

export function canUseNativeUpdater() {
  return "__TAURI_INTERNALS__" in window;
}

export async function checkForUpdate() {
  if (!canUseNativeUpdater()) {
    throw new Error("请在桌面版应用中检查更新");
  }

  const { check } = await import("@tauri-apps/plugin-updater");
  return check();
}

export async function downloadInstallAndRelaunch(update: Update, onProgress: (progress: UpdateProgress) => void) {
  let downloaded = 0;
  let total: number | undefined;

  await update.downloadAndInstall((event: DownloadEvent) => {
    if (event.event === "Started") {
      downloaded = 0;
      total = event.data.contentLength;
      onProgress({ downloaded, total });
      return;
    }

    if (event.event === "Progress") {
      downloaded += event.data.chunkLength;
      onProgress({ downloaded, total });
      return;
    }

    onProgress({ downloaded: total ?? downloaded, total });
  });

  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}

export function formatUpdaterError(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;

  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== "{}") return serialized;
  } catch {
    // Fall through to the generic conversion below.
  }

  return String(error || "未知错误");
}
