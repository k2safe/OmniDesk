import { useState, useEffect } from "react";
import { Play, Pause, RotateCcw } from "lucide-react";
import { cn } from "../lib/utils";
import { useStoreField } from "../lib/store";

export function Pomodoro() {
  const [sessions, setSessions] = useStoreField("focusSessions");
  const [timeLeft, setTimeLeft] = useState(25 * 60); // 25 mins
  const [isActive, setIsActive] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);

  useEffect(() => {
    let interval: number | undefined;
    if (isActive && timeLeft > 0) {
      interval = window.setInterval(() => {
        setTimeLeft((prev) => prev - 1);
      }, 1000);
    } else if (timeLeft === 0 && isActive) {
      setIsActive(false);
      const endedAt = Date.now();
      setSessions((prev) => [{
        id: endedAt.toString(),
        startedAt: startedAt ?? endedAt - 25 * 60 * 1000,
        endedAt,
        minutes: 25,
      }, ...prev].slice(0, 100));
      setStartedAt(null);
    }
    return () => clearInterval(interval);
  }, [isActive, setSessions, startedAt, timeLeft]);

  const toggle = () => {
    if (!isActive && !startedAt) setStartedAt(Date.now());
    setIsActive(!isActive);
  };
  const reset = () => {
    setIsActive(false);
    setTimeLeft(25 * 60);
    setStartedAt(null);
  };

  const minutes = Math.floor(timeLeft / 60);
  const seconds = timeLeft % 60;

  return (
    <div className="p-8 max-w-5xl mx-auto w-full h-full text-slate-800 flex flex-col items-center justify-center relative">
      <div className="absolute top-8 left-8">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 mb-2">番茄钟</h1>
        <p className="text-slate-400">记录专注时长。</p>
        <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
            <div className="text-slate-400">累计</div>
            <div className="mt-1 font-mono text-lg font-bold text-emerald-700">
              {sessions.reduce((sum, session) => sum + session.minutes, 0)}m
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
            <div className="text-slate-400">次数</div>
            <div className="mt-1 font-mono text-lg font-bold text-slate-900">{sessions.length}</div>
          </div>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-full w-96 h-96 flex flex-col items-center justify-center shadow-2xl relative">
        <svg className="absolute inset-0 w-full h-full transform -rotate-90">
          <circle
            cx="192"
            cy="192"
            r="180"
            className="stroke-slate-800"
            strokeWidth="4"
            fill="none"
          />
          <circle
            cx="192"
            cy="192"
            r="180"
            className={cn("transition-all duration-1000", isActive ? "stroke-emerald-500" : "stroke-slate-600")}
            strokeWidth="8"
            fill="none"
            strokeDasharray={2 * Math.PI * 180}
            strokeDashoffset={(2 * Math.PI * 180) * (1 - timeLeft / (25 * 60))}
            strokeLinecap="round"
          />
        </svg>

        <div className="z-10 text-center">
          <div className="text-7xl font-bold font-mono tracking-tighter text-slate-900 tabular-nums drop-shadow-md">
            {String(minutes).padStart(2, "0")}:{String(seconds).padStart(2, "0")}
          </div>
          <p className="text-slate-400 mt-2 text-sm uppercase tracking-[0.2em] font-medium">
            {isActive ? "保持专注 (Focus)" : "准备就绪 (Ready)"}
          </p>
        </div>
      </div>

      <div className="flex gap-4 mt-12">
        <button 
          onClick={toggle}
          className={cn(
            "p-5 rounded-full flex items-center justify-center transition-all shadow-lg",
            isActive 
              ? "bg-slate-100 text-slate-900 hover:bg-slate-200 border border-slate-300" 
              : "bg-emerald-500 text-white hover:bg-emerald-400 hover:scale-105"
          )}
        >
          {isActive ? <Pause size={32} /> : <Play size={32} className="ml-1" />}
        </button>
        
        <button 
          onClick={reset}
          className="p-5 rounded-full bg-white border border-slate-200 text-slate-400 hover:text-slate-900 hover:bg-slate-100 flex items-center justify-center transition-colors"
        >
          <RotateCcw size={28} />
        </button>
      </div>
    </div>
  );
}
