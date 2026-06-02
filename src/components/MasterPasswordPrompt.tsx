import { FormEvent, useEffect, useRef, useState } from "react";
import { KeyRound, X } from "lucide-react";
import { motion } from "motion/react";
import { verifyMasterPassword } from "../lib/desktop";

export interface MasterPasswordRequest {
  id: number;
  reason: string;
  resolve: (verified: boolean) => void;
}

interface MasterPasswordPromptProps {
  request: MasterPasswordRequest;
  onClose: () => void;
}

export function MasterPasswordPrompt({ request, onClose }: MasterPasswordPromptProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isVerifying, setIsVerifying] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setPassword("");
    setError("");
    window.setTimeout(() => inputRef.current?.focus(), 50);
  }, [request.id]);

  const finish = (verified: boolean) => {
    request.resolve(verified);
    onClose();
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const normalizedPassword = password.trim();
    if (!normalizedPassword) {
      setError("请输入主密码");
      return;
    }

    setIsVerifying(true);
    setError("");
    try {
      await verifyMasterPassword(normalizedPassword);
      finish(true);
    } catch {
      setError("主密码不正确，请再试一次");
      setPassword("");
      window.setTimeout(() => inputRef.current?.focus(), 50);
    } finally {
      setIsVerifying(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/35 p-6 backdrop-blur-sm"
    >
      <motion.form
        initial={{ opacity: 0, y: 18, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 12, scale: 0.98 }}
        onSubmit={handleSubmit}
        className="w-full max-w-md overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600">
              <KeyRound size={19} />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-bold text-slate-900">主密码验证</h2>
              <p className="truncate text-xs font-medium text-slate-400">{request.reason}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => finish(false)}
            className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-900"
            title="取消"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4 p-5">
          <label className="block">
            <span className="mb-2 block text-sm font-semibold text-slate-600">请输入主密码</span>
            <input
              ref={inputRef}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="h-12 w-full rounded-xl border border-slate-200 bg-slate-50 px-4 text-base font-semibold text-slate-900 outline-none transition-all placeholder:text-slate-400 focus:border-emerald-500 focus:bg-white focus:ring-4 focus:ring-emerald-500/10"
              placeholder="Master Password"
            />
          </label>

          {error && (
            <div className="rounded-xl border border-red-100 bg-red-50 px-3 py-2 text-sm font-medium text-red-600">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => finish(false)}
              className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-600 transition-colors hover:bg-slate-50"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={isVerifying}
              className="rounded-xl bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-600 disabled:opacity-60"
            >
              {isVerifying ? "验证中..." : "确认验证"}
            </button>
          </div>
        </div>
      </motion.form>
    </motion.div>
  );
}
