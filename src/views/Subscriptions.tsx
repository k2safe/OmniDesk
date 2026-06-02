import { useEffect, useState } from "react";
import { CalendarHeart, Plus, Trash2 } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "../lib/utils";
import { useStoreField } from "../lib/store";
import { OptionSelect } from "../components/OptionSelect";

const cycleOptions: { value: "monthly" | "yearly"; label: string }[] = [
  { value: "monthly", label: "每月 (Monthly)" },
  { value: "yearly", label: "每年 (Yearly)" },
];

export function Subscriptions() {
  const [subs, setSubs] = useStoreField("subscriptions");
  
  const [isAdding, setIsAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCost, setNewCost] = useState("");
  const [newCycle, setNewCycle] = useState<"monthly" | "yearly">("monthly");
  const [newDate, setNewDate] = useState("");
  const [notifiedIds, setNotifiedIds] = useState<Set<string>>(new Set());

  const getDaysDiff = (targetDate: string) => {
    const diffTime = new Date(targetDate).getTime() - new Date().getTime();
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  };

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName || !newCost || !newDate) return;
    setSubs([...subs, { id: Date.now().toString(), name: newName, cost: newCost, cycle: newCycle, nextDate: newDate }]);
    setIsAdding(false);
    setNewName("");
    setNewCost("");
    setNewDate("");
  };

  useEffect(() => {
    const dueSoon = subs.filter((sub) => {
      const days = getDaysDiff(sub.nextDate);
      return days >= 0 && days <= 7 && !notifiedIds.has(sub.id);
    });
    if (dueSoon.length === 0 || typeof Notification === "undefined") return;

    const notify = () => {
      dueSoon.forEach((sub) => {
        const days = getDaysDiff(sub.nextDate);
        new Notification("OmniDesk 订阅提醒", {
          body: `${sub.name} 将在 ${days} 天后到期`,
        });
      });
      setNotifiedIds((prev) => new Set([...prev, ...dueSoon.map((sub) => sub.id)]));
    };

    if (Notification.permission === "granted") {
      notify();
    } else if (Notification.permission === "default") {
      void Notification.requestPermission().then((permission) => {
        if (permission === "granted") notify();
      });
    }
  }, [notifiedIds, subs]);

  return (
    <div className="p-8 max-w-5xl mx-auto w-full h-full text-slate-800 flex flex-col gap-6 overflow-y-auto">
      <header className="flex items-end justify-between shrink-0 mb-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900 mb-2">私密订阅追踪</h1>
          <p className="text-slate-400">本地记录服务器、域名及软件会员的续费周期。</p>
        </div>
        <button 
          onClick={() => setIsAdding(true)}
          className="bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-medium py-2 px-4 rounded-md flex items-center gap-2 transition-colors"
        >
          <Plus size={16} /> 添加项目
        </button>
      </header>

      {isAdding && (
        <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="bg-white border border-slate-300 rounded-xl p-5 shrink-0">
          <form onSubmit={handleAdd} className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">项目名称</label>
              <input type="text" value={newName} onChange={e => setNewName(e.target.value)} required placeholder="如: Vercel Pro" className="w-full bg-slate-50 border border-slate-200 rounded p-2.5 text-sm text-slate-900 focus:border-emerald-500 outline-none" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">费用金额</label>
              <input type="text" value={newCost} onChange={e => setNewCost(e.target.value)} required placeholder="如: $20 / ¥150" className="w-full bg-slate-50 border border-slate-200 rounded p-2.5 text-sm text-slate-900 focus:border-emerald-500 outline-none" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">扣费周期</label>
              <OptionSelect value={newCycle} options={cycleOptions} onChange={setNewCycle} />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">下次扣费日</label>
              <div className="flex gap-2">
                <input type="date" value={newDate} onChange={e => setNewDate(e.target.value)} required className="w-full bg-slate-50 border border-slate-200 rounded p-2 text-sm text-slate-900 focus:border-emerald-500 outline-none [color-scheme:dark]" />
                <button type="submit" className="bg-emerald-500 hover:bg-emerald-600 text-white px-4 py-2.5 rounded font-medium text-sm transition-colors">保存</button>
              </div>
            </div>
          </form>
        </motion.div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <AnimatePresence>
          {subs.map(sub => {
            const daysLeft = getDaysDiff(sub.nextDate);
            const isUrgent = daysLeft <= 7 && daysLeft >= 0;
            const isOverdue = daysLeft < 0;

            return (
              <motion.div layout initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} key={sub.id} className="bg-white border border-slate-200 rounded-xl p-5 hover:border-slate-300 transition-all flex flex-col group relative">
                <div className="flex justify-between items-start mb-4">
                  <div className="flex items-center gap-3">
                    <div className={cn("p-2 rounded-lg", isUrgent ? "bg-amber-500/10 text-amber-600" : isOverdue ? "bg-red-500/10 text-red-500" : "bg-emerald-500/10 text-emerald-600")}>
                      <CalendarHeart size={20} />
                    </div>
                    <div>
                      <h3 className="font-medium text-slate-900">{sub.name}</h3>
                      <p className="text-xs text-slate-400">{sub.cycle === "monthly" ? "月度订阅" : "年度订阅"}</p>
                    </div>
                  </div>
                  <button onClick={() => setSubs(subs.filter(s => s.id !== sub.id))} className="text-slate-600 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity p-1" title="删除">
                    <Trash2 size={16} />
                  </button>
                </div>

                <div className="flex justify-between items-end mt-auto">
                  <div className="text-lg font-bold text-slate-900">{sub.cost}</div>
                  <div className="text-right">
                    <div className={cn("text-xl font-bold font-mono tracking-tight", isUrgent ? "text-amber-600" : isOverdue ? "text-red-500" : "text-emerald-600")}>
                      {isOverdue ? "已过期" : `${daysLeft} 天后`}
                    </div>
                    <div className="text-xs text-slate-400">{sub.nextDate} 扣费</div>
                  </div>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}
