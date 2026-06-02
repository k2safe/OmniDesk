import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import * as QRCode from "qrcode";
import { Calendar, Clipboard, Clock, Code, Copy, Download, FileJson, Globe2, Hash, ImageIcon, Pipette, QrCode, RotateCcw, SplitSquareHorizontal, UploadCloud, Wifi, X } from "lucide-react";
import { cn } from "../lib/utils";
import { exportBytes, getLocalDropStatus, pickScreenColor, startLocalDrop, stopLocalDrop, writeClipboard } from "../lib/desktop";
import type { LocalDropInfo, PickedColor } from "../lib/desktop";
import { OptionSelect } from "../components/OptionSelect";

type ToolTab = "json" | "base64" | "url" | "hash" | "regex" | "time" | "api" | "system" | "image";
type HashType = "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512";
type TimestampUnit = "auto" | "seconds" | "milliseconds";

interface RegexMatch {
  value: string;
  index: number;
}

interface TimeZoneRow {
  label: string;
  timeZone: string;
}

interface TimeZoneResult extends TimeZoneRow {
  value: string;
}

interface TimeConversionResult {
  unitLabel: string;
  iso: string;
  local: string;
  utc: string;
  seconds: string;
  milliseconds: string;
  zones: TimeZoneResult[];
}

const tabs: { id: ToolTab; label: string; icon: ReactNode }[] = [
  { id: "json", label: "JSON", icon: <FileJson size={16} /> },
  { id: "base64", label: "Base64", icon: <SplitSquareHorizontal size={16} /> },
  { id: "url", label: "URL", icon: <Globe2 size={16} /> },
  { id: "hash", label: "Hash", icon: <Hash size={16} /> },
  { id: "regex", label: "Regex", icon: <Code size={16} /> },
  { id: "time", label: "时间", icon: <Calendar size={16} /> },
  { id: "api", label: "API", icon: <Globe2 size={16} /> },
  { id: "system", label: "系统", icon: <Wifi size={16} /> },
  { id: "image", label: "图片", icon: <ImageIcon size={16} /> },
];

const hashOptions: { value: HashType; label: string }[] = [
  { value: "SHA-1", label: "SHA-1" },
  { value: "SHA-256", label: "SHA-256" },
  { value: "SHA-384", label: "SHA-384" },
  { value: "SHA-512", label: "SHA-512" },
];
const apiMethodOptions = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].map((method) => ({
  value: method,
  label: method,
}));
const imageFormatOptions = [
  { value: "image/webp", label: "WebP" },
  { value: "image/jpeg", label: "JPG" },
  { value: "image/png", label: "PNG" },
];
const timestampUnitOptions: { value: TimestampUnit; label: string }[] = [
  { value: "auto", label: "自动" },
  { value: "seconds", label: "秒" },
  { value: "milliseconds", label: "毫秒" },
];

