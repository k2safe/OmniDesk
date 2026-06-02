import { LayoutGrid, Settings } from "lucide-react";
import { View } from "../types";
import { cn } from "../lib/utils";
import { motion, useMotionValue, useSpring, useTransform, Reorder } from "motion/react";
import { ALL_APPS } from "../config";
import React, { useRef } from "react";

interface DockProps {
  currentView: View;
  setCurrentView: (v: View) => void;
  pinnedViews: View[];
  onReorder: (views: View[]) => void;
  onOpenLauncher: () => void;
  onOpenCommonSettings: () => void;
}

function DockItem({ item, isActive, onClick, mouseX }: { item: any, isActive: boolean, onClick: () => void, mouseX: any }) {
  const ref = useRef<HTMLDivElement>(null);

  const distance = useTransform(mouseX, (val: number) => {
    const bounds = ref.current?.getBoundingClientRect() ?? { x: 0, width: 0 };
    return val - bounds.x - bounds.width / 2;
  });

  const widthSync = useTransform(distance, [-150, 0, 150], [48, 64, 48]);
  const width = useSpring(widthSync, { mass: 0.1, stiffness: 150, damping: 12 });

  return (
    <Reorder.Item value={item.id} id={item.id} className="relative group touch-none">
      <motion.button
        ref={ref as any}
        style={{ width, height: width }}
        onClick={onClick}
        whileTap={{ scale: 0.95 }}
        className={cn(
          "relative rounded-2xl transition-colors flex items-center justify-center",
          isActive ? "bg-slate-100 text-emerald-600" : "text-slate-500 hover:text-slate-800 hover:bg-slate-100"
        )}
      >
        <motion.div className="flex items-center justify-center relative z-10 w-full h-full pointer-events-none">
          {React.cloneElement(item.icon, { size: "50%", strokeWidth: 2 })}
        </motion.div>
        
        {/* Tooltip */}
        <div className="absolute -top-12 left-1/2 -translate-x-1/2 px-3 py-1.5 bg-slate-100 text-slate-800 text-xs font-medium rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap hidden md:block shadow-xl border border-slate-300">
          {item.label}
        </div>
      </motion.button>
    </Reorder.Item>
  );
}

export function Dock({ currentView, setCurrentView, pinnedViews, onReorder, onOpenLauncher, onOpenCommonSettings }: DockProps) {
  const items = pinnedViews.map(id => ALL_APPS.find(app => app.id === id)).filter(Boolean) as typeof ALL_APPS;
  const mouseX = useMotionValue(Infinity);

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40">
      <div 
        className="flex items-end gap-2 p-3 bg-white/70 backdrop-blur-2xl border border-slate-200 rounded-3xl shadow-xl"
        onMouseMove={(e) => mouseX.set(e.pageX)}
        onMouseLeave={() => mouseX.set(Infinity)}
      >
        <button
          onClick={onOpenLauncher}
          className="relative w-12 h-12 rounded-2xl text-slate-500 hover:text-emerald-600 hover:bg-slate-100 transition-all flex items-center justify-center group shrink-0"
        >
          <div className="transition-transform duration-200 group-hover:scale-110 group-active:scale-95">
            <LayoutGrid size={22} />
          </div>
          <div className="absolute -top-12 left-1/2 -translate-x-1/2 px-3 py-1.5 bg-slate-100 text-slate-800 text-xs font-medium rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap hidden md:block shadow-xl border border-slate-300 z-50">
            全部应用
          </div>
        </button>
        
        <div className="w-px h-8 bg-slate-200 mx-2 shrink-0 self-center"></div>

        <Reorder.Group 
          axis="x" 
          values={items.map(i => i.id)} 
          onReorder={(newOrder) => onReorder(newOrder as View[])} 
          className="flex items-end gap-2"
        >
          {items.map((item) => (
            <React.Fragment key={item.id}>
              <DockItem 
                item={item} 
                isActive={currentView === item.id} 
                onClick={() => setCurrentView(item.id)} 
                mouseX={mouseX} 
              />
            </React.Fragment>
          ))}
        </Reorder.Group>
        
        <div className="w-px h-8 bg-slate-200 mx-2 shrink-0 self-center"></div>

        <button
          onClick={onOpenCommonSettings}
          className="relative w-12 h-12 rounded-2xl text-slate-500 hover:text-emerald-600 hover:bg-emerald-50 transition-all flex items-center justify-center group shrink-0"
        >
          <div className="transition-transform duration-200 group-hover:scale-110 group-active:scale-95">
            <Settings size={22} />
          </div>
          <div className="absolute -top-12 left-1/2 -translate-x-1/2 px-3 py-1.5 bg-white text-emerald-700 text-xs font-medium rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap hidden md:block shadow-xl border border-emerald-200 z-50">
            公共设置
          </div>
        </button>
      </div>
    </div>
  );
}
