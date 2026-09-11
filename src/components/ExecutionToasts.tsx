import React, { createContext, useCallback, useContext, useRef, useState } from "react";
import { CheckCircle2, XCircle, AlertTriangle, Info } from "lucide-react";

// ---------------------------------------------------------------------------
// ExecutionToasts — notifikasi eksekusi ala exchange pro (fill, reject, close,
// guardrail, kill-switch). Provider global di App; pushToast dari mana saja
// via useToast(). Auto-dismiss 6 detik, max 5 tampil.
// ---------------------------------------------------------------------------

export type ToastKind = "success" | "error" | "warning" | "info";

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
}

interface ToastContextValue {
  pushToast: (kind: ToastKind, title: string, detail?: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const MAX_TOASTS = 5;
const AUTO_DISMISS_MS = 6000;

const KIND_STYLE: Record<ToastKind, { border: string; bg: string; icon: React.ReactNode }> = {
  success: { border: "border-emerald-500/40", bg: "bg-emerald-950/80", icon: <CheckCircle2 className="w-4 h-4 text-emerald-400" /> },
  error: { border: "border-rose-500/40", bg: "bg-rose-950/80", icon: <XCircle className="w-4 h-4 text-rose-400" /> },
  warning: { border: "border-amber-500/40", bg: "bg-amber-950/80", icon: <AlertTriangle className="w-4 h-4 text-amber-400" /> },
  info: { border: "border-sky-500/40", bg: "bg-sky-950/80", icon: <Info className="w-4 h-4 text-sky-400" /> },
};

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seqRef = useRef(0);

  const pushToast = useCallback((kind: ToastKind, title: string, detail?: string) => {
    const id = ++seqRef.current;
    setToasts((prev) => [...prev.slice(-(MAX_TOASTS - 1)), { id, kind, title, detail }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, AUTO_DISMISS_MS);
  }, []);

  return (
    <ToastContext.Provider value={{ pushToast }}>
      {children}
      {/* Toast container — fixed top-right, di bawah environment bar */}
      <div className="fixed top-12 right-4 z-[100] flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)] pointer-events-none">
        {toasts.map((t) => {
          const s = KIND_STYLE[t.kind];
          return (
            <div
              key={t.id}
              className={`pointer-events-auto ${s.bg} ${s.border} border rounded-xl px-3.5 py-2.5 shadow-lg backdrop-blur-sm flex items-start gap-2.5 animate-[fadeIn_150ms_ease-out]`}
            >
              <span className="mt-0.5 shrink-0">{s.icon}</span>
              <div className="min-w-0">
                <p className="text-xs font-bold font-mono text-zinc-100 leading-tight">{t.title}</p>
                {t.detail && <p className="text-[11px] font-mono text-zinc-400 mt-0.5 break-words">{t.detail}</p>}
              </div>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
};

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast harus dipakai di dalam <ToastProvider>.");
  return ctx;
}
