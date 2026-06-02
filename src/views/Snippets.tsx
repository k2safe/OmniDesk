import { useState } from "react";
import { Code, Copy, Check, Plus, Trash2, Search, Tag } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { writeClipboard } from "../lib/desktop";
import { useStoreField } from "../lib/store";

export function Snippets() {
  const [snippets, setSnippets] = useStoreField("snippets");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newLanguage, setNewLanguage] = useState("typescript");
  const [newCode, setNewCode] = useState("");
  const [newTags, setNewTags] = useState("");

  const handleCopy = async (code: string, id: string) => {
    await writeClipboard(code);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle || !newCode) return;
    setSnippets([{
      id: Date.now().toString(),
      title: newTitle,
      language: newLanguage,
      code: newCode,
      tags: newTags.split(",").map((tag) => tag.trim()).filter(Boolean),
      createdAt: Date.now()
    }, ...snippets]);
    setIsAdding(false);
    setNewTitle("");
    setNewCode("");
    setNewTags("");
  };

  const filteredSnippets = snippets.filter((snippet) => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return true;
    return `${snippet.title} ${snippet.language} ${snippet.code} ${(snippet.tags ?? []).join(" ")}`.toLowerCase().includes(keyword);
  });

  return (
    <div className="p-8 max-w-5xl mx-auto w-full h-full text-slate-800 flex flex-col gap-6 overflow-y-auto">
      <header className="flex items-end justify-between gap-4 shrink-0">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900 mb-2">代码片段管家 (Snippets)</h1>
          <p className="text-slate-400">本地版的 Gist，快速找回祖传代码。</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="w-60 rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-900 outline-none transition-colors focus:border-emerald-500"
              placeholder="搜索标题、语言、代码或标签..."
            />
          </div>
          <button 
            onClick={() => setIsAdding(true)}
            className="bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-medium py-2 px-4 rounded-md flex items-center gap-2 transition-colors"
          >
            <Plus size={16} /> 新增片段
          </button>
        </div>
      </header>

      {isAdding && (
        <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="bg-white border border-slate-300 rounded-xl p-5 shrink-0">
          <form onSubmit={handleAdd} className="flex flex-col gap-4">
            <div className="flex gap-4">
              <input type="text" value={newTitle} onChange={e => setNewTitle(e.target.value)} required placeholder="片段名称" className="flex-1 bg-slate-50 border border-slate-200 rounded p-2.5 text-sm text-slate-900 focus:border-emerald-500 outline-none" />
              <input type="text" value={newLanguage} onChange={e => setNewLanguage(e.target.value)} required placeholder="语言 (如: ts, js, python)" className="w-48 bg-slate-50 border border-slate-200 rounded p-2.5 text-sm text-slate-900 focus:border-emerald-500 outline-none" />
            </div>
            <input type="text" value={newTags} onChange={e => setNewTags(e.target.value)} placeholder="标签，按逗号分隔..." className="w-full bg-slate-50 border border-slate-200 rounded p-2.5 text-sm text-slate-900 focus:border-emerald-500 outline-none" />
            <textarea value={newCode} onChange={e => setNewCode(e.target.value)} required placeholder="在此粘贴代码..." className="w-full bg-slate-50 border border-slate-200 rounded p-4 text-sm font-mono text-emerald-600 focus:border-emerald-500 outline-none h-48 resize-none" spellCheck={false} />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setIsAdding(false)} className="px-4 py-2 text-slate-400 hover:text-slate-900 transition-colors text-sm font-medium">取消</button>
              <button type="submit" className="bg-emerald-500 hover:bg-emerald-600 text-white px-6 py-2 rounded text-sm font-medium transition-colors">保存片段</button>
            </div>
          </form>
        </motion.div>
      )}

      <div className="grid grid-cols-1 gap-6">
        <AnimatePresence>
          {filteredSnippets.map(snippet => (
            <motion.div layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} key={snippet.id} className="bg-white border border-slate-200 rounded-xl overflow-hidden group">
              <div className="bg-slate-800/50 border-b border-slate-200 p-3 px-5 flex justify-between items-center text-sm">
                <div className="flex items-center gap-3">
                  <span className="font-medium text-slate-900 flex items-center gap-2"><Code size={16} className="text-emerald-600" /> {snippet.title}</span>
                  <span className="bg-slate-100 px-2 py-0.5 rounded text-xs text-slate-400 border border-slate-300">{snippet.language}</span>
                  {(snippet.tags ?? []).map((tag) => (
                    <span key={tag} className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-2 py-0.5 text-xs text-slate-400">
                      <Tag size={11} /> {tag}
                    </span>
                  ))}
                </div>
                <div className="flex gap-2">
                  <button onClick={() => handleCopy(snippet.code, snippet.id)} className="flex items-center gap-1.5 text-slate-400 hover:text-slate-900 transition-colors">
                    {copiedId === snippet.id ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />} 
                    <span className="text-xs">复制</span>
                  </button>
                  <button onClick={() => setSnippets(snippets.filter(s => s.id !== snippet.id))} className="text-slate-400 hover:text-red-500 transition-colors ml-2 opacity-0 group-hover:opacity-100">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              <div className="p-5 overflow-x-auto bg-[#0d131f]">
                <pre className="text-sm font-mono text-emerald-400/90 whitespace-pre">
                  <code>{snippet.code}</code>
                </pre>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
