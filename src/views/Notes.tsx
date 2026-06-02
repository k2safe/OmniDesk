import { useEffect, useMemo, useRef, useState } from "react";
import type { ClipboardEvent, DragEvent, KeyboardEvent } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import { Bold, BookOpen, Clock3, Code2, Columns2, Eye, FileText, Heading1, ImagePlus, Italic, List, PenLine, Plus, Quote, Search, Tag, Trash2, X } from "lucide-react";
import { cn } from "../lib/utils";
import { useStoreField } from "../lib/store";
import { readNoteImage, saveNoteImage, searchNotes } from "../lib/desktop";

const NOTE_ASSET_PREFIX = "omnidesk-asset://note-assets/";
const ALL_TAGS = "__all__";
type EditorMode = "write" | "split" | "preview";

const editorModes: { value: EditorMode; label: string; icon: typeof PenLine }[] = [
  { value: "write", label: "编辑", icon: PenLine },
  { value: "split", label: "分栏", icon: Columns2 },
  { value: "preview", label: "阅读", icon: Eye },
];

function readFileAsBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.includes(",") ? result.slice(result.indexOf(",") + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function noteExcerpt(content: string) {
  const plain = content
    .replace(/!\[[^\]]*]\([^)]*\)/g, " 图片 ")
    .replace(/```[\s\S]*?```/g, " 代码片段 ")
    .replace(/[#>*_`[\]()~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain || "空白笔记";
}

function normalizeTag(value: string) {
  return value.trim().replace(/^#/, "").replace(/\s+/g, " ").slice(0, 24);
}

function formatUpdatedAt(value: number) {
  const diff = Date.now() - value;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < minute) return "刚刚更新";
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function NoteImage({ src, alt }: { src?: string; alt?: string }) {
  const [resolvedSrc, setResolvedSrc] = useState(src ?? "");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let isMounted = true;
    setFailed(false);
    if (!src) {
      setResolvedSrc("");
      return () => {
        isMounted = false;
      };
    }

    if (!src.startsWith(NOTE_ASSET_PREFIX)) {
      setResolvedSrc(src);
      return () => {
        isMounted = false;
      };
    }

    readNoteImage(src)
      .then((value) => {
        if (isMounted) setResolvedSrc(value);
      })
      .catch(() => {
        if (isMounted) setFailed(true);
      });

    return () => {
      isMounted = false;
    };
  }, [src]);

  if (failed) {
    return (
      <span className="my-4 flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-600">
        <ImagePlus size={16} />
        图片加载失败
      </span>
    );
  }

  return (
    <img
      src={resolvedSrc}
      alt={alt ?? ""}
      loading="lazy"
      className="my-5 max-h-[620px] rounded-xl border border-slate-200 bg-white object-contain shadow-sm"
    />
  );
}

const markdownComponents = {
  img({ src, alt }: { src?: string; alt?: string }) {
    return <NoteImage src={src} alt={alt} />;
  },
};

function markdownUrlTransform(url: string, key: string) {
  if (key === "src" && (url.startsWith(NOTE_ASSET_PREFIX) || url.startsWith("data:image/"))) {
    return url;
  }
  return defaultUrlTransform(url);
}

