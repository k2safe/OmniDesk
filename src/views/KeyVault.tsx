import { useState } from "react";
import { Search, Plus, Key, Check, RefreshCw, Copy, Trash2, Pencil, Download, Upload, Eye, EyeOff, FileLock2 } from "lucide-react";
import { PasswordEntry } from "../types";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "../lib/utils";
import { exportJson, importJson, requireMasterPassword, writeClipboard } from "../lib/desktop";
import { useStoreField } from "../lib/store";
import { VaultFilesPanel } from "../components/VaultFilesPanel";

type VaultTab = "credentials" | "files";

export function KeyVault() {
  const [passwords, setPasswords] = useStoreField("vault");
  const [files] = useStoreField("fileVault");
  const [activeTab, setActiveTab] = useState<VaultTab>("credentials");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [revealedPasswords, setRevealedPasswords] = useState<Record<string, boolean>>({});
  
  const toggleVisibility = async (id: string) => {
     if (!revealedPasswords[id]) {
       const verified = await requireMasterPassword("查看金库敏感凭据");
       if (!verified) return;
     }
     setRevealedPasswords(prev => ({
        ...prev,
        [id]: !prev[id]
     }));
  };
  
  // Add/Edit State
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle || !newPassword) return;

    if (editingId) {
      setPasswords(passwords.map(p => p.id === editingId ? {
        ...p,
        title: newTitle,
        username: newUsername,
        passwordEncrypted: newPassword
      } : p));
    } else {
      setPasswords([{
        id: Date.now().toString(),
        title: newTitle,
        username: newUsername,
        passwordEncrypted: newPassword,
        createdAt: Date.now()
      }, ...passwords]);
    }
    setIsAdding(false);
    setEditingId(null);
    setNewTitle("");
    setNewUsername("");
    setNewPassword("");
  };

  const handleExport = async () => {
    const verified = await requireMasterPassword("导出金库备份");
    if (!verified) return;
    try {
      await exportJson("vault_backup.json", passwords);
    } catch (error) {
      alert(error instanceof Error ? error.message : "导出失败");
    }
  };

  const handleImport = async () => {
    const verified = await requireMasterPassword("导入并覆盖保险箱凭据");
    if (!verified) return;
    try {
      const parsed = await importJson<PasswordEntry[]>();
      if (!parsed) return;
      if (Array.isArray(parsed)) setPasswords(parsed);
      else alert("无效的备份文件");
    } catch {
      alert("文件解析失败");
    }
  };

  // Generator State
  const [length, setLength] = useState(16);
  const [includeSymbols, setIncludeSymbols] = useState(true);
  const [includeNumbers, setIncludeNumbers] = useState(true);
  const [generatedResult, setGeneratedResult] = useState("");

  const handleCopy = async (text: string, id: string, options?: { sensitive?: boolean }) => {
    try {
      if (options?.sensitive) {
        const verified = await requireMasterPassword("复制保险箱敏感凭据");
        if (!verified) return;
      }
      await writeClipboard(text, { clearAfterSeconds: options?.sensitive ? 20 : undefined });
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (error) {
      alert(error instanceof Error ? error.message : "复制失败");
    }
  };

  const handleDeletePassword = async (id: string) => {
    const verified = await requireMasterPassword("删除保险箱敏感凭据");
    if (!verified) return;
    setPasswords(passwords.filter(p => p.id !== id));
    setRevealedPasswords(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const generatePassword = () => {
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const symbols = "!@#$%^&*()_+~`|}{[]:;?><,./-=";
    const numbers = "0123456789";
    
    let validChars = chars;
    if (includeSymbols) validChars += symbols;
    if (includeNumbers) validChars += numbers;

    const randomValues = new Uint32Array(length);
    crypto.getRandomValues(randomValues);
    let res = "";
    for(let i=0; i<length; i++) {
        res += validChars.charAt(randomValues[i] % validChars.length);
    }
    setGeneratedResult(res);
  };

  return (
    <div className="p-8 max-w-5xl mx-auto w-full h-full text-slate-800 flex flex-col gap-6 overflow-y-auto">
      <header>
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 mb-2">保险箱</h1>
        <p className="text-slate-400">本地 AES-256 加密保存账号凭据与私密文件。</p>
      </header>

      <div className="flex w-fit rounded-2xl border border-slate-200 bg-white p-1 shadow-sm">
        <button
          onClick={() => setActiveTab("credentials")}
          className={cn(
            "inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition-all",
            activeTab === "credentials" ? "bg-emerald-50 text-emerald-700 shadow-sm" : "text-slate-400 hover:text-slate-700",
          )}
        >
          <Key size={16} /> 账号凭据
          <span className="rounded-full bg-white/80 px-2 py-0.5 text-xs text-slate-400">{passwords.length}</span>
        </button>
        <button
          onClick={() => setActiveTab("files")}
          className={cn(
            "inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition-all",
            activeTab === "files" ? "bg-emerald-50 text-emerald-700 shadow-sm" : "text-slate-400 hover:text-slate-700",
          )}
        >
          <FileLock2 size={16} /> 加密文件
          <span className="rounded-full bg-white/80 px-2 py-0.5 text-xs text-slate-400">{files.length}</span>
        </button>
      </div>

      {activeTab === "credentials" ? (
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* 指南针 / 生成器 */}
        <div className="lg:col-span-1 bg-white border border-slate-200 rounded-xl p-5 h-fit">
          <div className="flex items-center gap-2 mb-4 text-slate-900 font-medium">
            <RefreshCw size={18} className="text-blue-400" />
            密码生成
          </div>
          
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
            <div className="flex min-h-[72px] items-center justify-center px-4 py-4 text-center font-mono text-lg text-emerald-600">
              <span className="max-w-full break-all">{generatedResult || "点击生成"}</span>
            </div>
            {generatedResult && (
              <div className="grid grid-cols-2 border-t border-slate-200 bg-white/70">
                <button
                  onClick={() => handleCopy(generatedResult, "gen")}
                  className="inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-semibold text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
                  title="复制"
                >
                  {copiedId === "gen" ? <Check size={15} className="text-emerald-600" /> : <Copy size={15} />}
                  {copiedId === "gen" ? "已复制" : "复制"}
                </button>
                <button
                  onClick={() => {
                    setNewPassword(generatedResult);
                    setEditingId(null);
                    setNewTitle("");
                    setNewUsername("");
                    setIsAdding(true);
                  }}
                  className="inline-flex items-center justify-center gap-2 border-l border-slate-200 px-3 py-2 text-xs font-semibold text-emerald-600 transition-colors hover:bg-emerald-50"
                  title="使用此密码建立新记录"
                >
                  <Plus size={15} />
                  新建
                </button>
              </div>
            )}
          </div>

          <div className="mt-6 space-y-4">
            <div>
              <label className="flex justify-between text-sm text-slate-600 mb-2">
                <span>密码长度</span>
                <span>{length} 位</span>
              </label>
              <input 
                type="range" 
                min="8" max="64" 
                value={length} 
                onChange={(e) => setLength(parseInt(e.target.value))}
                className="w-full accent-emerald-500"
              />
            </div>
            
            <label className="flex items-center justify-between text-sm cursor-pointer hover:bg-slate-50 p-2 rounded -mx-2">
              <span className="text-slate-600">包含数字 (0-9)</span>
              <input type="checkbox" checked={includeNumbers} onChange={(e) => setIncludeNumbers(e.target.checked)} className="accent-emerald-500 w-4 h-4" />
            </label>

            <label className="flex items-center justify-between text-sm cursor-pointer hover:bg-slate-50 p-2 rounded -mx-2">
              <span className="text-slate-600">包含特殊符号 (!@#$)</span>
              <input type="checkbox" checked={includeSymbols} onChange={(e) => setIncludeSymbols(e.target.checked)} className="accent-emerald-500 w-4 h-4" />
            </label>

             <button 
              onClick={generatePassword}
              className="mt-4 w-full bg-slate-100 hover:bg-slate-200 text-slate-900 font-medium py-2 px-4 rounded-lg flex items-center justify-center gap-2 border border-slate-300 hover:border-slate-400 transition-all"
            >
              生成独立密码
            </button>
          </div>
        </div>

        {/* 密码列表 */}
        <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl p-5 flex flex-col">
           <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-4 gap-2">
              <div className="flex items-center gap-2 text-slate-900 font-medium whitespace-nowrap">
                <Key size={18} className="text-yellow-400" />
                本地凭据
              </div>
              <div className="flex items-center gap-2 w-full sm:w-auto">
                <div className="relative flex-1 sm:flex-none">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                  <input 
                    type="text" 
                    placeholder="搜索凭据..." 
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    className="pl-9 pr-4 py-1.5 w-full sm:w-48 bg-slate-50 border border-slate-200 rounded-md text-sm outline-none focus:border-emerald-500 transition-all"
                  />
                </div>
                
                <button 
                  onClick={handleImport}
                  className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-md transition-colors shrink-0"
                  title="导入备份"
                >
                  <Upload size={18} />
                </button>
                <button 
                  onClick={handleExport}
                  className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-md transition-colors shrink-0 mr-1"
                  title="导出备份"
                >
                  <Download size={18} />
                </button>

                <button 
                  onClick={() => {
                    setEditingId(null);
                    setNewTitle("");
                    setNewUsername("");
                    setNewPassword("");
                    setIsAdding(true);
                  }}
                  className="bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-medium py-1.5 px-3 rounded-md flex items-center gap-1 transition-colors shrink-0"
                >
                  <Plus size={16} /> 增加
                </button>
              </div>
           </div>

           {isAdding && !editingId && (
              <form onSubmit={handleSave} className="bg-slate-50 border border-slate-200 rounded-lg p-4 mb-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
                 <div className="sm:col-span-2">
                    <label className="block text-xs font-medium text-slate-400 mb-1">标题</label>
                    <input type="text" value={newTitle} onChange={e => setNewTitle(e.target.value)} required className="w-full bg-white border border-slate-200 rounded p-2 text-sm text-slate-900 focus:border-emerald-500 outline-none" placeholder="如: Google 账号" />
                 </div>
                 <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">标识 / 账号 (选填)</label>
                    <input type="text" value={newUsername} onChange={e => setNewUsername(e.target.value)} className="w-full bg-white border border-slate-200 rounded p-2 text-sm text-slate-900 focus:border-emerald-500 outline-none" placeholder="可留空，如 user@email.com 或 ETH Wallet" />
                 </div>
                 <div className="sm:col-span-2">
                    <label className="block text-xs font-medium text-slate-400 mb-1">凭据内容 (密码 / 私钥 / 助记词 / Token)</label>
                    <textarea value={newPassword} onChange={e => setNewPassword(e.target.value)} required className="w-full bg-white border border-slate-200 rounded p-2 text-sm font-mono text-slate-900 focus:border-emerald-500 outline-none min-h-[80px]" placeholder="••••••••" />
                 </div>
                 <div className="sm:col-span-2 flex justify-end gap-2 mt-2">
                    <button type="button" onClick={() => setIsAdding(false)} className="px-3 py-1.5 rounded bg-white border border-slate-200 hover:bg-slate-50 text-slate-600 text-sm font-medium transition-colors">取消</button>
                    <button type="submit" className="px-4 py-1.5 rounded bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-medium transition-colors">保存记录</button>
                 </div>
              </form>
           )}

           <div className="space-y-3 overflow-y-auto flex-1">
             <AnimatePresence>
                {passwords.filter(pw => 
                   pw.title.toLowerCase().includes(search.toLowerCase()) || 
                   pw.username.toLowerCase().includes(search.toLowerCase())
                ).map((pw) => (
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    key={pw.id} 
                    className="group bg-slate-50 border border-slate-200 rounded-lg p-4 flex flex-col justify-between hover:border-slate-300 transition-colors"
                  >
                    {editingId === pw.id ? (
                      <form onSubmit={handleSave} className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full">
                         <div className="sm:col-span-2">
                            <label className="block text-xs font-medium text-slate-400 mb-1">标题</label>
                            <input type="text" value={newTitle} onChange={e => setNewTitle(e.target.value)} required className="w-full bg-white border border-slate-200 rounded p-2 text-sm text-slate-900 focus:border-emerald-500 outline-none" />
                         </div>
                         <div>
                            <label className="block text-xs font-medium text-slate-400 mb-1">标识 / 账号 (选填)</label>
                            <input type="text" value={newUsername} onChange={e => setNewUsername(e.target.value)} className="w-full bg-white border border-slate-200 rounded p-2 text-sm text-slate-900 focus:border-emerald-500 outline-none" placeholder="可留空" />
                         </div>
                         <div className="sm:col-span-2">
                            <label className="block text-xs font-medium text-slate-400 mb-1">凭据内容</label>
                            <textarea value={newPassword} onChange={e => setNewPassword(e.target.value)} required className="w-full bg-white border border-slate-200 rounded p-2 text-sm font-mono text-slate-900 focus:border-emerald-500 outline-none min-h-[80px]" />
                         </div>
                         <div className="sm:col-span-2 flex justify-end gap-2 mt-1">
                            <button type="button" onClick={() => setEditingId(null)} className="px-3 py-1 rounded bg-white border border-slate-200 hover:bg-slate-50 text-slate-600 text-xs font-medium transition-colors">取消</button>
                            <button type="submit" className="px-3 py-1 rounded bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-medium transition-colors">更新</button>
                         </div>
                      </form>
                    ) : (
                      <div className="flex items-center justify-between w-full h-full">
                        <div className="overflow-hidden pr-2">
                          <h3 className="text-slate-900 font-medium truncate">{pw.title}</h3>
                          <p className="text-slate-400 text-sm font-mono mt-1 truncate">{pw.username || "无账号"}</p>
                          {revealedPasswords[pw.id] && (
                            <p className="text-emerald-600 text-sm font-mono mt-2 break-all whitespace-pre-wrap bg-emerald-50 inline-block px-2 py-1 rounded w-full">{pw.passwordEncrypted}</p>
                          )}
                        </div>
                        <div className="flex flex-col sm:flex-row items-end sm:items-center gap-2 shrink-0">
                          <div className="flex items-center gap-2 opacity-100 sm:opacity-0 group-hover:opacity-100 transition-opacity">
                            <button 
                              onClick={() => toggleVisibility(pw.id)}
                              className="p-1.5 text-slate-400 hover:text-emerald-500 rounded transition-colors"
                              title="显示/隐藏密码"
                            >
                               {revealedPasswords[pw.id] ? <EyeOff size={14} /> : <Eye size={14} />}
                            </button>
                            <button 
                              onClick={async () => {
                                const verified = await requireMasterPassword("编辑金库敏感凭据");
                                if (!verified) return;
                                setEditingId(pw.id);
                                setNewTitle(pw.title);
                                setNewUsername(pw.username);
                                setNewPassword(pw.passwordEncrypted);
                                setIsAdding(false);
                              }}
                              className="p-1.5 text-slate-400 hover:text-blue-500 rounded transition-colors"
                              title="编辑"
                            >
                               <Pencil size={14} />
                            </button>
                            <button 
                              onClick={() => handleDeletePassword(pw.id)}
                              className="p-1.5 text-slate-400 hover:text-red-500 rounded transition-colors"
                              title="删除"
                            >
                               <Trash2 size={14} />
                            </button>
                          </div>
                          
                          <div className="flex gap-2 mt-2 sm:mt-0">
                            <button 
                              onClick={() => handleCopy(pw.username, `user-${pw.id}`)}
                              className="flex items-center gap-1 px-2.5 py-1.5 bg-white hover:bg-slate-100 rounded text-xs font-medium border border-slate-200 transition-colors"
                              title="Copy Username"
                            >
                               {copiedId === `user-${pw.id}` ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />} 账号
                            </button>
                            <button 
                               onClick={() => handleCopy(pw.passwordEncrypted, `pass-${pw.id}`, { sensitive: true })}
                              className="flex items-center gap-1 px-2.5 py-1.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-600 rounded text-xs font-medium border border-emerald-200 transition-colors"
                              title="Copy Password"
                            >
                               {copiedId === `pass-${pw.id}` ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />} 复制凭据
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </motion.div>
                ))}
             </AnimatePresence>
             
             {passwords.length > 0 && passwords.filter(pw => pw.title.toLowerCase().includes(search.toLowerCase()) || pw.username.toLowerCase().includes(search.toLowerCase())).length === 0 && (
               <div className="py-12 text-center text-slate-400">
                  <p>未找到匹配的凭据</p>
               </div>
             )}
             {passwords.length === 0 && !isAdding && (
               <div className="py-12 text-center text-slate-400">
                  <p>金库为空</p>
               </div>
             )}
           </div>
        </div>
      </div>
      ) : (
        <VaultFilesPanel />
      )}
    </div>
  );
}
