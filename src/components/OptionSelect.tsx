import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "../lib/utils";

export interface OptionItem<T extends string> {
  value: T;
  label: string;
}

interface OptionSelectProps<T extends string> {
  value: T;
  options: OptionItem<T>[];
  onChange: (value: T) => void;
  className?: string;
  buttonClassName?: string;
}

export function OptionSelect<T extends string>({
  value,
  options,
  onChange,
  className,
  buttonClassName,
}: OptionSelectProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [isOpen]);

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        className={cn(
          "flex w-full items-center justify-between rounded-xl border bg-slate-50 px-4 py-3 text-left text-sm font-semibold text-slate-900 outline-none transition-all",
          isOpen
            ? "border-emerald-500 bg-white ring-4 ring-emerald-500/10"
            : "border-slate-200 hover:border-slate-300 hover:bg-white",
          buttonClassName,
        )}
      >
        <span className="truncate">{selected?.label}</span>
        <ChevronDown
          size={18}
          className={cn("ml-3 shrink-0 text-emerald-600 transition-transform", isOpen && "rotate-180")}
        />
      </button>

      {isOpen && (
        <div className="absolute left-0 right-0 top-[calc(100%+8px)] z-50 overflow-hidden rounded-2xl border border-slate-200 bg-white p-2 shadow-[0_24px_55px_rgba(15,23,42,0.14)]">
          {options.map((option) => {
            const selectedOption = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onChange(option.value);
                  setIsOpen(false);
                }}
                className={cn(
                  "flex w-full min-w-0 items-center justify-between gap-3 rounded-xl px-4 py-3 text-left text-sm font-semibold transition-colors",
                  selectedOption
                    ? "bg-emerald-50 text-emerald-700"
                    : "text-slate-500 hover:bg-slate-50 hover:text-slate-900",
                )}
              >
                <span className="min-w-0 truncate">{option.label}</span>
                {selectedOption && <Check size={17} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
