import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Search, Plus, ExternalLink, Trash2, Tag, Bookmark as BookmarkIcon, X, Pencil, Copy, Check, Download, Upload, Chrome, FolderTree, Folder, GripVertical, FolderPlus } from "lucide-react";
import { BookmarkEntry } from "../types";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "../lib/utils";
import { cacheBookmarkIcon, exportJson, importChromeBookmarks, importJson, loadEncryptedStore, openExternalUrl, readBookmarkIcon, searchBookmarks, writeClipboard } from "../lib/desktop";
import { useStoreField } from "../lib/store";
import { OptionSelect, type OptionItem } from "../components/OptionSelect";

function getBookmarkIconCandidates(url: string, iconUrl?: string) {
  try {
    const origin = new URL(url).origin;
    return Array.from(new Set([
      iconUrl,
      `${origin}/favicon.ico`,
      `${origin}/favicon.png`,
      `${origin}/apple-touch-icon.png`,
    ].filter(Boolean) as string[]));
  } catch {
    return iconUrl ? [iconUrl] : [];
  }
}

function deriveBookmarkIconUrl(url: string) {
  return getBookmarkIconCandidates(url)[0];
}

function parseTagInput(value: string) {
  return Array.from(new Set(value.split(',').map(t => t.trim().toLowerCase()).filter(t => t.length > 0)));
}

