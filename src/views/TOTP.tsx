import { useCallback, useState, useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent } from "react";
import * as OTPAuth from "otpauth";
import { Search, Plus, Copy, Check, Trash2, Smartphone, Timer, Pencil, Github, Twitter, Mail, Server, Download, Upload, StickyNote, QrCode, FolderTree, Folder, ChevronRight, Tag, GripVertical } from "lucide-react";
import { TOTPEntry } from "../types";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "../lib/utils";
import { exportJson, importJson, requireMasterPassword, writeClipboard } from "../lib/desktop";
import { useStoreField } from "../lib/store";
import { parseGoogleAuthenticatorMigration } from "../lib/googleAuthenticatorMigration";

function parseTagInput(value: string) {
  return Array.from(new Set(value.split(",").map((tag) => tag.trim()).filter(Boolean)));
}

function parseGroupPathInput(value: string) {
  return value
    .split(/[/>]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function groupKey(path: string[] = []) {
  return path.join("\u001f");
}

const UNGROUPED_GROUP_KEY = "__omnidesk_ungrouped__";

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

function buildGroupTree(entries: TOTPEntry[]) {
  const root: GroupNode = { name: "全部", path: [], count: entries.length, children: [] };

  for (const entry of entries) {
    const path = entry.groupPath ?? [];
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

function isInGroup(entry: TOTPEntry, activeGroupPath: string[]) {
  if (activeGroupPath.length === 0) return true;
  const path = entry.groupPath ?? [];
  return activeGroupPath.every((part, index) => path[index] === part);
}

function flattenGroupNodes(node: GroupNode): GroupNode[] {
  return node.children.flatMap((child) => [child, ...flattenGroupNodes(child)]);
}

export function TOTPView() {
  const [entries, setEntries] = useStoreField("totp");
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState(0);
  const [secondsRemaining, setSecondsRemaining] = useState(30);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [revealedTokenIds, setRevealedTokenIds] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState("");
  const [isGoogleImporting, setIsGoogleImporting] = useState(false);
  const [googleMigrationText, setGoogleMigrationText] = useState("");
  const [googleImportStatus, setGoogleImportStatus] = useState("");
  const [activeGroupPath, setActiveGroupPath] = useState<string[]>([]);
  const [activeUngrouped, setActiveUngrouped] = useState(false);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [dragOverGroupKey, setDragOverGroupKey] = useState<string | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null);
  const suppressClickAfterDrag = useRef(false);

  // Modal state
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [newIssuer, setNewIssuer] = useState("");
  const [newAccount, setNewAccount] = useState("");
  const [newSecret, setNewSecret] = useState("");
  const [newNote, setNewNote] = useState("");
  const [newTags, setNewTags] = useState("");
  const [newGroupPath, setNewGroupPath] = useState("");

  const groupTree = useMemo(() => buildGroupTree(entries), [entries]);
  const activeGroupNode = useMemo(() => findGroupNode(groupTree, activeGroupPath), [groupTree, activeGroupPath]);
  const allGroupNodes = useMemo(() => flattenGroupNodes(groupTree), [groupTree]);
  const groupPathByKey = useMemo(() => {
    const map = new Map<string, string[]>();
    flattenGroupNodes(groupTree).forEach((node) => map.set(groupKey(node.path), node.path));
    return map;
  }, [groupTree]);
  const ungroupedCount = useMemo(
    () => entries.filter((entry) => !(entry.groupPath?.length)).length,
    [entries],
  );
  const allTags = useMemo(
    () => Array.from(new Set(entries.flatMap((entry) => entry.tags ?? []))).sort((a, b) => a.localeCompare(b)),
    [entries],
  );

  useEffect(() => {
    if (!activeUngrouped && activeGroupPath.length > 0 && !activeGroupNode) {
      setActiveGroupPath([]);
    }
  }, [activeGroupNode, activeGroupPath, activeUngrouped]);

  useEffect(() => {
    const updateTokens = () => {
      const newTokens: Record<string, string> = {};
      entries.forEach(entry => {
        try {
          const totp = new OTPAuth.TOTP({
            issuer: entry.issuer,
            label: entry.account,
            algorithm: entry.algorithm ?? 'SHA1',
            digits: entry.digits ?? 6,
            period: entry.period ?? 30,
            secret: entry.secret // if invalid, it throws
          });
          newTokens[entry.id] = totp.generate();
        } catch (e) {
          newTokens[entry.id] = "Error";
        }
      });
      setTokens(newTokens);
      
      const seconds = new Date().getSeconds();
      const remain = 30 - (seconds % 30);
      setSecondsRemaining(remain);
      setProgress((remain / 30) * 100);
    };

    updateTokens();
    const interval = setInterval(updateTokens, 1000);
    return () => clearInterval(interval);
  }, [entries]);

  const handleCopy = async (code: string, id: string) => {
    const verified = await requireMasterPassword("复制 TOTP 一次性验证码");
    if (!verified) return;
    await writeClipboard(code, { clearAfterSeconds: 20 });
    setCopiedId(id);
    setRevealedTokenIds(prev => ({ ...prev, [id]: true }));
    setTimeout(() => setCopiedId(null), 2000);
    setTimeout(() => {
      setRevealedTokenIds(prev => ({ ...prev, [id]: false }));
    }, 15_000);
  };

  const handleEdit = async (entry: TOTPEntry) => {
    const verified = await requireMasterPassword("编辑 TOTP Secret");
    if (!verified) return;
    setEditingId(entry.id);
    setNewIssuer(entry.issuer);
    setNewAccount(entry.account);
    setNewSecret(entry.secret);
    setNewNote(entry.note ?? "");
    setNewTags((entry.tags ?? []).join(", "));
    setNewGroupPath((entry.groupPath ?? []).join(" / "));
    setIsAdding(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleDelete = async (id: string) => {
    const verified = await requireMasterPassword("删除 TOTP Secret");
    if (!verified) return;
    setEntries(entries.filter(e => e.id !== id));
  };

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newIssuer || !newSecret) return;
    
    // Test if valid secret
    try {
      OTPAuth.Secret.fromBase32(newSecret);
    } catch (e) {
      alert("无效的 Secret 密钥");
      return;
    }

    const normalizedNote = newNote.trim();
    const tags = parseTagInput(newTags);
    const groupPath = parseGroupPathInput(newGroupPath);

    if (editingId) {
      setEntries(entries.map(entry => entry.id === editingId ? {
        ...entry,
        issuer: newIssuer,
        account: newAccount,
        secret: newSecret.replace(/\s+/g, '').toUpperCase(),
        groupPath: groupPath.length > 0 ? groupPath : undefined,
        note: normalizedNote || undefined,
        tags,
      } : entry));
    } else {
      const newEntry: TOTPEntry = {
        id: Date.now().toString(),
        issuer: newIssuer,
        account: newAccount,
        secret: newSecret.replace(/\s+/g, '').toUpperCase(),
        groupPath: groupPath.length > 0 ? groupPath : undefined,
        note: normalizedNote || undefined,
        tags,
        createdAt: Date.now()
      };
      setEntries([...entries, newEntry]);
    }
    
    setIsAdding(false);
    setEditingId(null);
    setNewIssuer("");
    setNewAccount("");
    setNewSecret("");
    setNewNote("");
    setNewTags("");
    setNewGroupPath("");
  };

  const getIssuerIcon = (issuer: string, size = 16) => {
    const ls = issuer.toLowerCase();
    if (ls.includes("github")) return <Github size={size} />;
    if (ls.includes("twitter") || ls.includes("x")) return <Twitter size={size} />;
    if (ls.includes("google") || ls.includes("mail")) return <Mail size={size} />;
    if (ls.includes("aws") || ls.includes("cloudflare") || ls.includes("server")) return <Server size={size} />;
    return <Smartphone size={size} />;
  };

  const moveEntryToGroup = useCallback((id: string, groupPath: string[]) => {
    setEntries((current) => current.map((entry) => (
      entry.id === id
        ? { ...entry, groupPath: groupPath.length > 0 ? groupPath : undefined }
        : entry
    )));
  }, [setEntries]);

  const getDropTargetFromPoint = useCallback((x: number, y: number) => {
    const dropTarget = Array.from(document.querySelectorAll<HTMLElement>("[data-omnidesk-totp-drop-key]"))
      .find((element) => {
        const rect = element.getBoundingClientRect();
        const hitPadding = 18;
        return x >= rect.left - hitPadding && x <= rect.right + hitPadding && y >= rect.top - hitPadding && y <= rect.bottom + hitPadding;
      });
    if (!dropTarget) return null;

    const key = dropTarget.dataset.omnideskTotpDropKey;
    if (!key) return null;
    if (key === UNGROUPED_GROUP_KEY) return { key, path: [] };
    const path = groupPathByKey.get(key);
    return path ? { key, path } : null;
  }, [groupPathByKey]);

  const finishPointerDrag = useCallback((id: string, x: number, y: number) => {
    const dropTarget = getDropTargetFromPoint(x, y);
    if (!dropTarget) return;
    moveEntryToGroup(id, dropTarget.path);
    setActiveUngrouped(dropTarget.key === UNGROUPED_GROUP_KEY);
    setActiveGroupPath(dropTarget.path);
  }, [getDropTargetFromPoint, moveEntryToGroup]);

  const startEntryPointerDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>, entry: TOTPEntry) => {
    if (editingId === entry.id || event.button !== 0 || isInteractiveDragTarget(event.target)) return;

    event.preventDefault();
    event.stopPropagation();

    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const drag = {
      id: entry.id,
      title: entry.issuer,
      subtitle: entry.account,
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

  const getGroupDropProps = (path: string[]) => ({
    "data-omnidesk-totp-drop-key": groupKey(path),
  });

  const getUngroupedDropProps = () => ({
    "data-omnidesk-totp-drop-key": UNGROUPED_GROUP_KEY,
  });

  const normalizedSearch = search.trim().toLowerCase();
  const filteredEntries = entries.filter(e => {
    const matchSearch = normalizedSearch
      ? e.issuer.toLowerCase().includes(normalizedSearch) ||
        e.account.toLowerCase().includes(normalizedSearch) ||
        (e.note ?? "").toLowerCase().includes(normalizedSearch) ||
        (e.groupPath ?? []).join(" ").toLowerCase().includes(normalizedSearch) ||
        (e.tags ?? []).some((tag) => tag.toLowerCase().includes(normalizedSearch))
      : true;
    const matchGroup = activeUngrouped ? !(e.groupPath?.length) : isInGroup(e, activeGroupPath);
    const matchTag = activeTag ? (e.tags ?? []).includes(activeTag) : true;
    return matchSearch && matchGroup && matchTag;
  });

  const handleExport = async () => {
    const verified = await requireMasterPassword("导出 TOTP 密钥备份");
    if (!verified) return;
    try {
      await exportJson("totp_backup.json", entries);
    } catch (error) {
      alert(error instanceof Error ? error.message : "导出失败");
    }
  };

  const handleImport = async () => {
    const verified = await requireMasterPassword("导入并覆盖 TOTP Secret");
    if (!verified) return;
    try {
      const parsed = await importJson<TOTPEntry[]>();
      if (!parsed) return;
      if (Array.isArray(parsed)) {
        setEntries(parsed);
      } else {
        alert("无效的备份文件");
      }
    } catch {
      alert("文件解析失败");
    }
  };

  const handleGoogleAuthenticatorImport = async () => {
    const verified = await requireMasterPassword("导入 Google Authenticator 迁移密钥");
    if (!verified) return;

    try {
      const result = parseGoogleAuthenticatorMigration(googleMigrationText);
      if (result.entries.length === 0) {
        setGoogleImportStatus(result.skipped.length > 0 ? `没有可导入的 TOTP：${result.skipped.join("；")}` : "没有解析到可导入的账号");
        return;
      }

      const existingKeys = new Set(entries.map((entry) => `${entry.issuer.trim().toLowerCase()}\u001f${entry.account.trim().toLowerCase()}`));
      const uniqueEntries: TOTPEntry[] = [];
      let skippedDuplicates = 0;

      for (const entry of result.entries) {
        const key = `${entry.issuer.trim().toLowerCase()}\u001f${entry.account.trim().toLowerCase()}`;
        if (existingKeys.has(key)) {
          skippedDuplicates += 1;
          continue;
        }
        existingKeys.add(key);
        uniqueEntries.push(entry);
      }

      if (uniqueEntries.length > 0) {
        setEntries([...entries, ...uniqueEntries]);
        setGoogleMigrationText("");
      }

      const messages = [`已导入 ${uniqueEntries.length} 个账号`];
      if (skippedDuplicates > 0) messages.push(`跳过重复 ${skippedDuplicates} 个`);
      if (result.skipped.length > 0) messages.push(`跳过不支持 ${result.skipped.length} 个`);
      if (result.batchHint) messages.push(result.batchHint);
      setGoogleImportStatus(messages.join("，") + "。");
    } catch (error) {
      setGoogleImportStatus(error instanceof Error ? error.message : "Google Authenticator 迁移串解析失败");
    }
  };

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto w-full h-full text-slate-800 flex flex-col gap-5 overflow-y-auto">
      <header className="flex items-end justify-between mb-2">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900 mb-2">两步验证 (TOTP)</h1>
          <p className="text-slate-400">基于时间的一次性密码，离线生成，安全可靠。</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative mr-2">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
            <input 
              type="text" 
              placeholder="搜索账号..." 
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9 pr-4 py-2 bg-white border border-slate-200 rounded-md text-sm outline-none focus:border-emerald-500 w-48 transition-all"
            />
          </div>
          
          <button 
            onClick={handleImport}
            className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-md transition-colors"
            title="导入备份"
          >
            <Upload size={18} />
          </button>
          <button
            onClick={() => {
              setIsGoogleImporting(!isGoogleImporting);
              setGoogleImportStatus("");
            }}
            className={cn(
              "inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              isGoogleImporting
                ? "bg-emerald-50 text-emerald-700"
                : "text-slate-400 hover:bg-slate-100 hover:text-slate-700",
            )}
            title="导入 Google Authenticator 迁移串"
          >
            <QrCode size={18} />
            Google 导入
          </button>
          <button 
            onClick={handleExport}
            className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-md transition-colors mr-2"
            title="导出备份"
          >
            <Download size={18} />
          </button>

          <button 
            onClick={() => {
              setEditingId(null);
              setNewIssuer("");
              setNewAccount("");
              setNewSecret("");
              setNewNote("");
              setNewTags("");
              setNewGroupPath("");
              setIsAdding(true);
            }}
            className="bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-medium py-2 px-4 rounded-md flex items-center gap-2 transition-colors shadow-sm"
          >
            <Plus size={16} /> 添加
          </button>
        </div>
      </header>

      {isGoogleImporting && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-xl border border-emerald-200 bg-white p-5"
        >
          <div className="mb-3 flex items-start justify-between gap-4">
            <div>
              <h2 className="flex items-center gap-2 text-lg font-medium text-slate-900">
                <QrCode size={18} className="text-emerald-600" />
                Google Authenticator 导入
              </h2>
              <p className="mt-1 text-sm font-medium text-slate-400">
                粘贴导出二维码里的 otpauth-migration://...，支持一次导入多个账号。
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setIsGoogleImporting(false);
                setGoogleMigrationText("");
                setGoogleImportStatus("");
              }}
              className="rounded-lg px-3 py-2 text-sm font-semibold text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
            >
              关闭
            </button>
          </div>
          <textarea
            value={googleMigrationText}
            onChange={(event) => setGoogleMigrationText(event.target.value)}
            rows={4}
            spellCheck={false}
            autoComplete="off"
            className="w-full resize-none rounded-xl border border-slate-200 bg-slate-50 p-3 font-mono text-sm leading-6 text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-emerald-500"
            placeholder="otpauth-migration://offline?data=..."
          />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs font-medium text-slate-400">
              导入会合并到本地加密库，已存在的同名账号会跳过。
            </div>
            <button
              type="button"
              onClick={handleGoogleAuthenticatorImport}
              disabled={!googleMigrationText.trim()}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Upload size={16} />
              导入迁移串
            </button>
          </div>
          {googleImportStatus && (
            <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700">
              {googleImportStatus}
            </div>
          )}
        </motion.div>
      )}

      {isAdding && (
        <motion.div 
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white border border-slate-300 rounded-xl p-5 mb-4"
        >
          <h2 className="text-lg font-medium text-slate-900 mb-4">{editingId ? '编辑 TOTP' : '添加新 TOTP'}</h2>
          <form onSubmit={handleAdd} className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <div>
               <label className="block text-xs font-medium text-slate-400 mb-1">发行方 (如 Google)</label>
               <input type="text" value={newIssuer} onChange={e => setNewIssuer(e.target.value)} required className="w-full bg-slate-50 border border-slate-200 rounded p-2.5 text-sm text-slate-900 focus:border-emerald-500 outline-none" />
            </div>
            <div>
               <label className="block text-xs font-medium text-slate-400 mb-1">账号 (可选)</label>
               <input type="text" value={newAccount} onChange={e => setNewAccount(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded p-2.5 text-sm text-slate-900 focus:border-emerald-500 outline-none" />
            </div>
            <div className="md:col-span-2">
               <label className="block text-xs font-medium text-slate-400 mb-1">密钥 (Secret Key) / otpauth:// URI</label>
               <div className="flex gap-2">
                 <input 
                   type="text" 
                   value={newSecret} 
                   onChange={e => {
                     const val = e.target.value;
                     if (val.startsWith('otpauth://')) {
                       try {
                         const url = new URL(val);
                         const secret = url.searchParams.get('secret');
                         let issuer = url.searchParams.get('issuer') || '';
                         let account = '';
                         
                         const pathParts = decodeURIComponent(url.pathname).replace(/^\//, '').split(':');
                         if (pathParts.length > 1) {
                           if (!issuer) issuer = pathParts[0];
                           account = pathParts.slice(1).join(':').trim();
                         } else {
                           account = pathParts[0];
                         }
                         
                         if (secret) setNewSecret(secret);
                         if (issuer) setNewIssuer(issuer);
                         if (account) setNewAccount(account);
                         return;
                       } catch(err) {}
                     }
                     setNewSecret(val);
                   }} 
                   required 
                   className="flex-1 bg-slate-50 border border-slate-200 rounded p-2.5 text-sm font-mono text-slate-900 focus:border-emerald-500 outline-none uppercase placeholder:normal-case" 
                   placeholder="支持直接粘贴 otpauth:// 链接" 
                 />
                 <button type="submit" className="bg-emerald-500 hover:bg-emerald-600 text-white px-4 py-2.5 rounded font-medium text-sm transition-colors whitespace-nowrap">保存配置</button>
                 <button type="button" onClick={() => setIsAdding(false)} className="bg-slate-100 hover:bg-slate-200 text-slate-900 px-4 py-2.5 rounded font-medium text-sm transition-colors whitespace-nowrap">取消</button>
               </div>
            </div>
            <div className="md:col-span-4">
               <label className="block text-xs font-medium text-slate-400 mb-1">分组路径</label>
               <input
                 type="text"
                 value={newGroupPath}
                 onChange={e => setNewGroupPath(e.target.value)}
                 className="w-full rounded border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-emerald-500"
                 placeholder="例如：工作 / 云服务 / 生产环境，可嵌套"
               />
            </div>
            <div className="md:col-span-4">
               <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-400">
                 <StickyNote size={14} /> 备注 (可选)
               </label>
               <textarea
                 value={newNote}
                 onChange={e => setNewNote(e.target.value)}
                 rows={2}
                 className="w-full resize-none rounded border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm leading-6 text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-emerald-500"
                 placeholder="例如：公司主账号、备用验证器、恢复码保存位置、登录入口等"
               />
            </div>
            <div className="md:col-span-4">
               <label className="block text-xs font-medium text-slate-400 mb-1">标签 (逗号分隔)</label>
               <input
                 type="text"
                 value={newTags}
                 onChange={e => setNewTags(e.target.value)}
                 className="w-full rounded border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-emerald-500"
                 placeholder="例如：工作, 个人, 云服务"
               />
            </div>
          </form>
        </motion.div>
      )}

      {/* Progress Line */}
      <div className="flex items-center gap-3 mb-6">
        <div className="h-1.5 flex-1 bg-slate-100 rounded-full overflow-hidden relative">
          <div 
             className={cn("absolute top-0 bottom-0 left-0 transition-all duration-1000 ease-linear", progress <= 16.66 ? "bg-red-500" : "bg-emerald-500")}
             style={{ width: `${progress}%` }}
          ></div>
        </div>
        <div className="text-xs font-medium text-slate-400 font-mono w-6 text-right">{secondsRemaining}s</div>
      </div>

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
            <span className="text-[11px] font-semibold text-slate-400">{allGroupNodes.length + 1}</span>
          </div>
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
              <span className="rounded-full bg-white px-2 py-0.5 text-[11px] text-slate-400 shadow-sm">{entries.length}</span>
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
                <button
                  key={key}
                  type="button"
                  {...getGroupDropProps(node.path)}
                  onClick={() => {
                    setActiveUngrouped(false);
                    setActiveGroupPath(node.path);
                  }}
                  style={{ paddingLeft: `${10 + Math.min(node.path.length - 1, 4) * 14}px` }}
                  className={cn(
                    "flex h-9 w-full min-w-0 items-center gap-2 rounded-xl pr-2.5 text-left text-sm font-semibold transition-colors",
                    dragOverGroupKey === key
                      ? "bg-emerald-500/20 text-emerald-600 ring-2 ring-emerald-400/40"
                      : active
                        ? "bg-emerald-500/10 text-emerald-600"
                        : "text-slate-500 hover:bg-slate-50 hover:text-slate-900",
                  )}
                  title={node.path.join(" / ")}
                >
                  {node.children.length > 0 ? <FolderTree size={15} className="shrink-0" /> : <Folder size={15} className="shrink-0" />}
                  <span className="min-w-0 flex-1 truncate">{node.name}</span>
                  <span className="rounded-full bg-white px-2 py-0.5 text-[11px] text-slate-400 shadow-sm">{node.count}</span>
                </button>
              );
            })}
            {allGroupNodes.length === 0 && (
              <div className="px-2.5 py-3 text-xs font-medium leading-5 text-slate-400">
                编辑账号时填写“工作 / 项目”即可生成嵌套分组。
              </div>
            )}
          </div>
        </aside>

        <div className="min-w-0 space-y-4">
          {allTags.length > 0 && (
        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setActiveTag(null)}
            className={cn(
              "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
              activeTag === null ? "border-slate-300 bg-slate-100 text-slate-900" : "border-slate-200 bg-transparent text-slate-400 hover:border-slate-300 hover:text-slate-600",
            )}
          >
            全部
          </button>
          {allTags.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => setActiveTag(tag)}
              className={cn(
                "flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                activeTag === tag ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600" : "border-slate-200 bg-transparent text-slate-400 hover:border-slate-300 hover:text-slate-600",
              )}
            >
              <Tag size={12} /> {tag}
            </button>
          ))}
        </div>
      )}

      <div className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
        <AnimatePresence>
          {filteredEntries.map(entry => {
            const token = tokens[entry.id] || "------";
            const isExpiring = progress <= 16.66;
            const isRevealed = Boolean(revealedTokenIds[entry.id]);
            return (
              <motion.div 
                layout
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                key={entry.id} 
                onClickCapture={(event) => {
                  if (!suppressClickAfterDrag.current) return;
                  event.preventDefault();
                  event.stopPropagation();
                  suppressClickAfterDrag.current = false;
                }}
                className={cn(
                   "group relative flex min-w-0 flex-col justify-between overflow-hidden rounded-xl border bg-white p-4 transition-colors",
                   isExpiring ? "border-red-200" : "border-slate-200 hover:border-slate-300"
                )}
              >
                <div className="relative z-10 mb-4 flex min-w-0 items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <div className={cn("w-8 h-8 rounded-full flex items-center justify-center shrink-0", isExpiring ? "bg-red-50 text-red-400" : "bg-slate-100 text-slate-500")}>
                      {getIssuerIcon(entry.issuer)}
                    </div>
                    <div className="min-w-0 flex-1 overflow-hidden">
                      <h3 className="truncate font-medium text-slate-900" title={entry.issuer}>{entry.issuer}</h3>
                      <p className="truncate text-xs text-slate-400" title={entry.account}>{entry.account}</p>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <div
                      role="button"
                      tabIndex={0}
                      onPointerDown={(event) => startEntryPointerDrag(event, entry)}
                      className="cursor-grab rounded-md p-1.5 text-slate-300 transition-colors hover:bg-slate-100 hover:text-emerald-600 active:cursor-grabbing"
                      title="拖到分组"
                    >
                      <GripVertical size={16} />
                    </div>
                    <div className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <button 
                      onClick={() => handleEdit(entry)}
                      className="p-1.5 text-slate-400 hover:text-blue-500 rounded-md transition-colors"
                      title="编辑"
                    >
                      <Pencil size={16} />
                    </button>
                    <button 
                      onClick={() => handleDelete(entry.id)}
                      className="p-1.5 text-slate-400 hover:text-red-500 rounded-md transition-colors"
                      title="删除"
                    >
                      <Trash2 size={16} />
                    </button>
                    </div>
                  </div>
                </div>

                {entry.groupPath?.length ? (
                  <button
                    type="button"
                    onClick={() => {
                      setActiveUngrouped(false);
                      setActiveGroupPath(entry.groupPath ?? []);
                    }}
                    className="relative z-10 mb-4 flex w-full min-w-0 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-left text-xs font-semibold text-slate-500 transition-colors hover:text-emerald-600"
                    title={(entry.groupPath ?? []).join(" / ")}
                  >
                    <FolderTree size={13} className="shrink-0" />
                    <span className="truncate">{(entry.groupPath ?? []).join(" / ")}</span>
                  </button>
                ) : null}

                {entry.note && (
                  <div className="relative z-10 mb-4 rounded-lg border border-emerald-100 bg-emerald-50/70 px-3 py-2 text-xs leading-5 text-slate-600">
                    <div className="mb-1 flex items-center gap-1.5 font-medium text-emerald-700">
                      <StickyNote size={13} /> 备注
                    </div>
                    <p className="whitespace-pre-wrap break-words">{entry.note}</p>
                  </div>
                )}

                {(entry.tags ?? []).length > 0 && (
                  <div className="relative z-10 mb-4 flex flex-wrap gap-1.5">
                    {(entry.tags ?? []).map((tag) => (
                      <span key={tag} className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-500">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}

                <div 
                  data-no-card-drag
                  onClick={() => handleCopy(token, entry.id)}
                  className="bg-slate-50 rounded-lg p-3 flex justify-center items-center cursor-pointer hover:bg-slate-100 transition-colors group/code relative z-10 overflow-hidden"
                >
                  <span className={cn(
                    "text-3xl font-mono tracking-[0.2em] font-bold drop-shadow-sm transition-all duration-300",
                    isExpiring ? "text-red-500 animate-pulse" : "text-emerald-600",
                    isRevealed ? "opacity-100" : "blur-md opacity-40"
                  )}>
                    {token.substring(0,3)} {token.substring(3,6)}
                  </span>
                  
                  <div className={cn(
                    "absolute inset-0 flex items-center justify-center font-medium text-slate-400 text-sm transition-opacity pointer-events-none tracking-widest",
                    isRevealed ? "opacity-0" : "opacity-100"
                  )}>
                    <span>•••• ••••</span>
                  </div>
                  
                  {copiedId === entry.id && (
                    <div className="absolute inset-0 bg-emerald-500 rounded-lg flex items-center justify-center text-white font-medium gap-1 text-sm z-20">
                      <Check size={16} /> 已复制
                    </div>
                  )}
                </div>
              </motion.div>
            );
          })}
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
            <div className="mt-1 truncate text-xs font-semibold text-slate-300">{dragPreview.subtitle || "未填写账号"}</div>
            <div className="mt-2 text-[11px] font-semibold text-emerald-300">分组高亮后松手</div>
          </div>
        )}
        {entries.length === 0 && !isAdding && (
          <div className="col-span-full py-12 text-center text-slate-400 border border-dashed border-slate-200 rounded-xl">
             <Timer size={48} className="mx-auto mb-4 opacity-20" />
             <p>暂无 TOTP 账号</p>
          </div>
        )}
        {entries.length > 0 && filteredEntries.length === 0 && (
          <div className="col-span-full py-12 text-center text-slate-400">
             <p>未找到匹配的账号</p>
          </div>
        )}
      </div>
        </div>
      </div>
    </div>
  );
}