function encodeBase64(input: string) {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function decodeBase64(input: string) {
  const binary = atob(input.trim());
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatZonedTime(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function resolveTimestampUnit(input: string, unit: TimestampUnit) {
  if (unit !== "auto") return unit;
  return input.replace(/^-/, "").replace(/\D/g, "").length > 10 ? "milliseconds" : "seconds";
}

function formatTimeResultForCopy(result: TimeConversionResult) {
  return [
    `输入单位: ${result.unitLabel}`,
    `ISO: ${result.iso}`,
    `本地: ${result.local}`,
    `UTC: ${result.utc}`,
    `秒: ${result.seconds}`,
    `毫秒: ${result.milliseconds}`,
    "",
    "多时区:",
    ...result.zones.map((zone) => `${zone.label} (${zone.timeZone}): ${zone.value}`),
  ].join("\n");
}

function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.includes(",") ? result.slice(result.indexOf(",") + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function ActionButton({
  children,
  onClick,
  variant = "soft",
}: {
  children: ReactNode;
  onClick: () => void;
  variant?: "primary" | "soft";
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
        variant === "primary"
          ? "bg-emerald-500 text-white hover:bg-emerald-600"
          : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900",
      )}
    >
      {children}
    </button>
  );
}

function ToolPanel({ children }: { children: ReactNode }) {
  return <div className="grid h-full grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">{children}</div>;
}

export function DevTools() {
  const [activeTab, setActiveTab] = useState<ToolTab>("json");
  const [copied, setCopied] = useState("");

  const [jsonInput, setJsonInput] = useState("{\n  \"hello\": \"world\"\n}");
  const [jsonError, setJsonError] = useState("");

  const [baseInput, setBaseInput] = useState("");
  const [baseOutput, setBaseOutput] = useState("");
  const [baseError, setBaseError] = useState("");

  const [urlInput, setUrlInput] = useState("");
  const [urlOutput, setUrlOutput] = useState("");
  const [urlError, setUrlError] = useState("");

  const [hashInput, setHashInput] = useState("");
  const [hashOutput, setHashOutput] = useState("");
  const [hashType, setHashType] = useState<HashType>("SHA-256");
  const [hashFileName, setHashFileName] = useState("");

  const [regexPattern, setRegexPattern] = useState("");
  const [regexFlags, setRegexFlags] = useState("g");
  const [regexText, setRegexText] = useState("");
  const [regexMatches, setRegexMatches] = useState<RegexMatch[]>([]);
  const [regexError, setRegexError] = useState("");

  const [timeInput, setTimeInput] = useState(Date.now().toString());
  const [timeOutput, setTimeOutput] = useState("");
  const [timeResult, setTimeResult] = useState<TimeConversionResult | null>(null);
  const [timeError, setTimeError] = useState("");
  const [timestampUnit, setTimestampUnit] = useState<TimestampUnit>("auto");
  const [now, setNow] = useState(() => new Date());

  const [apiMethod, setApiMethod] = useState("GET");
  const [apiUrl, setApiUrl] = useState("http://localhost:8080/health");
  const [apiHeaders, setApiHeaders] = useState("");
  const [apiBody, setApiBody] = useState("");
  const [apiOutput, setApiOutput] = useState("");
  const [apiError, setApiError] = useState("");

  const [imageFormat, setImageFormat] = useState("image/webp");
  const [imageQuality, setImageQuality] = useState(0.86);
  const [imageOutputUrl, setImageOutputUrl] = useState("");
  const [imageOutputName, setImageOutputName] = useState("");
  const [imageStats, setImageStats] = useState("");
  const [imageError, setImageError] = useState("");

  const [pickedColor, setPickedColor] = useState<PickedColor | null>(null);
  const [colorStatus, setColorStatus] = useState("");
  const [localDropInfo, setLocalDropInfo] = useState<LocalDropInfo | null>(null);
  const [localDropQr, setLocalDropQr] = useState("");
  const [localDropError, setLocalDropError] = useState("");

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 250);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    void getLocalDropStatus()
      .then((info) => {
        if (info) setLocalDropInfo(info);
      })
      .catch(() => {
        // Local Drop status is best-effort; the service can be stopped outside the UI.
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!localDropInfo) {
      setLocalDropQr("");
      return;
    }
    void QRCode.toDataURL(localDropInfo.url, {
      width: 220,
      margin: 1,
      color: { dark: "#047857", light: "#ffffff" },
    })
      .then((url) => {
        if (!cancelled) setLocalDropQr(url);
      })
      .catch((error) => {
        if (!cancelled) setLocalDropError(error instanceof Error ? error.message : "二维码生成失败");
      });
    return () => {
      cancelled = true;
    };
  }, [localDropInfo]);

  const jsonStats = useMemo(() => {
    return {
      chars: jsonInput.length,
      lines: jsonInput ? jsonInput.split("\n").length : 0,
    };
  }, [jsonInput]);

  const systemTimeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", []);
  const timeZoneRows = useMemo<TimeZoneRow[]>(() => {
    const rows: TimeZoneRow[] = [
      { label: `本地 · ${systemTimeZone}`, timeZone: systemTimeZone },
      { label: "UTC", timeZone: "UTC" },
      { label: "东京", timeZone: "Asia/Tokyo" },
      { label: "伦敦", timeZone: "Europe/London" },
      { label: "纽约", timeZone: "America/New_York" },
      { label: "洛杉矶", timeZone: "America/Los_Angeles" },
    ];
    if (systemTimeZone !== "Asia/Shanghai") {
      rows.splice(2, 0, { label: "上海", timeZone: "Asia/Shanghai" });
    }
    return rows;
  }, [systemTimeZone]);

  const currentSeconds = Math.floor(now.getTime() / 1000);
  const currentMilliseconds = now.getTime();

  const copyValue = async (value: string, id: string) => {
    if (!value) return;
    await writeClipboard(value);
    setCopied(id);
    window.setTimeout(() => setCopied(""), 1500);
  };

  const formatJson = () => {
    try {
      const parsed = JSON.parse(jsonInput);
      setJsonInput(JSON.stringify(parsed, null, 2));
      setJsonError("");
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : "JSON 格式无效");
    }
  };

  const minifyJson = () => {
    try {
      const parsed = JSON.parse(jsonInput);
      setJsonInput(JSON.stringify(parsed));
      setJsonError("");
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : "JSON 格式无效");
    }
  };

  const handleBase64 = (mode: "encode" | "decode") => {
    try {
      setBaseOutput(mode === "encode" ? encodeBase64(baseInput) : decodeBase64(baseInput));
      setBaseError("");
    } catch {
      setBaseError("输入不是有效的 Base64，或解码结果不是有效 UTF-8 文本");
      setBaseOutput("");
    }
  };

  const handleUrl = (mode: "encode" | "decode") => {
    try {
      setUrlOutput(mode === "encode" ? encodeURIComponent(urlInput) : decodeURIComponent(urlInput));
      setUrlError("");
    } catch {
      setUrlOutput("");
      setUrlError("输入不是有效的 URL 编码内容");
    }
  };

  const handleHash = async () => {
    if (!hashInput) return;
    const msgBuffer = new TextEncoder().encode(hashInput);
    const hashBuffer = await crypto.subtle.digest(hashType, msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    setHashOutput(hashArray.map((byte) => byte.toString(16).padStart(2, "0")).join(""));
  };

  const handleHashFile = async (file?: File) => {
    if (!file) return;
    const buffer = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest(hashType, buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    setHashFileName(file.name);
    setHashOutput(hashArray.map((byte) => byte.toString(16).padStart(2, "0")).join(""));
  };

  const handleRegex = () => {
    try {
      const flags = regexFlags.includes("g") ? regexFlags : `${regexFlags}g`;
      const regex = new RegExp(regexPattern, flags);
      const matches = [...regexText.matchAll(regex)].map((match) => ({
        value: match[0],
        index: match.index ?? 0,
      }));
      setRegexMatches(matches);
      setRegexError("");
    } catch (error) {
      setRegexError(error instanceof Error ? error.message : "正则表达式无效");
      setRegexMatches([]);
    }
  };

  const handleTime = () => {
    const trimmed = timeInput.trim();
    const timestamp = Number(trimmed);
    if (!Number.isFinite(timestamp)) {
      setTimeError("无效的时间戳");
      setTimeResult(null);
      setTimeOutput("");
      return;
    }

    const unit = resolveTimestampUnit(trimmed, timestampUnit);
    const date = new Date(unit === "milliseconds" ? timestamp : timestamp * 1000);
    if (!Number.isFinite(date.getTime())) {
      setTimeError("无效的时间范围");
      setTimeResult(null);
      setTimeOutput("");
      return;
    }

    const result: TimeConversionResult = {
      unitLabel: unit === "milliseconds" ? "毫秒" : "秒",
      iso: date.toISOString(),
      local: formatZonedTime(date, systemTimeZone),
      utc: date.toUTCString(),
      seconds: Math.floor(date.getTime() / 1000).toString(),
      milliseconds: date.getTime().toString(),
      zones: timeZoneRows.map((zone) => ({
        ...zone,
        value: formatZonedTime(date, zone.timeZone),
      })),
    };

    setTimeResult(result);
    setTimeError("");
    setTimeOutput(formatTimeResultForCopy(result));
  };

  const parseHeaders = () => {
    const headers = new Headers();
    apiHeaders
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach((line) => {
        const index = line.indexOf(":");
        if (index <= 0) return;
        headers.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
      });
    return headers;
  };

  const handleApiRequest = async () => {
    setApiError("");
    setApiOutput("");
    try {
      const startedAt = performance.now();
      const response = await fetch(apiUrl, {
        method: apiMethod,
        headers: parseHeaders(),
        body: ["GET", "HEAD"].includes(apiMethod) ? undefined : apiBody,
      });
      const text = await response.text();
      const elapsed = Math.round(performance.now() - startedAt);
      let body = text;
      try {
        body = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // Keep raw body when it is not JSON.
      }
      setApiOutput([
        `${response.status} ${response.statusText} · ${elapsed}ms`,
        "",
        body,
      ].join("\n"));
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "请求失败");
    }
  };

  const handleImageFile = async (file?: File) => {
    if (!file) return;
    setImageError("");
    try {
      const sourceUrl = URL.createObjectURL(file);
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("图片读取失败"));
        image.src = sourceUrl;
      });

      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("无法创建图片画布");
      context.drawImage(image, 0, 0);
      URL.revokeObjectURL(sourceUrl);

      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((value) => {
          if (value) resolve(value);
          else reject(new Error("图片转换失败"));
        }, imageFormat, imageQuality);
      });

      if (imageOutputUrl) URL.revokeObjectURL(imageOutputUrl);
      const nextUrl = URL.createObjectURL(blob);
      const ext = imageFormat === "image/png" ? "png" : imageFormat === "image/jpeg" ? "jpg" : "webp";
      const baseName = file.name.replace(/\.[^.]+$/, "") || "image";
      setImageOutputUrl(nextUrl);
      setImageOutputName(`${baseName}.${ext}`);
      setImageStats(`${formatBytes(file.size)} -> ${formatBytes(blob.size)} · ${image.naturalWidth}x${image.naturalHeight}`);
    } catch (error) {
      setImageError(error instanceof Error ? error.message : "图片处理失败");
    }
  };

  const handleExportImage = async () => {
    if (!imageOutputUrl) return;
    setImageError("");
    try {
      const blob = await fetch(imageOutputUrl).then((response) => response.blob());
      const bytesBase64 = await blobToBase64(blob);
      await exportBytes(imageOutputName || "omnidesk-image.webp", bytesBase64);
    } catch (error) {
      setImageError(error instanceof Error ? error.message : "图片导出失败");
    }
  };

  const handlePickColor = async () => {
    setColorStatus("1.2 秒后读取鼠标位置...");
    try {
      const result = await pickScreenColor(1200);
      if (!result) {
        setColorStatus("屏幕取色仅支持桌面版");
        return;
      }
      setPickedColor(result);
      setColorStatus(`已取色 ${result.hex}`);
    } catch (error) {
      setColorStatus(error instanceof Error ? error.message : "屏幕取色失败");
    }
  };

  const handleStartLocalDrop = async () => {
    setLocalDropError("");
    try {
      const info = await startLocalDrop();
      if (!info) {
        setLocalDropError("局域网快传仅支持桌面版");
        return;
      }
      setLocalDropInfo(info);
    } catch (error) {
      setLocalDropError(error instanceof Error ? error.message : "启动局域网快传失败");
    }
  };

  const handleStopLocalDrop = async () => {
    setLocalDropError("");
    try {
      await stopLocalDrop();
      setLocalDropInfo(null);
      setLocalDropQr("");
    } catch (error) {
      setLocalDropError(error instanceof Error ? error.message : "停止局域网快传失败");
    }
  };

  return (
    <div className="flex h-full w-full flex-col bg-slate-50 text-slate-800">
      <header className="shrink-0 border-b border-slate-200 px-8 py-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="mb-2 text-3xl font-bold tracking-tight text-slate-900">开发工具箱</h1>
            <p className="text-slate-400">JSON、编码、Hash、正则和时间转换都在本地完成。</p>
          </div>
          <div className="flex gap-2 overflow-x-auto rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors",
                  activeTab === tab.id ? "bg-slate-100 text-slate-900" : "text-slate-400 hover:bg-slate-50 hover:text-slate-700",
                )}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-8 pb-28">
        {activeTab === "json" && (
          <ToolPanel>
            <textarea
              value={jsonInput}
              onChange={(event) => setJsonInput(event.target.value)}
              className="min-h-[520px] w-full resize-none rounded-xl border border-slate-200 bg-white p-4 font-mono text-sm leading-relaxed text-slate-700 outline-none focus:border-emerald-500"
              spellCheck={false}
            />
            <aside className="space-y-4">
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="mb-3 text-sm font-semibold text-slate-900">JSON 操作</div>
                <div className="grid grid-cols-2 gap-2">
                  <ActionButton onClick={formatJson} variant="primary"><FileJson size={15} />格式化</ActionButton>
                  <ActionButton onClick={minifyJson}>压缩</ActionButton>
                  <ActionButton onClick={() => copyValue(jsonInput, "json")}><Copy size={15} />{copied === "json" ? "已复制" : "复制"}</ActionButton>
                  <ActionButton onClick={() => { setJsonInput(""); setJsonError(""); }}><X size={15} />清空</ActionButton>
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
                <div>字符数：{jsonStats.chars}</div>
                <div>行数：{jsonStats.lines}</div>
              </div>
              {jsonError && <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-600">{jsonError}</div>}
            </aside>
          </ToolPanel>
        )}

        {activeTab === "base64" && (
          <ToolPanel>
            <div className="grid min-h-[520px] grid-rows-2 gap-4">
              <textarea
                value={baseInput}
                onChange={(event) => setBaseInput(event.target.value)}
                className="w-full resize-none rounded-xl border border-slate-200 bg-white p-4 font-mono text-sm leading-relaxed text-slate-700 outline-none focus:border-emerald-500"
                placeholder="输入要编码或解码的文本..."
                spellCheck={false}
              />
              <textarea
                value={baseOutput}
                readOnly
                className="w-full resize-none rounded-xl border border-slate-200 bg-slate-50 p-4 font-mono text-sm leading-relaxed text-emerald-700 outline-none"
                placeholder="输出结果..."
                spellCheck={false}
              />
            </div>
            <aside className="space-y-4">
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="mb-3 text-sm font-semibold text-slate-900">Base64 操作</div>
                <div className="grid gap-2">
                  <ActionButton onClick={() => handleBase64("encode")} variant="primary">编码 UTF-8</ActionButton>
                  <ActionButton onClick={() => handleBase64("decode")}>解码 UTF-8</ActionButton>
                  <ActionButton onClick={() => copyValue(baseOutput, "base64")}><Copy size={15} />{copied === "base64" ? "已复制" : "复制输出"}</ActionButton>
                  <ActionButton onClick={() => { setBaseInput(""); setBaseOutput(""); setBaseError(""); }}><X size={15} />清空</ActionButton>
                </div>
              </div>
              {baseError && <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-600">{baseError}</div>}
            </aside>
          </ToolPanel>
        )}

        {activeTab === "url" && (
          <ToolPanel>
            <div className="grid min-h-[520px] grid-rows-2 gap-4">
              <textarea
                value={urlInput}
                onChange={(event) => setUrlInput(event.target.value)}
                className="w-full resize-none rounded-xl border border-slate-200 bg-white p-4 font-mono text-sm leading-relaxed text-slate-700 outline-none focus:border-emerald-500"
                placeholder="输入要 URL 编码或解码的文本..."
                spellCheck={false}
              />
              <textarea
                value={urlOutput}
                readOnly
                className="w-full resize-none rounded-xl border border-slate-200 bg-slate-50 p-4 font-mono text-sm leading-relaxed text-emerald-700 outline-none"
                placeholder="输出结果..."
                spellCheck={false}
              />
            </div>
            <aside className="space-y-4">
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="mb-3 text-sm font-semibold text-slate-900">URL 操作</div>
                <div className="grid gap-2">
                  <ActionButton onClick={() => handleUrl("encode")} variant="primary">Encode</ActionButton>
                  <ActionButton onClick={() => handleUrl("decode")}>Decode</ActionButton>
                  <ActionButton onClick={() => copyValue(urlOutput, "url")}><Copy size={15} />{copied === "url" ? "已复制" : "复制输出"}</ActionButton>
                  <ActionButton onClick={() => { setUrlInput(""); setUrlOutput(""); setUrlError(""); }}><X size={15} />清空</ActionButton>
                </div>
              </div>
              {urlError && <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-600">{urlError}</div>}
            </aside>
          </ToolPanel>
        )}

        {activeTab === "hash" && (
          <ToolPanel>
            <div className="grid min-h-[520px] grid-rows-[1fr_170px] gap-4">
              <textarea
                value={hashInput}
                onChange={(event) => setHashInput(event.target.value)}
                className="w-full resize-none rounded-xl border border-slate-200 bg-white p-4 font-mono text-sm leading-relaxed text-slate-700 outline-none focus:border-emerald-500"
                placeholder="输入需要计算摘要的内容..."
                spellCheck={false}
              />
              <textarea
                value={hashOutput}
                readOnly
                className="w-full resize-none rounded-xl border border-slate-200 bg-slate-50 p-4 font-mono text-sm leading-relaxed text-emerald-700 outline-none"
                placeholder="Hash 输出..."
                spellCheck={false}
              />
            </div>
            <aside className="space-y-4">
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="mb-3 text-sm font-semibold text-slate-900">Hash 算法</div>
                <OptionSelect
                  value={hashType}
                  options={hashOptions}
                  onChange={setHashType}
                  className="mb-3"
                  buttonClassName="py-3.5 text-base"
                />
                <div className="grid gap-2">
                  <ActionButton onClick={handleHash} variant="primary"><Hash size={15} />计算</ActionButton>
                  <label className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900">
                    文件 Hash
                    <input
                      type="file"
                      className="hidden"
                      onChange={(event) => {
                        void handleHashFile(event.target.files?.[0]);
                        event.currentTarget.value = "";
                      }}
                    />
                  </label>
                  <ActionButton onClick={() => copyValue(hashOutput, "hash")}><Copy size={15} />{copied === "hash" ? "已复制" : "复制结果"}</ActionButton>
                </div>
              </div>
              {hashFileName && (
                <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
                  当前文件：<span className="font-mono text-slate-900">{hashFileName}</span>
                </div>
              )}
            </aside>
          </ToolPanel>
        )}

        {activeTab === "regex" && (
          <ToolPanel>
            <div className="grid min-h-[520px] grid-rows-[auto_1fr_180px] gap-4">
              <div className="grid grid-cols-[minmax(0,1fr)_120px] gap-3">
                <input
                  value={regexPattern}
                  onChange={(event) => setRegexPattern(event.target.value)}
                  className="rounded-xl border border-slate-200 bg-white px-4 py-3 font-mono text-sm text-emerald-700 outline-none focus:border-emerald-500"
                  placeholder="Pattern，例如 [A-Za-z0-9]+"
                />
                <input
                  value={regexFlags}
                  onChange={(event) => setRegexFlags(event.target.value.replace(/[^dgimsuvy]/g, ""))}
                  className="rounded-xl border border-slate-200 bg-white px-4 py-3 font-mono text-sm text-slate-700 outline-none focus:border-emerald-500"
                  placeholder="flags"
                />
              </div>
              <textarea
                value={regexText}
                onChange={(event) => setRegexText(event.target.value)}
                className="w-full resize-none rounded-xl border border-slate-200 bg-white p-4 font-mono text-sm leading-relaxed text-slate-700 outline-none focus:border-emerald-500"
                placeholder="测试文本..."
                spellCheck={false}
              />
              <div className="overflow-auto rounded-xl border border-slate-200 bg-slate-50 p-4 font-mono text-sm">
                {regexError ? (
                  <div className="text-red-600">{regexError}</div>
                ) : regexMatches.length > 0 ? (
                  <div className="space-y-2">
                    {regexMatches.map((match, index) => (
                      <div key={`${match.index}-${index}`} className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-700">
                        <span className="mr-3 text-slate-400">#{index + 1} @ {match.index}</span>
                        {match.value}
                      </div>
                    ))}
                  </div>
                ) : (
                  <span className="text-slate-400">暂无匹配</span>
                )}
              </div>
            </div>
            <aside className="space-y-4">
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="mb-3 text-sm font-semibold text-slate-900">Regex 操作</div>
                <div className="grid gap-2">
                  <ActionButton onClick={handleRegex} variant="primary"><Code size={15} />运行匹配</ActionButton>
                  <ActionButton onClick={() => copyValue(regexMatches.map((match) => match.value).join("\n"), "regex")}><Copy size={15} />{copied === "regex" ? "已复制" : "复制匹配"}</ActionButton>
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
                匹配数量：{regexMatches.length}
              </div>
            </aside>
          </ToolPanel>
        )}

        {activeTab === "time" && (
          <ToolPanel>
            <div className="grid min-h-[520px] grid-rows-[auto_auto_minmax(0,1fr)] gap-4">
              <div className="grid gap-3 xl:grid-cols-3">
                <div className="rounded-xl border border-slate-200 bg-white p-4">
                  <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-slate-400">
                    <Clock size={14} />
                    当前本地时间
                  </div>
                  <div className="font-mono text-lg font-semibold text-slate-900">{formatZonedTime(now, systemTimeZone)}</div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-4">
                  <div className="mb-2 text-xs font-semibold text-slate-400">当前秒</div>
                  <div className="font-mono text-lg font-semibold text-emerald-700">{currentSeconds}</div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-4">
                  <div className="mb-2 text-xs font-semibold text-slate-400">当前毫秒</div>
                  <div className="font-mono text-lg font-semibold text-emerald-700">{currentMilliseconds}</div>
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="mb-3 text-sm font-semibold text-slate-900">时间戳转换</div>
                <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_240px]">
                  <input
                    type="text"
                    value={timeInput}
                    onChange={(event) => setTimeInput(event.target.value)}
                    className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 font-mono text-sm text-emerald-700 outline-none focus:border-emerald-500 focus:bg-white"
                    placeholder="输入秒或毫秒时间戳"
                  />
                  <div className="grid grid-cols-3 gap-1 rounded-lg border border-slate-200 bg-slate-50 p-1">
                    {timestampUnitOptions.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => setTimestampUnit(option.value)}
                        className={cn(
                          "rounded-md px-3 py-2 text-sm font-semibold transition-colors",
                          timestampUnit === option.value
                            ? "bg-white text-slate-900 shadow-sm"
                            : "text-slate-400 hover:text-slate-700",
                        )}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="min-h-[320px] space-y-4 overflow-auto">
                {timeError && (
                  <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-600">
                    {timeError}
                  </div>
                )}

                {!timeError && !timeResult && (
                  <div className="flex min-h-[320px] items-center justify-center rounded-xl border border-dashed border-slate-200 bg-white text-sm font-medium text-slate-400">
                    转换结果会显示在这里
                  </div>
                )}

                {timeResult && (
                  <>
                    <section className="rounded-xl border border-slate-200 bg-white p-4">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div className="text-sm font-semibold text-slate-900">标准时间</div>
                        <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">
                          {timeResult.unitLabel}
                        </span>
                      </div>
                      <div className="divide-y divide-slate-100">
                        {[
                          { id: "iso", label: "ISO 8601", value: timeResult.iso },
                          { id: "local", label: "本地", value: timeResult.local },
                          { id: "utc", label: "UTC", value: timeResult.utc },
                        ].map((item) => (
                          <div key={item.id} className="grid gap-2 py-3 md:grid-cols-[96px_minmax(0,1fr)_32px] md:items-center">
                            <div className="text-sm font-semibold text-slate-500">{item.label}</div>
                            <div className="min-w-0 break-all font-mono text-sm text-slate-900">{item.value}</div>
                            <button
                              type="button"
                              title="复制"
                              onClick={() => copyValue(item.value, `time-${item.id}`)}
                              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
                            >
                              <Copy size={15} />
                            </button>
                          </div>
                        ))}
                      </div>
                    </section>

                    <section className="rounded-xl border border-slate-200 bg-white p-4">
                      <div className="mb-3 text-sm font-semibold text-slate-900">时间戳</div>
                      <div className="grid gap-3 md:grid-cols-2">
                        {[
                          { id: "seconds", label: "秒", value: timeResult.seconds },
                          { id: "milliseconds", label: "毫秒", value: timeResult.milliseconds },
                        ].map((item) => (
                          <div key={item.id} className="flex items-center justify-between gap-3 border-b border-slate-100 pb-3 last:border-b-0 last:pb-0 md:border-b-0 md:pb-0">
                            <div className="min-w-0">
                              <div className="mb-1 text-xs font-semibold text-slate-400">{item.label}</div>
                              <div className="truncate font-mono text-lg font-semibold text-emerald-700">{item.value}</div>
                            </div>
                            <button
                              type="button"
                              title="复制"
                              onClick={() => copyValue(item.value, `time-${item.id}`)}
                              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-900"
                            >
                              <Copy size={15} />
                            </button>
                          </div>
                        ))}
                      </div>
                    </section>

                    <section className="rounded-xl border border-slate-200 bg-white p-4">
                      <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-900">
                        <Globe2 size={16} />
                        多时区
                      </div>
                      <div className="divide-y divide-slate-100">
                        {timeResult.zones.map((zone) => (
                          <div key={`${zone.label}-${zone.timeZone}`} className="grid gap-2 py-3 md:grid-cols-[150px_minmax(0,1fr)_32px] md:items-center">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-semibold text-slate-700">{zone.label}</div>
                              <div className="truncate text-xs text-slate-400">{zone.timeZone}</div>
                            </div>
                            <div className="min-w-0 font-mono text-sm font-semibold text-slate-900">{zone.value}</div>
                            <button
                              type="button"
                              title="复制"
                              onClick={() => copyValue(zone.value, `time-zone-${zone.timeZone}`)}
                              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
                            >
                              <Copy size={15} />
                            </button>
                          </div>
                        ))}
                      </div>
                    </section>
                  </>
                )}
              </div>
            </div>
            <aside className="space-y-4">
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="mb-3 text-sm font-semibold text-slate-900">时间操作</div>
                <div className="grid gap-2">
                  <ActionButton onClick={handleTime} variant="primary"><Calendar size={15} />转换</ActionButton>
                  <ActionButton onClick={() => { setTimeInput(currentMilliseconds.toString()); setTimestampUnit("milliseconds"); }}><Clipboard size={15} />填入当前毫秒</ActionButton>
                  <ActionButton onClick={() => { setTimeInput(currentSeconds.toString()); setTimestampUnit("seconds"); }}><RotateCcw size={15} />填入当前秒</ActionButton>
                  <ActionButton onClick={() => copyValue(timeOutput, "time")}><Copy size={15} />{copied === "time" ? "已复制" : "复制结果"}</ActionButton>
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-900">
                  <Globe2 size={16} />
                  多时区当前时间
                </div>
                <div className="space-y-2">
                  {timeZoneRows.map((zone) => (
                    <div key={`${zone.label}-${zone.timeZone}`} className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
                      <div className="flex items-center justify-between gap-3">
                        <span className="min-w-0 truncate text-sm font-semibold text-slate-700">{zone.label}</span>
                        <span className="shrink-0 font-mono text-sm text-emerald-700">{formatZonedTime(now, zone.timeZone)}</span>
                      </div>
                      <div className="mt-1 truncate text-xs text-slate-400">{zone.timeZone}</div>
                    </div>
                  ))}
                </div>
              </div>
            </aside>
          </ToolPanel>
        )}

        {activeTab === "api" && (
          <ToolPanel>
            <div className="grid min-h-[520px] grid-rows-[auto_160px_minmax(0,1fr)] gap-4">
              <div className="grid gap-3 md:grid-cols-[130px_minmax(0,1fr)]">
                <OptionSelect value={apiMethod} options={apiMethodOptions} onChange={setApiMethod} />
                <input
                  value={apiUrl}
                  onChange={(event) => setApiUrl(event.target.value)}
                  className="rounded-xl border border-slate-200 bg-white px-4 py-3 font-mono text-sm text-slate-700 outline-none focus:border-emerald-500"
                  placeholder="http://localhost:8080/api"
                />
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                <textarea
                  value={apiHeaders}
                  onChange={(event) => setApiHeaders(event.target.value)}
                  className="resize-none rounded-xl border border-slate-200 bg-white p-4 font-mono text-sm text-slate-700 outline-none focus:border-emerald-500"
                  placeholder={"Headers，一行一个\nAuthorization: Bearer ...\nContent-Type: application/json"}
                  spellCheck={false}
                />
                <textarea
                  value={apiBody}
                  onChange={(event) => setApiBody(event.target.value)}
                  className="resize-none rounded-xl border border-slate-200 bg-white p-4 font-mono text-sm text-slate-700 outline-none focus:border-emerald-500"
                  placeholder="Body"
                  spellCheck={false}
                />
              </div>
              <textarea
                value={apiOutput}
                readOnly
                className="w-full resize-none rounded-xl border border-slate-200 bg-slate-50 p-4 font-mono text-sm leading-relaxed text-emerald-700 outline-none"
                placeholder="响应结果..."
                spellCheck={false}
              />
            </div>
            <aside className="space-y-4">
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="mb-3 text-sm font-semibold text-slate-900">请求操作</div>
                <div className="grid gap-2">
                  <ActionButton onClick={handleApiRequest} variant="primary"><Globe2 size={15} />发送请求</ActionButton>
                  <ActionButton onClick={() => copyValue(apiOutput, "api")}><Copy size={15} />{copied === "api" ? "已复制" : "复制响应"}</ActionButton>
                  <ActionButton onClick={() => { setApiOutput(""); setApiError(""); }}><X size={15} />清空结果</ActionButton>
                </div>
              </div>
              {apiError && <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-600">{apiError}</div>}
            </aside>
          </ToolPanel>
        )}

        {activeTab === "system" && (
          <ToolPanel>
            <div className="grid min-h-[520px] gap-4 xl:grid-cols-2">
              <section className="rounded-xl border border-slate-200 bg-white p-5">
                <div className="mb-5 flex items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700">
                    <Pipette size={20} />
                  </span>
                  <div>
                    <div className="font-semibold text-slate-900">屏幕取色</div>
                    <div className="text-sm text-slate-400">读取鼠标所在像素的 HEX / RGB。</div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handlePickColor}
                  className="mb-5 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 text-sm font-semibold text-white transition-colors hover:bg-emerald-600"
                >
                  <Pipette size={16} />
                  延迟取色
                </button>
                {pickedColor ? (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                    <div className="mb-4 flex items-center gap-3">
                      <div
                        className="h-16 w-16 shrink-0 rounded-xl border border-white shadow-sm ring-1 ring-slate-200"
                        style={{ backgroundColor: pickedColor.hex }}
                      />
                      <div className="min-w-0">
                        <div className="font-mono text-xl font-bold text-slate-900">{pickedColor.hex}</div>
                        <div className="mt-1 font-mono text-sm text-slate-500">{pickedColor.rgb}</div>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <ActionButton onClick={() => copyValue(pickedColor.hex, "color-hex")}><Copy size={15} />复制 HEX</ActionButton>
                      <ActionButton onClick={() => copyValue(pickedColor.rgb, "color-rgb")}><Copy size={15} />复制 RGB</ActionButton>
                    </div>
                  </div>
                ) : (
                  <div className="flex min-h-[170px] items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50 text-sm font-medium text-slate-400">
                    {colorStatus || "取色结果会显示在这里"}
                  </div>
                )}
                {pickedColor && colorStatus && <div className="mt-3 text-sm font-medium text-slate-400">{colorStatus}</div>}
              </section>

              <section className="rounded-xl border border-slate-200 bg-white p-5">
                <div className="mb-5 flex items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700">
                    <UploadCloud size={20} />
                  </span>
                  <div>
                    <div className="font-semibold text-slate-900">局域网快传</div>
                    <div className="text-sm text-slate-400">临时 HTTP 收件箱，10 分钟自动过期。</div>
                  </div>
                </div>

                {localDropInfo ? (
                  <div className="space-y-4">
                    <div className="flex justify-center rounded-xl border border-slate-200 bg-slate-50 p-4">
                      {localDropQr ? (
                        <img src={localDropQr} alt="Local Drop QR" className="h-[220px] w-[220px] rounded-lg bg-white" />
                      ) : (
                        <div className="flex h-[220px] w-[220px] items-center justify-center rounded-lg bg-white text-slate-400">
                          <QrCode size={42} />
                        </div>
                      )}
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                      <div className="mb-2 text-xs font-semibold text-slate-400">访问地址</div>
                      <div className="break-all font-mono text-sm font-semibold text-emerald-700">{localDropInfo.url}</div>
                      <div className="mt-3 text-xs font-semibold text-slate-400">保存目录</div>
                      <div className="mt-1 break-all font-mono text-xs text-slate-500">{localDropInfo.inboxPath}</div>
                      <div className="mt-3 text-xs text-slate-400">过期时间：{formatZonedTime(new Date(localDropInfo.expiresAt), systemTimeZone)}</div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <ActionButton onClick={() => copyValue(localDropInfo.url, "local-drop-url")}><Copy size={15} />复制链接</ActionButton>
                      <ActionButton onClick={handleStopLocalDrop}><X size={15} />停止快传</ActionButton>
                    </div>
                  </div>
                ) : (
                  <div className="flex min-h-[360px] flex-col items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50 p-8 text-center">
                    <Wifi size={42} className="mb-4 text-emerald-600" />
                    <div className="mb-5 max-w-xs text-sm leading-6 text-slate-400">
                      开启后手机扫码即可上传文件到本机本地收件箱。
                    </div>
                    <button
                      type="button"
                      onClick={handleStartLocalDrop}
                      className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-emerald-500 px-5 text-sm font-semibold text-white transition-colors hover:bg-emerald-600"
                    >
                      <UploadCloud size={16} />
                      开启快传
                    </button>
                  </div>
                )}
              </section>
            </div>
            <aside className="space-y-4">
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="mb-3 text-sm font-semibold text-slate-900">系统工具</div>
                <div className="grid gap-2">
                  <ActionButton onClick={handlePickColor} variant="primary"><Pipette size={15} />屏幕取色</ActionButton>
                  {localDropInfo ? (
                    <ActionButton onClick={handleStopLocalDrop}><X size={15} />停止快传</ActionButton>
                  ) : (
                    <ActionButton onClick={handleStartLocalDrop}><UploadCloud size={15} />开启快传</ActionButton>
                  )}
                </div>
              </div>
              {(localDropError || colorStatus) && (
                <div className={cn(
                  "rounded-xl border p-4 text-sm font-medium",
                  localDropError ? "border-red-200 bg-red-50 text-red-600" : "border-slate-200 bg-white text-slate-500",
                )}>
                  {localDropError || colorStatus}
                </div>
              )}
            </aside>
          </ToolPanel>
        )}

        {activeTab === "image" && (
          <ToolPanel>
            <div className="flex min-h-[520px] flex-col items-center justify-center rounded-xl border border-dashed border-slate-200 bg-white p-8">
              <ImageIcon size={46} className="mb-4 text-emerald-600" />
              <label className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-600">
                选择图片
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={(event) => {
                    void handleImageFile(event.target.files?.[0]);
                    event.currentTarget.value = "";
                  }}
                />
              </label>
              {imageStats && <div className="mt-4 font-mono text-sm text-slate-500">{imageStats}</div>}
              {imageOutputUrl && (
                <button
                  type="button"
                  onClick={handleExportImage}
                  className="mt-4 inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
                >
                  <Download size={15} /> 导出 {imageOutputName}
                </button>
              )}
            </div>
            <aside className="space-y-4">
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="mb-3 text-sm font-semibold text-slate-900">输出格式</div>
                <OptionSelect
                  value={imageFormat}
                  options={imageFormatOptions}
                  onChange={setImageFormat}
                  className="mb-3"
                />
                <label className="block text-sm font-medium text-slate-600">
                  质量 {Math.round(imageQuality * 100)}%
                  <input
                    type="range"
                    min="0.4"
                    max="1"
                    step="0.02"
                    value={imageQuality}
                    onChange={(event) => setImageQuality(Number(event.target.value))}
                    className="mt-3 w-full accent-emerald-500"
                    disabled={imageFormat === "image/png"}
                  />
                </label>
              </div>
              {imageError && <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-600">{imageError}</div>}
            </aside>
          </ToolPanel>
        )}
      </div>
    </div>
  );
}