function parseGroupPathInput(value: string) {
  return value
    .split(/[/>]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

const CHROME_ROOT_GROUPS = new Set([
  "书签栏",
  "其他书签",
  "移动设备书签",
  "bookmarks bar",
  "bookmark bar",
  "other bookmarks",
  "mobile bookmarks",
]);
const UNGROUPED_GROUP_KEY = "__omnidesk_ungrouped__";
const NO_GROUP_VALUE = "__omnidesk_no_group__";
const BOOKMARK_ICON_PREFIX = "omnidesk-asset://bookmark-icons/";

function isLocalBookmarkIconUrl(value?: string) {
  return Boolean(value?.startsWith(BOOKMARK_ICON_PREFIX));
}

function stripChromeRootGroupPath(path: string[], shouldStrip: boolean) {
  if (!shouldStrip || path.length === 0) return path;
  const [first, ...rest] = path;
  return CHROME_ROOT_GROUPS.has(first.trim().toLowerCase()) ? rest : path;
}

function normalizeGroupPath(path?: string[]) {
  return (path ?? []).map((part) => part.trim()).filter(Boolean);
}

function groupKey(path: string[] = []) {
  return path.join("\u001f");
}

function isPathInsideGroup(path: string[] | undefined, groupPath: string[]) {
  const normalizedPath = normalizeGroupPath(path);
  return groupPath.length > 0 && groupPath.every((part, index) => normalizedPath[index] === part);
}

function groupPathLabel(path: string[]) {
  return path.join(" / ");
}

function groupSelectValueFromInput(value: string, groupPathByKey: Map<string, string[]>) {
  const path = parseGroupPathInput(value);
  if (path.length === 0) return NO_GROUP_VALUE;
  const key = groupKey(path);
  return groupPathByKey.has(key) ? key : NO_GROUP_VALUE;
}

function groupInputFromSelectValue(value: string, groupPathByKey: Map<string, string[]>) {
  if (value === NO_GROUP_VALUE) return "";
  return groupPathLabel(groupPathByKey.get(value) ?? []);
}

function isSameBookmark(a: BookmarkEntry, b: BookmarkEntry) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function normalizeTagList(tags?: string[]) {
  return Array.from(new Set((tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean)));
}

function parseChromeImportDescription(description?: string) {
  const prefix = "Chrome 导入：";
  if (!description?.startsWith(prefix)) return null;
  const parts = description.slice(prefix.length).split("/").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  return {
    source: parts[0],
    groupPath: parts.slice(1),
  };
}

function normalizeBookmark(bookmark: BookmarkEntry): BookmarkEntry {
  const chromeImport = parseChromeImportDescription(bookmark.description);
  const isChromeImport = Boolean(chromeImport || bookmark.source?.toLowerCase().includes("chrome"));
  const rawGroupPath = (bookmark.groupPath && bookmark.groupPath.length > 0)
    ? bookmark.groupPath.map((part) => part.trim()).filter(Boolean)
    : chromeImport?.groupPath ?? [];
  const groupPath = stripChromeRootGroupPath(rawGroupPath, isChromeImport);
  const source = bookmark.source ?? chromeImport?.source;
  const blockedTags = new Set<string>();
  if (source) blockedTags.add(source.toLowerCase());
  if (isChromeImport) CHROME_ROOT_GROUPS.forEach((tag) => blockedTags.add(tag));
  groupPath.forEach((part) => blockedTags.add(part.toLowerCase()));

  const tags = normalizeTagList(bookmark.tags).filter((tag) => {
    if (tag === "chrome") return false;
    if (blockedTags.has(tag)) return false;
    return true;
  });

  const normalized: BookmarkEntry = {
    ...bookmark,
    tags,
    groupPath: groupPath.length > 0 ? groupPath : undefined,
    source,
    description: chromeImport ? undefined : bookmark.description,
  };
  return isSameBookmark(bookmark, normalized) ? bookmark : normalized;
}

interface GroupNode {
  name: string;
  path: string[];
  count: number;
  children: GroupNode[];
}

interface DragPreview {
  title: string;
  subtitle: string;
  x: number;
  y: number;
}

function isInteractiveDragTarget(target: EventTarget | null) {
  return target instanceof HTMLElement && Boolean(target.closest("button, a, input, textarea, select, [data-no-card-drag]"));
}

function ensureGroupNode(root: GroupNode, path: string[]) {
  let current = root;
  for (const part of path) {
    let child = current.children.find((node) => node.name === part);
    if (!child) {
      child = { name: part, path: [...current.path, part], count: 0, children: [] };
      current.children.push(child);
    }
    current = child;
  }
}

function buildGroupTree(bookmarks: BookmarkEntry[], explicitGroups: string[][]) {
  const root: GroupNode = { name: "全部", path: [], count: bookmarks.length, children: [] };

  for (const path of explicitGroups) {
    const normalizedPath = normalizeGroupPath(path);
    if (normalizedPath.length > 0) ensureGroupNode(root, normalizedPath);
  }

  for (const bookmark of bookmarks) {
    const path = normalizeGroupPath(bookmark.groupPath);
    let current = root;
    for (const part of path) {
      let child = current.children.find((node) => node.name === part);
      if (!child) {
        child = { name: part, path: [...current.path, part], count: 0, children: [] };
        current.children.push(child);
      }
      child.count += 1;
      current = child;
    }
  }

  const sortNodes = (node: GroupNode) => {
    node.children.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    node.children.forEach(sortNodes);
  };
  sortNodes(root);
  return root;
}

function findGroupNode(root: GroupNode, path: string[]) {
  let current = root;
  for (const part of path) {
    const next = current.children.find((node) => node.name === part);
    if (!next) return null;
    current = next;
  }
  return current;
}

function isInGroup(bookmark: BookmarkEntry, activeGroupPath: string[]) {
  if (activeGroupPath.length === 0) return true;
  const path = bookmark.groupPath ?? [];
  return activeGroupPath.every((part, index) => path[index] === part);
}

function flattenGroupNodes(node: GroupNode): GroupNode[] {
  return node.children.flatMap((child) => [child, ...flattenGroupNodes(child)]);
}

function BookmarkLogo({
  bookmark,
  onIconCached,
}: {
  bookmark: BookmarkEntry;
  onIconCached: (id: string, iconUrl: string) => void;
}) {
  const candidates = useMemo(
    () => getBookmarkIconCandidates(bookmark.url, bookmark.iconUrl),
    [bookmark.url, bookmark.iconUrl],
  );
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [displaySrc, setDisplaySrc] = useState("");
  const src = candidates[candidateIndex];

  useEffect(() => {
    setCandidateIndex(0);
  }, [bookmark.url, bookmark.iconUrl]);

  useEffect(() => {
    let cancelled = false;
    setDisplaySrc("");
    if (!src) return () => {
      cancelled = true;
    };

    if (isLocalBookmarkIconUrl(src)) {
      void readBookmarkIcon(src)
        .then((dataUrl) => {
          if (!cancelled) setDisplaySrc(dataUrl);
        })
        .catch(() => {
          if (!cancelled) setCandidateIndex((index) => index + 1);
        });
    } else {
      setDisplaySrc(src);
    }

    return () => {
      cancelled = true;
    };
  }, [src]);

  useEffect(() => {
    let cancelled = false;
    void cacheBookmarkIcon(bookmark.url, bookmark.iconUrl)
      .then((cached) => {
        if (!cancelled && cached?.iconUrl && cached.iconUrl !== bookmark.iconUrl) {
          onIconCached(bookmark.id, cached.iconUrl);
        }
      })
      .catch(() => {
        // Favicon cache is opportunistic; the bookmark itself must still render offline.
      });
    return () => {
      cancelled = true;
    };
  }, [bookmark.id, bookmark.url, bookmark.iconUrl, onIconCached]);

  return (
    <div className="w-8 h-8 rounded-lg bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-400 shrink-0 overflow-hidden relative">
      {displaySrc ? (
        <img
          src={displaySrc}
          alt=""
          className="w-5 h-5 object-contain"
          onError={() => setCandidateIndex((index) => index + 1)}
        />
      ) : (
        <BookmarkIcon size={16} />
      )}
    </div>
  );
}

export function Bookmarks() {
  const [bookmarks, setBookmarks] = useStoreField("bookmarks");
  const [bookmarkGroups, setBookmarkGroups] = useStoreField("bookmarkGroups");
  const [search, setSearch] = useState("");
  const [searchResultIds, setSearchResultIds] = useState<string[] | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [isAddingGroup, setIsAddingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupParentKey, setNewGroupParentKey] = useState(NO_GROUP_VALUE);
  const [isImportingChrome, setIsImportingChrome] = useState(false);
  const [importStatus, setImportStatus] = useState("");
  const [activeGroupPath, setActiveGroupPath] = useState<string[]>([]);
  const [activeUngrouped, setActiveUngrouped] = useState(false);
  const [dragOverGroupKey, setDragOverGroupKey] = useState<string | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null);
  const suppressClickAfterDrag = useRef(false);
  
  // Form State
  const [newTitle, setNewTitle] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newTags, setNewTags] = useState("");
  const [newGroupPath, setNewGroupPath] = useState("");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editTags, setEditTags] = useState("");
  const [editGroupPath, setEditGroupPath] = useState("");

  const normalizedBookmarks = useMemo(() => bookmarks.map(normalizeBookmark), [bookmarks]);
  const normalizedBookmarkGroups = useMemo(() => {
    const seen = new Set<string>();
    return bookmarkGroups
      .map(normalizeGroupPath)
      .filter((path) => path.length > 0)
      .filter((path) => {
        const key = groupKey(path);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }, [bookmarkGroups]);

  useEffect(() => {
    if (normalizedBookmarks.some((bookmark, index) => bookmark !== bookmarks[index])) {
      setBookmarks(normalizedBookmarks);
    }
  }, [bookmarks, normalizedBookmarks, setBookmarks]);

  useEffect(() => {
    if (JSON.stringify(normalizedBookmarkGroups) !== JSON.stringify(bookmarkGroups)) {
      setBookmarkGroups(normalizedBookmarkGroups);
    }
  }, [bookmarkGroups, normalizedBookmarkGroups, setBookmarkGroups]);

  const removeBookmark = (id: string) => {
    setBookmarks(bookmarks.filter(b => b.id !== id));
  };

  const markBookmarkIconCached = useCallback((id: string, iconUrl: string) => {
    setBookmarks((current) => current.map((bookmark) => (
      bookmark.id === id && bookmark.iconUrl !== iconUrl
        ? { ...bookmark, iconUrl }
        : bookmark
    )));
  }, [setBookmarks]);

  const moveBookmarkToGroup = useCallback((id: string, groupPath: string[]) => {
    setBookmarks((current) => current.map((bookmark) => (
      bookmark.id === id
        ? { ...bookmark, groupPath: groupPath.length > 0 ? groupPath : undefined }
        : bookmark
    )));
  }, [setBookmarks]);

  const getGroupDropProps = (path: string[]) => ({
    "data-omnidesk-bookmark-drop-key": groupKey(path),
  });

  const getUngroupedDropProps = () => ({
    "data-omnidesk-bookmark-drop-key": UNGROUPED_GROUP_KEY,
  });

  const handleEditSave = (e: React.FormEvent, id: string) => {
    e.preventDefault();
    if (!editUrl) return;

    let processedUrl = editUrl;
    if (!/^https?:\/\//i.test(processedUrl)) {
      processedUrl = 'https://' + processedUrl;
    }

    let derivedTitle = editTitle;
    if (!derivedTitle) {
      try {
        derivedTitle = new URL(processedUrl).hostname.replace('www.', '');
      } catch (err) {
        derivedTitle = processedUrl;
      }
    }

    const tagsArray = parseTagInput(editTags);
    const groupPath = parseGroupPathInput(editGroupPath);

    setBookmarks(bookmarks.map(b => b.id === id ? {
      ...b,
      title: derivedTitle,
      url: processedUrl,
      description: editDescription.trim() || undefined,
      iconUrl: deriveBookmarkIconUrl(processedUrl),
      tags: tagsArray,
      groupPath: groupPath.length > 0 ? groupPath : undefined,
    } : b));
    setEditingId(null);
  };

  // Extract all unique tags
  const allTags = Array.from(new Set<string>(normalizedBookmarks.flatMap((b) => b.tags))).sort((a, b) => a.localeCompare(b));
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const groupTree = useMemo(() => buildGroupTree(normalizedBookmarks, normalizedBookmarkGroups), [normalizedBookmarks, normalizedBookmarkGroups]);
  const activeGroupNode = useMemo(() => findGroupNode(groupTree, activeGroupPath), [groupTree, activeGroupPath]);
  const allGroupNodes = useMemo(() => flattenGroupNodes(groupTree), [groupTree]);
  const groupPathByKey = useMemo(() => {
    const map = new Map<string, string[]>();
    flattenGroupNodes(groupTree).forEach((node) => map.set(groupKey(node.path), node.path));
    return map;
  }, [groupTree]);
  const groupOptions = useMemo<OptionItem<string>[]>(() => [
    { value: NO_GROUP_VALUE, label: "未分组" },
    ...allGroupNodes.map((node) => ({ value: groupKey(node.path), label: groupPathLabel(node.path) })),
  ], [allGroupNodes]);
  const groupParentOptions = useMemo<OptionItem<string>[]>(() => [
    { value: NO_GROUP_VALUE, label: "顶层分组" },
    ...allGroupNodes.map((node) => ({ value: groupKey(node.path), label: groupPathLabel(node.path) })),
  ], [allGroupNodes]);
  const ungroupedCount = useMemo(
    () => normalizedBookmarks.filter((bookmark) => !(bookmark.groupPath?.length)).length,
    [normalizedBookmarks],
  );

  const createBookmarkGroup = (event: React.FormEvent) => {
    event.preventDefault();
    const name = newGroupName.trim().replace(/[/>]/g, " ").replace(/\s+/g, " ");
    if (!name) return;

    const parentPath = newGroupParentKey === NO_GROUP_VALUE ? [] : groupPathByKey.get(newGroupParentKey) ?? [];
    const path = normalizeGroupPath([...parentPath, name]);
    const key = groupKey(path);
    if (groupPathByKey.has(key)) {
      alert("这个分组已经存在了");
      return;
    }

    setBookmarkGroups((current) => [...current, path]);
    setNewGroupName("");
    setNewGroupParentKey(NO_GROUP_VALUE);
    setIsAddingGroup(false);
    setActiveTag(null);
    setActiveUngrouped(false);
    setActiveGroupPath(path);
  };

  const deleteBookmarkGroup = (path: string[]) => {
    const label = groupPathLabel(path);
    if (!window.confirm(`删除「${label}」分组？里面的书签会全部移到「未分组」。`)) return;

    setBookmarks((current) => current.map((bookmark) => (
      isPathInsideGroup(bookmark.groupPath, path)
        ? { ...bookmark, groupPath: undefined }
        : bookmark
    )));
    setBookmarkGroups((current) => current.filter((groupPath) => !isPathInsideGroup(groupPath, path)));
    if (!activeUngrouped && isPathInsideGroup(activeGroupPath, path)) {
      setActiveUngrouped(true);
      setActiveGroupPath([]);
    }
  };

  const getDropTargetFromPoint = useCallback((x: number, y: number) => {
    const dropTarget = Array.from(document.querySelectorAll<HTMLElement>("[data-omnidesk-bookmark-drop-key]"))
      .find((element) => {
        const rect = element.getBoundingClientRect();
        const hitPadding = 18;
        return x >= rect.left - hitPadding && x <= rect.right + hitPadding && y >= rect.top - hitPadding && y <= rect.bottom + hitPadding;
      });
    if (!dropTarget) return null;

    const key = dropTarget.dataset.omnideskBookmarkDropKey;
    if (!key) return null;
    if (key === UNGROUPED_GROUP_KEY) return { key, path: [] };
    const path = groupPathByKey.get(key);
    return path ? { key, path } : null;
  }, [groupPathByKey]);

  const finishPointerDrag = useCallback((id: string, x: number, y: number) => {
    const dropTarget = getDropTargetFromPoint(x, y);
    if (!dropTarget) return;
    moveBookmarkToGroup(id, dropTarget.path);
    setActiveUngrouped(dropTarget.key === UNGROUPED_GROUP_KEY);
    setActiveGroupPath(dropTarget.path);
  }, [getDropTargetFromPoint, moveBookmarkToGroup]);

  const startBookmarkPointerDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>, bookmark: BookmarkEntry) => {
    if (editingId === bookmark.id || event.button !== 0 || isInteractiveDragTarget(event.target)) return;

    event.preventDefault();
    event.stopPropagation();

    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const drag = {
      id: bookmark.id,
      title: bookmark.title,
      subtitle: bookmark.url.replace(/^https?:\/\//i, ""),
      dragging: false,
    };

    const clear = () => {
      window.removeEventListener("pointermove", handlePointerMove, true);
      window.removeEventListener("pointerup", handlePointerUp, true);
      window.removeEventListener("pointercancel", handlePointerCancel, true);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      setDragPreview(null);
      setDragOverGroupKey(null);
      window.setTimeout(() => {
        suppressClickAfterDrag.current = false;
      }, 0);
    };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const distance = Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY);
      if (!drag.dragging && distance < 6) return;

      if (!drag.dragging) {
        drag.dragging = true;
        suppressClickAfterDrag.current = true;
        document.body.style.userSelect = "none";
        document.body.style.cursor = "grabbing";
      }

      moveEvent.preventDefault();
      const dropTarget = getDropTargetFromPoint(moveEvent.clientX, moveEvent.clientY);
      setDragOverGroupKey(dropTarget?.key ?? null);
      setDragPreview({
        title: drag.title,
        subtitle: drag.subtitle,
        x: moveEvent.clientX,
        y: moveEvent.clientY,
      });
    };

    const handlePointerUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      if (drag.dragging) {
        upEvent.preventDefault();
        finishPointerDrag(drag.id, upEvent.clientX, upEvent.clientY);
      }
      clear();
    };

    const handlePointerCancel = () => {
      clear();
    };

    window.addEventListener("pointermove", handlePointerMove, true);
    window.addEventListener("pointerup", handlePointerUp, true);
    window.addEventListener("pointercancel", handlePointerCancel, true);
  }, [editingId, finishPointerDrag, getDropTargetFromPoint]);

  useEffect(() => {
    if (!activeUngrouped && activeGroupPath.length > 0 && !activeGroupNode) {
      setActiveGroupPath([]);
    }
  }, [activeGroupNode, activeGroupPath, activeUngrouped]);

  const searchRank = useMemo(() => {
    if (!searchResultIds) return null;
    return new Map(searchResultIds.map((id, index) => [id, index]));
  }, [searchResultIds]);
  const normalizedSearch = search.trim().toLowerCase();

  // Filter
  const filteredBookmarks = normalizedBookmarks.filter(b => {
    const matchSearch = normalizedSearch
      ? searchRank
        ? searchRank.has(b.id)
        : b.title.toLowerCase().includes(normalizedSearch) || 
          b.url.toLowerCase().includes(normalizedSearch) ||
          (b.description ?? "").toLowerCase().includes(normalizedSearch) ||
          (b.source ?? "").toLowerCase().includes(normalizedSearch) ||
          (b.groupPath ?? []).join(" ").toLowerCase().includes(normalizedSearch) ||
          b.tags.some(t => t.toLowerCase().includes(normalizedSearch))
      : true;
    const matchTag = activeTag ? b.tags.includes(activeTag) : true;
    const matchGroup = activeUngrouped ? !(b.groupPath?.length) : isInGroup(b, activeGroupPath);
    return matchSearch && matchTag && matchGroup;
  }).sort((a, b) => {
    if (!searchRank) return 0;
    return (searchRank.get(a.id) ?? 0) - (searchRank.get(b.id) ?? 0);
  });

  useEffect(() => {
    let isCancelled = false;

    if (!normalizedSearch) {
      setSearchResultIds(null);
      return () => {
        isCancelled = true;
      };
    }

    setSearchResultIds(null);
    const timeout = window.setTimeout(() => {
      const searchableBookmarks = normalizedBookmarks.map(({ id, title, url, description, tags, groupPath, source }) => ({
        id,
        title,
        url,
        description: [description, source, (groupPath ?? []).join(" ")].filter(Boolean).join(" "),
        tags,
      }));
      void searchBookmarks(normalizedSearch, searchableBookmarks)
        .then((ids) => {
          if (!isCancelled) setSearchResultIds(ids);
        })
        .catch((error) => {
          console.error("Failed to search bookmarks", error);
          if (!isCancelled) setSearchResultIds(null);
        });
    }, 120);

    return () => {
      isCancelled = true;
      window.clearTimeout(timeout);
    };
  }, [normalizedBookmarks, normalizedSearch]);

  const handleExport = async () => {
    try {
      await exportJson("bookmarks_backup.json", bookmarks);
    } catch (error) {
      alert(error instanceof Error ? error.message : "导出失败");
    }
  };

  const handleImport = async () => {
    try {
      const parsed = await importJson<BookmarkEntry[]>();
      if (!parsed) return;
      if (Array.isArray(parsed)) {
        setBookmarks(parsed.map(normalizeBookmark));
      } else {
        alert("无效的备份文件");
      }
    } catch {
      alert("文件解析失败");
    }
  };

  const handleImportChrome = async () => {
    setIsImportingChrome(true);
    setImportStatus("");
    try {
      const result = await importChromeBookmarks();
      const loadedStore = await loadEncryptedStore<{ bookmarks?: BookmarkEntry[] }>();
      if (Array.isArray(loadedStore?.bookmarks)) {
        setBookmarks(loadedStore.bookmarks.map(normalizeBookmark));
      }

      if (result.found === 0) {
        setImportStatus("没有找到 Chrome 书签文件。");
      } else if (result.imported === 0) {
        setImportStatus(`Chrome 书签已扫描 ${result.found} 条，全部已存在，跳过 ${result.skipped} 条。`);
      } else {
        setImportStatus(`已导入 Chrome 书签 ${result.imported} 条，跳过重复 ${result.skipped} 条。`);
      }
    } catch (error) {
      setImportStatus(error instanceof Error ? error.message : "Chrome 书签导入失败");
    } finally {
      setIsImportingChrome(false);
    }
  };

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto w-full h-full text-slate-800 flex flex-col gap-5 overflow-y-auto">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-slate-200 pb-6 shrink-0">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900 mb-2">书签库</h1>
          <p className="text-slate-400">极速响应的本地网址书签，支持全文/标签检索。</p>
        </div>
        
        <div className="flex gap-3">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input 
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索标题, 网址或标签..."
              className="bg-white border border-slate-300 rounded-lg pl-9 pr-4 py-2 text-sm text-slate-900 placeholder-slate-500 focus:outline-none focus:border-emerald-500 w-64 transition-colors"
            />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-900">
                <X size={14} />
              </button>
            )}
          </div>
          <button
            onClick={handleImportChrome}
            disabled={isImportingChrome}
            className="p-2 text-slate-400 hover:text-emerald-600 hover:bg-slate-100 rounded-md transition-colors disabled:opacity-50"
            title="导入 Chrome 书签"
          >
            <Chrome size={18} className={isImportingChrome ? "animate-pulse" : ""} />
          </button>
          <button 
            onClick={handleImport}
            className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-md transition-colors"
            title="导入书签"
          >
            <Upload size={18} />
          </button>
          <button 
            onClick={handleExport}
            className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-md transition-colors mr-2"
            title="导出书签"
          >
            <Download size={18} />
          </button>
          <button 
            onClick={() => {
              const nextAdding = !isAdding;
              setIsAdding(nextAdding);
              if (nextAdding) {
                setNewGroupPath(!activeUngrouped && activeGroupPath.length > 0 ? groupPathLabel(activeGroupPath) : "");
              }
            }}
            className="bg-emerald-500 hover:bg-emerald-600 text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-colors whitespace-nowrap"
          >
            <Plus size={16} /> 新增
          </button>
        </div>
      </header>

      {importStatus && (
        <div className="shrink-0 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">
          {importStatus}
        </div>
      )}

      <div className="grid min-w-0 flex-1 gap-4 xl:grid-cols-[250px_minmax(0,1fr)]">
        <aside
            className={cn(
              "shrink-0 self-start rounded-2xl border border-slate-200 bg-white/80 p-3 shadow-sm transition-all xl:sticky xl:top-0",
              dragPreview && "border-emerald-300 ring-4 ring-emerald-500/10",
            )}
          >
            <div className="mb-3 flex items-center justify-between gap-2 px-1">
              <div className="flex items-center gap-2 text-sm font-bold text-slate-900">
                <FolderTree size={16} className="text-emerald-600" />
                分组
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] font-semibold text-slate-400">{allGroupNodes.length + 1}</span>
                <button
                  type="button"
                  onClick={() => setIsAddingGroup((value) => !value)}
                  className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-emerald-600"
                  title="新增分组"
                >
                  <FolderPlus size={15} />
                </button>
              </div>
            </div>
            {isAddingGroup && (
              <form onSubmit={createBookmarkGroup} className="mb-3 rounded-xl border border-slate-200 bg-slate-50 p-2">
                <input
                  type="text"
                  value={newGroupName}
                  onChange={(event) => setNewGroupName(event.target.value)}
                  autoFocus
                  className="mb-2 h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-900 outline-none focus:border-emerald-500"
                  placeholder="新分组名称"
                />
                <OptionSelect
                  value={newGroupParentKey}
                  options={groupParentOptions}
                  onChange={setNewGroupParentKey}
                  buttonClassName="h-9 rounded-lg px-3 py-2 text-xs"
                />
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setIsAddingGroup(false);
                      setNewGroupName("");
                      setNewGroupParentKey(NO_GROUP_VALUE);
                    }}
                    className="h-8 rounded-lg border border-slate-200 text-xs font-bold text-slate-500 transition-colors hover:bg-white"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    className="h-8 rounded-lg bg-emerald-500 text-xs font-bold text-white transition-colors hover:bg-emerald-600"
                  >
                    创建
                  </button>
                </div>
              </form>
            )}
            <div className="space-y-1">
              <button
                type="button"
                onClick={() => {
                  setActiveUngrouped(false);
                  setActiveGroupPath([]);
                }}
                className={cn(
                  "flex h-9 w-full min-w-0 items-center gap-2 rounded-xl px-2.5 text-left text-sm font-semibold transition-colors",
                  !activeUngrouped && activeGroupPath.length === 0
                    ? "bg-emerald-500/10 text-emerald-600"
                    : "text-slate-500 hover:bg-slate-50 hover:text-slate-900",
                )}
              >
                <FolderTree size={15} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">全部分组</span>
                <span className="rounded-full bg-white px-2 py-0.5 text-[11px] text-slate-400 shadow-sm">{normalizedBookmarks.length}</span>
              </button>
              <button
                type="button"
                {...getUngroupedDropProps()}
                onClick={() => {
                  setActiveUngrouped(true);
                  setActiveGroupPath([]);
                }}
                className={cn(
                  "flex h-9 w-full min-w-0 items-center gap-2 rounded-xl px-2.5 text-left text-sm font-semibold transition-colors",
                  dragOverGroupKey === UNGROUPED_GROUP_KEY
                    ? "bg-emerald-500/20 text-emerald-600 ring-2 ring-emerald-400/40"
                    : activeUngrouped
                      ? "bg-emerald-500/10 text-emerald-600"
                      : "text-slate-500 hover:bg-slate-50 hover:text-slate-900",
                )}
              >
                <Folder size={15} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">未分组</span>
                <span className="rounded-full bg-white px-2 py-0.5 text-[11px] text-slate-400 shadow-sm">{ungroupedCount}</span>
              </button>
              {allGroupNodes.map((node) => {
                const key = groupKey(node.path);
                const active = !activeUngrouped && groupKey(activeGroupPath) === key;
                return (
                  <div
                    key={key}
                    {...getGroupDropProps(node.path)}
                    style={{ paddingLeft: `${10 + Math.min(node.path.length - 1, 4) * 14}px` }}
                    className={cn(
                      "group/group flex h-9 w-full min-w-0 items-center gap-1 rounded-xl pr-1 text-left text-sm font-semibold transition-colors",
                      dragOverGroupKey === key
                        ? "bg-emerald-500/20 text-emerald-600 ring-2 ring-emerald-400/40"
                        : active
                          ? "bg-emerald-500/10 text-emerald-600"
                          : "text-slate-500 hover:bg-slate-50 hover:text-slate-900",
                    )}
                    title={node.path.join(" / ")}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setActiveUngrouped(false);
                        setActiveGroupPath(node.path);
                      }}
                      className="flex h-full min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      {node.children.length > 0 ? <FolderTree size={15} className="shrink-0" /> : <Folder size={15} className="shrink-0" />}
                      <span className="min-w-0 flex-1 truncate">{node.name}</span>
                      <span className="rounded-full bg-white px-2 py-0.5 text-[11px] text-slate-400 shadow-sm">{node.count}</span>
                    </button>
                    <button
                      type="button"
                      data-no-card-drag
                      onClick={(event) => {
                        event.stopPropagation();
                        deleteBookmarkGroup(node.path);
                      }}
                      className="shrink-0 rounded-lg p-1.5 text-slate-300 opacity-0 transition-all hover:bg-red-50 hover:text-red-500 group-hover/group:opacity-100"
                      title="删除分组"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                );
              })}
            </div>
          </aside>

        <div className="min-w-0 space-y-4">
      {/* Tags Filter */}
      {allTags.length > 0 && (
        <div className="flex gap-2 flex-wrap shrink-0">
          <button 
            onClick={() => setActiveTag(null)}
            className={cn("px-3 py-1.5 rounded-full text-xs font-medium transition-colors border", activeTag === null ? "bg-slate-100 border-slate-300 text-slate-900" : "bg-transparent border-slate-200 text-slate-400 hover:border-slate-300 hover:text-slate-600")}
          >
            全部
          </button>
          {allTags.map(tag => (
            <button 
              key={tag}
              onClick={() => setActiveTag(tag)}
              className={cn("px-3 py-1.5 rounded-full text-xs font-medium transition-colors flex items-center gap-1 border", activeTag === tag ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-600" : "bg-transparent border-slate-200 text-slate-400 hover:border-slate-300 hover:text-slate-600")}
            >
              <Tag size={12} /> {tag}
            </button>
          ))}
        </div>
      )}

      {isAdding && (
        <motion.div 
          initial={{ opacity: 0, height: 0, overflow: 'hidden' }}
          animate={{ opacity: 1, height: 'auto', overflow: 'visible' }}
          className="bg-white border border-slate-300 rounded-xl p-5 mb-2 shrink-0"
        >
          <h2 className="text-sm font-medium text-slate-900 mb-4">收藏新网址</h2>
          <form onSubmit={(e) => {
            e.preventDefault();
            if (!newUrl) return;

            let processedUrl = newUrl;
            if (!/^https?:\/\//i.test(processedUrl)) {
              processedUrl = 'https://' + processedUrl;
            }

            let derivedTitle = newTitle;
            if (!derivedTitle) {
              try {
                derivedTitle = new URL(processedUrl).hostname.replace('www.', '');
              } catch (e) {
                derivedTitle = processedUrl;
              }
            }

            const tagsArray = parseTagInput(newTags);
            const groupPath = parseGroupPathInput(newGroupPath);

            const newBookmark: BookmarkEntry = {
              id: Date.now().toString(),
              title: derivedTitle,
              url: processedUrl,
              iconUrl: deriveBookmarkIconUrl(processedUrl),
              tags: tagsArray,
              groupPath: groupPath.length > 0 ? groupPath : undefined,
              description: newDescription.trim() || undefined,
              createdAt: Date.now()
            };
            
            setBookmarks([newBookmark, ...bookmarks]);
            setIsAdding(false);
            setNewTitle("");
            setNewUrl("");
            setNewDescription("");
            setNewTags("");
            setNewGroupPath("");
          }} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">URL 链接 (必填)</label>
              <input type="text" value={newUrl} onChange={e => setNewUrl(e.target.value)} required className="w-full bg-slate-50 border border-slate-200 rounded p-2.5 text-sm text-slate-900 focus:border-emerald-500 outline-none font-mono" placeholder="google.com" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">网页标题 (选填)</label>
              <input type="text" value={newTitle} onChange={e => setNewTitle(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded p-2.5 text-sm text-slate-900 focus:border-emerald-500 outline-none" placeholder="留空则自动提取" />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-slate-400 mb-1">分组</label>
              <OptionSelect
                value={groupSelectValueFromInput(newGroupPath, groupPathByKey)}
                options={groupOptions}
                onChange={(value) => setNewGroupPath(groupInputFromSelectValue(value, groupPathByKey))}
                buttonClassName="rounded-lg px-3 py-2.5"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-slate-400 mb-1">备注</label>
              <textarea value={newDescription} onChange={e => setNewDescription(e.target.value)} rows={2} className="w-full resize-none bg-slate-50 border border-slate-200 rounded p-2.5 text-sm text-slate-900 focus:border-emerald-500 outline-none" placeholder="写一点用途、登录入口、相关项目等..." />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-slate-400 mb-1">标签</label>
              <div className="flex gap-2 mb-2">
                 <input type="text" value={newTags} onChange={e => setNewTags(e.target.value)} className="flex-1 bg-slate-50 border border-slate-200 rounded p-2.5 text-sm text-slate-900 focus:border-emerald-500 outline-none" placeholder="输入标签，按逗号分隔..." />
                 <button type="submit" className="bg-emerald-500 hover:bg-emerald-600 text-white px-6 py-2.5 rounded font-medium text-sm transition-colors whitespace-nowrap">保存书签</button>
              </div>
              {allTags.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 mt-2">
                  <span className="text-xs text-slate-400 mr-1">快捷选择:</span>
                  {allTags.map(tag => {
                    const currentTags = newTags.split(',').map(t => t.trim().toLowerCase()).filter(t => t.length > 0);
                    const isSelected = currentTags.includes(tag.toLowerCase());
                    return (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => {
                          if (isSelected) {
                            setNewTags(currentTags.filter(t => t !== tag.toLowerCase()).join(', ') + (currentTags.length > 1 ? ', ' : ''));
                          } else {
                            setNewTags([...currentTags, tag].join(', ') + ', ');
                          }
                        }}
                        className={cn(
                          "px-2.5 py-1 rounded text-xs transition-colors border cursor-pointer",
                          isSelected ? "bg-emerald-100 border-emerald-300 text-emerald-700 font-medium" : "bg-slate-50 border-slate-200 text-slate-500 hover:bg-emerald-50"
                        )}
                      >
                        {tag}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </form>
        </motion.div>
      )}

      <div className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
        <AnimatePresence>
          {filteredBookmarks.map(b => (
            <motion.div
              layout
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              key={b.id}
              onClickCapture={(event) => {
                if (!suppressClickAfterDrag.current) return;
                event.preventDefault();
                event.stopPropagation();
                suppressClickAfterDrag.current = false;
              }}
              className="group flex min-w-0 flex-col justify-between overflow-hidden rounded-xl border border-slate-200 bg-white p-4 transition-colors hover:border-slate-300"
            >
              {editingId === b.id ? (
                <form onSubmit={(e) => handleEditSave(e, b.id)} className="flex flex-col gap-3 h-full justify-between">
                  <div>
                    <input type="text" value={editUrl} onChange={e => setEditUrl(e.target.value)} required className="w-full bg-slate-50 border border-slate-200 rounded p-2 text-sm text-slate-900 focus:border-emerald-500 outline-none font-mono mb-2" placeholder="URL 链接" title="URL 链接" />
                    <input type="text" value={editTitle} onChange={e => setEditTitle(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded p-2 text-sm text-slate-900 focus:border-emerald-500 outline-none mb-2" placeholder="网页标题" title="网页标题" />
                    <OptionSelect
                      value={groupSelectValueFromInput(editGroupPath, groupPathByKey)}
                      options={groupOptions}
                      onChange={(value) => setEditGroupPath(groupInputFromSelectValue(value, groupPathByKey))}
                      className="mb-2"
                      buttonClassName="rounded p-2 text-sm"
                    />
                    <textarea value={editDescription} onChange={e => setEditDescription(e.target.value)} rows={2} className="w-full resize-none bg-slate-50 border border-slate-200 rounded p-2 text-sm text-slate-900 focus:border-emerald-500 outline-none mb-2" placeholder="备注" title="备注" />
                    <input type="text" value={editTags} onChange={e => setEditTags(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded p-2 text-sm text-slate-900 focus:border-emerald-500 outline-none" placeholder="标签(逗号分隔)" title="标签" />
                    {allTags.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5 mt-2">
                        {allTags.map(tag => {
                          const currentTags = editTags.split(',').map(t => t.trim().toLowerCase()).filter(t => t.length > 0);
                          const isSelected = currentTags.includes(tag.toLowerCase());
                          return (
                            <button
                              key={tag}
                              type="button"
                              onClick={() => {
                                if (isSelected) {
                                  setEditTags(currentTags.filter(t => t !== tag.toLowerCase()).join(', ') + (currentTags.length > 1 ? ', ' : ''));
                                } else {
                                  setEditTags([...currentTags, tag].join(', ') + ', ');
                                }
                              }}
                              className={cn(
                                "px-2 py-0.5 rounded text-[10px] transition-colors border cursor-pointer",
                                isSelected ? "bg-emerald-100 border-emerald-300 text-emerald-700 font-medium" : "bg-slate-50 border-slate-200 text-slate-500 hover:bg-emerald-50"
                              )}
                            >
                              {tag}
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                  <div className="flex gap-2 justify-end mt-2">
                    <button type="button" onClick={() => setEditingId(null)} className="px-3 py-1.5 rounded bg-slate-100 hover:bg-slate-200 text-slate-600 text-xs font-medium transition-colors">取消</button>
                    <button type="submit" className="px-3 py-1.5 rounded bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-medium transition-colors">保存更改</button>
                  </div>
                </form>
              ) : (
                <>
                   <div>
                      <div className="mb-2 flex min-w-0 items-start justify-between gap-3">
                         <div className="flex min-w-0 items-center gap-2">
                            <BookmarkLogo bookmark={b} onIconCached={markBookmarkIconCached} />
                            <h3 className="min-w-0 truncate font-medium text-slate-900" title={b.title}>{b.title}</h3>
                         </div>
                         <div className="flex shrink-0 gap-1">
                            <div
                              role="button"
                              tabIndex={0}
                              onPointerDown={(event) => startBookmarkPointerDrag(event, b)}
                              className="cursor-grab rounded-md p-1.5 text-slate-300 transition-colors hover:bg-slate-100 hover:text-emerald-600 active:cursor-grabbing"
                              title="拖到分组"
                            >
                               <GripVertical size={16} />
                            </div>
                            <div className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                            <button onClick={() => {
                               setEditingId(b.id);
                               setEditTitle(b.title);
                               setEditUrl(b.url);
                               setEditDescription(b.description ?? "");
                               setEditTags(b.tags.join(', '));
                               setEditGroupPath((b.groupPath ?? []).join(' / '));
                            }} className="p-1.5 text-slate-400 hover:text-blue-500 rounded-md transition-colors" title="编辑">
                               <Pencil size={16} />
                            </button>
                            <button onClick={async () => {
                               await writeClipboard(b.url);
                               setCopiedId(b.id);
                               setTimeout(() => setCopiedId(null), 2000);
                            }} className="p-1.5 text-slate-400 hover:text-emerald-500 rounded-md transition-colors relative" title="复制链接">
                               {copiedId === b.id ? <Check size={16} className="text-emerald-500" /> : <Copy size={16} />}
                            </button>
                            <button onClick={() => removeBookmark(b.id)} className="p-1.5 text-slate-400 hover:text-red-500 rounded-md transition-colors" title="删除">
                               <Trash2 size={16} />
                            </button>
                            <button onClick={() => openExternalUrl(b.url)} className="p-1.5 text-slate-400 hover:text-emerald-600 rounded-md transition-colors" title="在浏览器中打开">
                               <ExternalLink size={16} />
                            </button>
                            </div>
                         </div>
                      </div>
                      <button
                        onClick={() => openExternalUrl(b.url)}
                        className="mb-4 block w-full max-w-full truncate text-left font-mono text-sm text-slate-400 transition-colors hover:text-emerald-600"
                        title={b.url}
                        data-no-card-drag
                      >
                        {b.url.replace(/^https?:\/\//i, '')}
                      </button>
                      {(b.groupPath?.length || b.source) && (
                        <div className="mb-4 min-w-0 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                          {b.groupPath?.length ? (
                            <button
                              type="button"
                              onClick={() => {
                                setActiveUngrouped(false);
                                setActiveGroupPath(b.groupPath ?? []);
                              }}
                              className="flex w-full min-w-0 items-center gap-2 text-left text-xs font-semibold text-slate-500 transition-colors hover:text-emerald-600"
                              title={(b.groupPath ?? []).join(" / ")}
                            >
                              <FolderTree size={13} className="shrink-0" />
                              <span className="truncate">{(b.groupPath ?? []).join(" / ")}</span>
                            </button>
                          ) : null}
                          {b.source && (
                            <div className={cn("text-xs font-medium text-slate-400", b.groupPath?.length ? "mt-1.5" : "")}>
                              来源：{b.source}
                            </div>
                          )}
                        </div>
                      )}
                      {b.description && (
                        <p className="mb-4 max-h-20 overflow-hidden rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-sm leading-6 text-slate-500">
                          {b.description}
                        </p>
                      )}
                   </div>
                   
                   <div className="flex gap-1.5 flex-wrap">
                      {b.tags.length > 0 ? b.tags.map((tag, i) => (
                        <span key={i} className="px-2 py-0.5 bg-slate-100 border border-slate-300 text-slate-400 rounded text-xs">
                          {tag}
                        </span>
                      )) : <span className="text-xs font-medium text-slate-400">无标签</span>}
                   </div>
                </>
              )}
            </motion.div>
          ))}
        </AnimatePresence>
        {dragPreview && (
          <div
            className="pointer-events-none fixed left-0 top-0 z-[9999] w-72 rounded-2xl border border-emerald-400/70 bg-slate-950/95 px-4 py-3 text-white shadow-2xl shadow-emerald-950/30"
            style={{ transform: `translate3d(${dragPreview.x + 14}px, ${dragPreview.y + 14}px, 0)` }}
          >
            <div className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-emerald-300">
              <GripVertical size={13} /> 移动到分组
            </div>
            <div className="truncate text-sm font-bold">{dragPreview.title}</div>
            <div className="mt-1 truncate text-xs font-semibold text-slate-300">{dragPreview.subtitle}</div>
            <div className="mt-2 text-[11px] font-semibold text-emerald-300">分组高亮后松手</div>
          </div>
        )}
        
        {filteredBookmarks.length === 0 && (
          <div className="col-span-full py-16 text-center text-slate-400 border border-dashed border-slate-200 rounded-xl">
             <BookmarkIcon size={48} className="mx-auto mb-4 opacity-20" />
             <p>未找到匹配的书签</p>
          </div>
        )}
      </div>
        </div>
      </div>
    </div>
  );
}