export function Notes() {
  const [notes, setNotes] = useStoreField("notes");
  const [selectedId, setSelectedId] = useState<string>(notes[0]?.id ?? "");
  const [search, setSearch] = useState("");
  const [searchResultIds, setSearchResultIds] = useState<string[] | null>(null);
  const [selectedTag, setSelectedTag] = useState(ALL_TAGS);
  const [tagInput, setTagInput] = useState("");
  const [editorMode, setEditorMode] = useState<EditorMode>("split");
  const [pasteStatus, setPasteStatus] = useState("");
  const [isDraggingImage, setIsDraggingImage] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  const selectedNote = notes.find((note) => note.id === selectedId);
  const normalizedSearch = search.trim().toLowerCase();
  const searchRank = useMemo(() => {
    if (!searchResultIds) return null;
    return new Map(searchResultIds.map((id, index) => [id, index]));
  }, [searchResultIds]);
  const allTags = useMemo(() => {
    const tags = new Map<string, number>();
    notes.forEach((note) => {
      (note.tags ?? []).forEach((tag) => {
        const normalized = normalizeTag(tag);
        if (!normalized) return;
        tags.set(normalized, (tags.get(normalized) ?? 0) + 1);
      });
    });
    return [...tags.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh-CN"));
  }, [notes]);

  const filteredNotes = useMemo(() => {
    const filtered = notes.filter((note) => {
      const noteTags = note.tags ?? [];
      const matchesTag = selectedTag === ALL_TAGS || noteTags.some((tag) => normalizeTag(tag) === selectedTag);
      if (!matchesTag) return false;
      if (!normalizedSearch) return true;
      if (searchRank) return searchRank.has(note.id);
      return `${note.title} ${note.content} ${noteTags.join(" ")}`.toLowerCase().includes(normalizedSearch);
    });

    if (!normalizedSearch || !searchRank) return filtered;
    return [...filtered].sort((a, b) => (searchRank.get(a.id) ?? 0) - (searchRank.get(b.id) ?? 0));
  }, [notes, normalizedSearch, searchRank, selectedTag]);

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
      const searchableNotes = notes.map(({ id, title, content, tags }) => ({ id, title, content, tags }));
      void searchNotes(normalizedSearch, searchableNotes)
        .then((ids) => {
          if (!isCancelled) setSearchResultIds(ids);
        })
        .catch((error) => {
          console.error("Failed to search notes", error);
          if (!isCancelled) setSearchResultIds(null);
        });
    }, 120);

    return () => {
      isCancelled = true;
      window.clearTimeout(timeout);
    };
  }, [normalizedSearch, notes]);

  useEffect(() => {
    if (!selectedNote && notes.length > 0) {
      setSelectedId(notes[0].id);
      return;
    }
    if (notes.length === 0 && selectedId) {
      setSelectedId("");
    }
  }, [notes, selectedId, selectedNote]);

  useEffect(() => {
    if (selectedTag !== ALL_TAGS && !allTags.some(([tag]) => tag === selectedTag)) {
      setSelectedTag(ALL_TAGS);
    }
  }, [allTags, selectedTag]);

  const updateSelectedNote = (newContent: string) => {
    setNotes((prev) => prev.map((note) => (
      note.id === selectedId ? { ...note, content: newContent, updatedAt: Date.now() } : note
    )));
  };

  const updateTitle = (newTitle: string) => {
    setNotes((prev) => prev.map((note) => (
      note.id === selectedId ? { ...note, title: newTitle, updatedAt: Date.now() } : note
    )));
  };

  const createNote = () => {
    const newNote = {
      id: Date.now().toString(),
      title: "新建笔记",
      content: "# 新建笔记\n\n",
      tags: selectedTag === ALL_TAGS ? [] : [selectedTag],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    setNotes((prev) => [newNote, ...prev]);
    setSelectedId(newNote.id);
    setEditorMode("split");
  };

  const addTagToSelectedNote = (rawTag = tagInput) => {
    if (!selectedNote) return;
    const tag = normalizeTag(rawTag);
    if (!tag) return;

    setNotes((prev) => prev.map((note) => {
      if (note.id !== selectedId) return note;
      const currentTags = note.tags ?? [];
      const exists = currentTags.some((item) => normalizeTag(item).toLowerCase() === tag.toLowerCase());
      if (exists) return note;
      return { ...note, tags: [...currentTags, tag], updatedAt: Date.now() };
    }));
    setTagInput("");
  };

  const removeTagFromSelectedNote = (tagToRemove: string) => {
    setNotes((prev) => prev.map((note) => {
      if (note.id !== selectedId) return note;
      return {
        ...note,
        tags: (note.tags ?? []).filter((tag) => normalizeTag(tag) !== tagToRemove),
        updatedAt: Date.now(),
      };
    }));
  };

  const handleTagInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      addTagToSelectedNote();
    }
    if (event.key === "Backspace" && !tagInput && selectedNote?.tags?.length) {
      event.preventDefault();
      removeTagFromSelectedNote(normalizeTag(selectedNote.tags[selectedNote.tags.length - 1]));
    }
  };

  const deleteSelectedNote = () => {
    if (!selectedNote) return;
    const nextNotes = notes.filter((note) => note.id !== selectedNote.id);
    setNotes(nextNotes);
    setSelectedId(nextNotes[0]?.id ?? "");
    setEditorMode("split");
  };

  const updateEditorCursor = (start: number, end = start) => {
    window.requestAnimationFrame(() => {
      const textarea = editorRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.selectionStart = start;
      textarea.selectionEnd = end;
    });
  };

  const wrapSelection = (before: string, after: string, placeholder: string) => {
    if (!selectedNote) return;
    const textarea = editorRef.current;
    const start = textarea?.selectionStart ?? selectedNote.content.length;
    const end = textarea?.selectionEnd ?? selectedNote.content.length;
    const selectedText = selectedNote.content.slice(start, end);
    const body = selectedText || placeholder;
    const insert = `${before}${body}${after}`;
    const nextContent = `${selectedNote.content.slice(0, start)}${insert}${selectedNote.content.slice(end)}`;
    updateSelectedNote(nextContent);
    if (selectedText) {
      updateEditorCursor(start + insert.length);
    } else {
      updateEditorCursor(start + before.length, start + before.length + body.length);
    }
  };

  const prefixCurrentLines = (prefix: string) => {
    if (!selectedNote) return;
    const textarea = editorRef.current;
    const start = textarea?.selectionStart ?? selectedNote.content.length;
    const end = textarea?.selectionEnd ?? selectedNote.content.length;
    const lineStart = selectedNote.content.lastIndexOf("\n", start - 1) + 1;
    const lineEndIndex = selectedNote.content.indexOf("\n", end);
    const lineEnd = lineEndIndex === -1 ? selectedNote.content.length : lineEndIndex;
    const block = selectedNote.content.slice(lineStart, lineEnd);
    const prefixed = block
      .split("\n")
      .map((line) => `${prefix}${line}`)
      .join("\n");
    const nextContent = `${selectedNote.content.slice(0, lineStart)}${prefixed}${selectedNote.content.slice(lineEnd)}`;
    updateSelectedNote(nextContent);
    updateEditorCursor(end + prefix.length);
  };

  const insertHeading = () => {
    if (!selectedNote) return;
    const textarea = editorRef.current;
    const start = textarea?.selectionStart ?? selectedNote.content.length;
    const lineStart = selectedNote.content.lastIndexOf("\n", start - 1) + 1;
    const hasHeading = selectedNote.content.slice(lineStart, lineStart + 2) === "# ";
    if (hasHeading) return;
    const nextContent = `${selectedNote.content.slice(0, lineStart)}# ${selectedNote.content.slice(lineStart)}`;
    updateSelectedNote(nextContent);
    updateEditorCursor(start + 2);
  };

  const insertImageFiles = async (files: File[], textarea = editorRef.current) => {
    if (!selectedNote || files.length === 0) return;
    const selectionStart = textarea?.selectionStart ?? selectedNote.content.length;
    const selectionEnd = textarea?.selectionEnd ?? selectedNote.content.length;

    try {
      setEditorMode((mode) => mode === "preview" ? "split" : mode);
      setPasteStatus("正在保存图片...");
      const snippets = await Promise.all(files.map(async (file, index) => {
        const bytesBase64 = await readFileAsBase64(file);
        const saved = await saveNoteImage(file.type || "image/png", bytesBase64);
        const alt = file.name
          ? file.name.replace(/\.[^.]+$/, "") || "粘贴图片"
          : `粘贴图片 ${index + 1}`;
        return `![${alt}](${saved.markdownSrc})`;
      }));

      const insertion = `\n\n${snippets.join("\n\n")}\n\n`;
      const nextContent = [
        selectedNote.content.slice(0, selectionStart),
        insertion,
        selectedNote.content.slice(selectionEnd),
      ].join("");
      updateSelectedNote(nextContent);
      setPasteStatus(`${files.length} 张图片已插入`);
      updateEditorCursor(selectionStart + insertion.length);
      window.setTimeout(() => setPasteStatus(""), 1600);
    } catch (error) {
      setPasteStatus(error instanceof Error ? error.message : "图片保存失败");
    }
  };

  const handleEditorPaste = async (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!selectedNote) return;

    const clipboardItems = Array.from(event.clipboardData.items) as DataTransferItem[];
    const imageFiles = clipboardItems
      .filter((item) => item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));

    if (imageFiles.length === 0) return;

    event.preventDefault();
    await insertImageFiles(imageFiles, event.currentTarget);
  };

  const handleEditorDrop = async (event: DragEvent<HTMLTextAreaElement>) => {
    const droppedFiles = Array.from(event.dataTransfer.files) as File[];
    const imageFiles = droppedFiles.filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) return;
    event.preventDefault();
    setIsDraggingImage(false);
    await insertImageFiles(imageFiles, event.currentTarget);
  };

  const showEditor = editorMode !== "preview";
  const showPreview = editorMode !== "write";

  return (
    <div className="flex h-full w-full overflow-hidden bg-slate-50 text-slate-800">
      <aside className="flex w-80 shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="border-b border-slate-200 p-4">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h1 className="text-lg font-bold text-slate-950">知识库</h1>
              <p className="mt-0.5 text-xs font-medium text-slate-400">{notes.length} 条本地笔记</p>
            </div>
            <button
              type="button"
              onClick={createNote}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500 text-white transition-colors hover:bg-emerald-600"
              title="新建笔记"
            >
              <Plus size={18} />
            </button>
          </div>
          <div className="relative">
            <Search size={17} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="搜索标题、内容或标签..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50 pl-10 pr-10 text-sm font-medium text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-emerald-500 focus:bg-white"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="absolute right-2 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
                title="清空搜索"
              >
                <X size={15} />
              </button>
            )}
          </div>
          <div className="mt-3 flex max-h-24 flex-wrap gap-2 overflow-y-auto">
            <button
              type="button"
              onClick={() => setSelectedTag(ALL_TAGS)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors",
                selectedTag === ALL_TAGS
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50",
              )}
            >
              <Tag size={12} />
              全部
            </button>
            {allTags.map(([tag, count]) => (
              <button
                key={tag}
                type="button"
                onClick={() => setSelectedTag(tag)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors",
                  selectedTag === tag
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                    : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50",
                )}
              >
                #{tag}
                <span className="text-slate-400">{count}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {filteredNotes.length > 0 ? (
            <div className="space-y-2">
              {filteredNotes.map((note) => {
                const selected = selectedId === note.id;
                return (
                  <button
                    key={note.id}
                    type="button"
                    onClick={() => setSelectedId(note.id)}
                    className={cn(
                      "w-full rounded-xl border p-3 text-left transition-colors",
                      selected
                        ? "border-emerald-200 bg-emerald-50 shadow-sm"
                        : "border-transparent bg-white hover:border-slate-200 hover:bg-slate-50",
                    )}
                  >
                    <div className="mb-2 flex items-start gap-3">
                      <div className={cn(
                        "mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
                        selected ? "bg-white text-emerald-600" : "bg-slate-100 text-slate-400",
                      )}
                      >
                        <FileText size={17} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold text-slate-950">{note.title.trim() || "未命名笔记"}</div>
                        <div className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">{noteExcerpt(note.content)}</div>
                        {(note.tags ?? []).length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1">
                            {(note.tags ?? []).slice(0, 3).map((tag) => (
                              <span key={tag} className="rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                                #{tag}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 text-xs font-medium text-slate-400">
                      <Clock3 size={13} />
                      {formatUpdatedAt(note.updatedAt)}
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center px-6 text-center text-slate-400">
              <Search size={32} className="mb-3 opacity-50" />
              <div className="text-sm font-semibold text-slate-500">没有找到笔记</div>
              <p className="mt-1 text-xs leading-5">换个关键词，或者新建一条本地笔记。</p>
            </div>
          )}
        </div>

        <div className="border-t border-slate-200 p-4">
          <button
            type="button"
            onClick={createNote}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 py-3 text-sm font-semibold text-emerald-700 transition-colors hover:bg-emerald-100"
          >
            <Plus size={17} />
            新建笔记
          </button>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-slate-50">
        {selectedNote ? (
          <>
            <header className="flex shrink-0 items-center justify-between gap-4 border-b border-slate-200 bg-white px-6 py-4">
              <div className="min-w-0 flex-1">
                <input
                  type="text"
                  value={selectedNote.title}
                  onChange={(event) => updateTitle(event.target.value)}
                  className="w-full bg-transparent text-xl font-bold text-slate-950 outline-none placeholder:text-slate-400"
                  placeholder="笔记标题"
                />
                <div className="mt-1 flex items-center gap-2 text-xs font-medium text-slate-400">
                  <Clock3 size={13} />
                  {formatUpdatedAt(selectedNote.updatedAt)}
                  {pasteStatus && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 font-semibold text-emerald-700">
                      <ImagePlus size={12} />
                      {pasteStatus}
                    </span>
                  )}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {(selectedNote.tags ?? []).map((tag) => {
                    const normalized = normalizeTag(tag);
                    return (
                      <span
                        key={normalized}
                        className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700"
                      >
                        #{normalized}
                        <button
                          type="button"
                          onClick={() => removeTagFromSelectedNote(normalized)}
                          className="inline-flex h-4 w-4 items-center justify-center rounded-full hover:bg-emerald-100"
                          title="移除标签"
                        >
                          <X size={11} />
                        </button>
                      </span>
                    );
                  })}
                  <div className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-500">
                    <Tag size={12} />
                    <input
                      value={tagInput}
                      onChange={(event) => setTagInput(event.target.value)}
                      onKeyDown={handleTagInputKeyDown}
                      onBlur={() => addTagToSelectedNote()}
                      className="w-24 bg-transparent outline-none placeholder:text-slate-400"
                      placeholder="添加标签"
                    />
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <div className="grid grid-cols-3 gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1">
                  {editorModes.map((mode) => {
                    const Icon = mode.icon;
                    return (
                      <button
                        key={mode.value}
                        type="button"
                        onClick={() => setEditorMode(mode.value)}
                        className={cn(
                          "inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition-colors",
                          editorMode === mode.value
                            ? "bg-white text-slate-950 shadow-sm"
                            : "text-slate-400 hover:text-slate-700",
                        )}
                      >
                        <Icon size={16} />
                        {mode.label}
                      </button>
                    );
                  })}
                </div>
                <button
                  type="button"
                  onClick={deleteSelectedNote}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-400 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                  title="删除笔记"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </header>

            <div className={cn(
              "grid min-h-0 flex-1 overflow-hidden",
              editorMode === "split" ? "grid-cols-1 lg:grid-cols-2" : "grid-cols-1",
            )}
            >
              {showEditor && (
                <section className="flex min-h-0 flex-col border-r border-slate-200 bg-white">
                  <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-2">
                    <div className="flex items-center gap-1">
                      <button type="button" title="标题" onClick={insertHeading} className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-950">
                        <Heading1 size={17} />
                      </button>
                      <button type="button" title="加粗" onClick={() => wrapSelection("**", "**", "加粗文字")} className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-950">
                        <Bold size={16} />
                      </button>
                      <button type="button" title="斜体" onClick={() => wrapSelection("*", "*", "斜体文字")} className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-950">
                        <Italic size={16} />
                      </button>
                      <button type="button" title="列表" onClick={() => prefixCurrentLines("- ")} className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-950">
                        <List size={17} />
                      </button>
                      <button type="button" title="引用" onClick={() => prefixCurrentLines("> ")} className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-950">
                        <Quote size={16} />
                      </button>
                      <button type="button" title="代码" onClick={() => wrapSelection("`", "`", "code")} className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-950">
                        <Code2 size={16} />
                      </button>
                      <button type="button" title="插入图片" onClick={() => imageInputRef.current?.click()} className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-950">
                        <ImagePlus size={17} />
                      </button>
                    </div>
                    <span className="hidden text-xs font-medium text-slate-400 md:block">支持粘贴、拖拽或选择图片</span>
                    <input
                      ref={imageInputRef}
                      type="file"
                      accept="image/*"
                      multiple
                      className="hidden"
                      onChange={async (event) => {
                        const files = Array.from(event.target.files ?? []);
                        await insertImageFiles(files);
                        event.target.value = "";
                      }}
                    />
                  </div>
                  <div className="relative min-h-0 flex-1">
                    <textarea
                      ref={editorRef}
                      value={selectedNote.content}
                      onChange={(event) => updateSelectedNote(event.target.value)}
                      onPaste={handleEditorPaste}
                      onDragEnter={(event) => {
                        if (Array.from(event.dataTransfer.items).some((item) => item.type.startsWith("image/"))) {
                          setIsDraggingImage(true);
                        }
                      }}
                      onDragOver={(event) => {
                        if (Array.from(event.dataTransfer.items).some((item) => item.type.startsWith("image/"))) {
                          event.preventDefault();
                        }
                      }}
                      onDragLeave={() => setIsDraggingImage(false)}
                      onDrop={handleEditorDrop}
                      className="h-full w-full resize-none bg-white p-6 font-mono text-sm leading-7 text-slate-700 outline-none placeholder:text-slate-400"
                      placeholder="在这里输入 Markdown..."
                      spellCheck={false}
                      autoFocus
                    />
                    {isDraggingImage && (
                      <div className="pointer-events-none absolute inset-4 flex items-center justify-center rounded-2xl border-2 border-dashed border-emerald-300 bg-emerald-50/80 text-sm font-semibold text-emerald-700">
                        松开即可插入图片
                      </div>
                    )}
                  </div>
                </section>
              )}

              {showPreview && (
                <section
                  className={cn(
                    "min-h-0 overflow-y-auto bg-slate-50 px-8 py-8",
                    editorMode === "preview" && "px-10",
                  )}
                  onDoubleClick={() => setEditorMode("split")}
                >
                  <article className={cn(
                    "mx-auto rounded-2xl border border-slate-200 bg-white px-10 py-9 shadow-sm",
                    editorMode === "split" ? "max-w-none" : "max-w-4xl",
                  )}
                  >
                    {selectedNote.content.trim() ? (
                      <div className="prose prose-slate max-w-none prose-headings:text-slate-950 prose-p:text-slate-600 prose-li:text-slate-600 prose-strong:text-slate-900 prose-a:text-emerald-700 prose-code:rounded prose-code:bg-emerald-50 prose-code:px-1.5 prose-code:py-0.5 prose-code:text-emerald-700 prose-pre:border prose-pre:border-slate-200 prose-pre:bg-slate-950">
                        <Markdown components={markdownComponents} urlTransform={markdownUrlTransform}>{selectedNote.content}</Markdown>
                      </div>
                    ) : (
                      <div className="flex min-h-[360px] flex-col items-center justify-center text-center text-slate-400">
                        <FileText size={40} className="mb-4 opacity-40" />
                        <div className="text-sm font-semibold text-slate-500">这条笔记还是空的</div>
                        <button
                          type="button"
                          onClick={() => setEditorMode("split")}
                          className="mt-4 inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-600"
                        >
                          <PenLine size={16} />
                          开始编辑
                        </button>
                      </div>
                    )}
                  </article>
                </section>
              )}
            </div>
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center text-center text-slate-400">
            <div className="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-white text-slate-300 shadow-sm">
              <BookOpen size={34} />
            </div>
            <div className="text-base font-semibold text-slate-600">还没有选中笔记</div>
            <p className="mt-2 text-sm">从左侧选择一条，或者新建一条知识记录。</p>
            <button
              type="button"
              onClick={createNote}
              className="mt-5 inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-600"
            >
              <Plus size={17} />
              新建笔记
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
