import React from "react";
import { View } from "../types";
import { ALL_APPS } from "../config";
import { motion } from "motion/react";
import { X, Pin } from "lucide-react";
import { cn } from "../lib/utils";

interface LauncherProps {
  onClose: () => void;
  currentView: View;
  setCurrentView: (v: View) => void;
  pinnedViews: View[];
  onTogglePin: (v: View) => void;
}

export function Launcher({ onClose, currentView, setCurrentView, pinnedViews, onTogglePin }: LauncherProps) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95, filter: "blur(10px)" }}
      animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
      exit={{ opacity: 0, scale: 0.95, filter: "blur(10px)" }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-white/80 backdrop-blur-2xl p-6"
    >
      <button 
        onClick={onClose}
        className="absolute top-8 right-8 p-3 bg-slate-100 hover:bg-slate-200 text-slate-500 hover:text-slate-900 rounded-full transition-colors shadow-sm"
      >
        <X size={24} />
      </button>

      <div className="w-full max-w-5xl">
        <h2 className="text-3xl font-bold tracking-tight text-slate-900 mb-12 text-center">所有工具</h2>
        
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
          {ALL_APPS.map(app => {
            const isPinned = pinnedViews.includes(app.id);
            const isActive = currentView === app.id;
            
            return (
              <div 
                key={app.id}
                className={cn(
                  "relative group flex flex-col items-center gap-4 p-8 rounded-3xl transition-all cursor-pointer border",
                  isActive ? "bg-emerald-100 border-emerald-300" : "bg-white border-slate-200 hover:bg-slate-50 hover:border-slate-300 hover:-translate-y-1 shadow-lg"
                )}
                onClick={() => {
                  setCurrentView(app.id);
                  onClose();
                }}
              >
                <div className={cn(
                  "p-4 rounded-2xl shadow-inner transition-colors",
                  isActive ? "bg-emerald-500/20 text-emerald-600" : "bg-slate-100 text-slate-600 group-hover:text-emerald-600 group-hover:bg-slate-200"
                )}>
                  {React.cloneElement(app.icon as React.ReactElement, { size: 36 } as any)}
                </div>
                <div className="text-center">
                  <div className="text-lg font-bold text-slate-800 mb-1">{app.label}</div>
                  <div className="text-xs text-slate-400">{app.desc}</div>
                </div>

                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onTogglePin(app.id);
                  }}
                  className={cn(
                    "absolute top-4 right-4 p-2 rounded-full transition-all",
                    isPinned ? "text-emerald-600 opacity-100" : "text-slate-400 opacity-0 group-hover:opacity-100 hover:bg-slate-200 hover:text-slate-600"
                  )}
                  title={isPinned ? "取消固定到 Dock" : "固定到 Dock"}
                >
                  <Pin size={18} className={isPinned ? "fill-emerald-600" : ""} />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </motion.div>
  );
}
