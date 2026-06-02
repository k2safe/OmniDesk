import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { OmniDeskLogo } from "./OmniDeskLogo";

interface LockScreenProps {
  onUnlock: (password: string) => Promise<void>;
  unlockError?: string;
}

export function LockScreen({ onUnlock, unlockError }: LockScreenProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await onUnlock(password);
    } catch {
      setError(true);
      setTimeout(() => setError(false), 500);
      setPassword("");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col items-center justify-center overflow-hidden bg-slate-50 p-4 font-sans">
      {/* 炫酷背景元素 */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-emerald-500/10 rounded-full blur-3xl mix-blend-screen opacity-50"></div>
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl mix-blend-screen opacity-50"></div>
      </div>
      
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="z-10 w-full max-w-sm"
      >
        <div className="bg-white border border-slate-200 rounded-2xl shadow-2xl overflow-hidden p-8">
          <div className="flex flex-col items-center mb-8">
            <div className="mb-4">
              <OmniDeskLogo size={72} />
            </div>
            <h1 className="text-2xl font-bold text-slate-900 tracking-tight">OmniDesk</h1>
            <p className="text-slate-400 text-sm mt-2 text-center">
              端到端加密的极客安全工作台
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <motion.div animate={error ? { x: [-10, 10, -10, 10, 0] } : {}} transition={{ duration: 0.4 }}>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="统一主密码"
                className={`w-full bg-slate-50 border ${
                  error ? "border-red-500" : "border-slate-200 focus:border-emerald-500"
                } rounded-lg px-4 py-3 text-slate-900 placeholder-slate-500 outline-none transition-colors font-mono`}
                autoFocus
              />
            </motion.div>
            <AnimatePresence>
              {error && (
                <motion.p 
                  initial={{ opacity: 0, height: 0 }} 
                  animate={{ opacity: 1, height: 'auto' }} 
                  exit={{ opacity: 0, height: 0 }} 
                  className="text-red-500 text-xs font-medium px-1"
                >
                  {unlockError || "主密码错误"}
                </motion.p>
              )}
            </AnimatePresence>
            <button
              type="submit"
              className="w-full bg-emerald-500 hover:bg-emerald-600 text-white font-medium py-3 px-4 rounded-lg flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
              disabled={!password || isSubmitting}
            >
              {isSubmitting ? "正在解锁..." : "解锁进入工作区"} <ArrowRight size={18} />
            </button>
          </form>
        </div>
        
        <div className="text-center mt-6 text-slate-400 text-xs font-mono">
          <p>系统状态：安全 (SECURE)</p>
          <p className="mt-1">环境：本地完全离线</p>
        </div>
      </motion.div>
    </div>
  );
}
