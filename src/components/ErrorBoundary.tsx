import React, { Component, ReactNode } from "react";

interface ErrorBoundaryProps {
  key?: string | number;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  // REGRESI (bug "klik MTF / ganti TF di dashboard tidak mengubah chart"):
  // dulu ada `private child` yang di-snap di constructor dan dikembalikan
  // render() — React menerima element reference yang SAMA setiap render →
  // seluruh subtree di dalam boundary dibekukan pada props mount-time dan
  // tidak pernah menerima update dari App (state berubah, UI tab tidak).
  // render() WAJIB memakai props.children TERKINI (React sinkronkan
  // instance.props tiap render); error case tetap ditangani
  // getDerivedStateFromError → fallback di bawah.
  // Catatan: repo tanpa @types/react (Component = any) — props & constructor
  // harus dideklarasikan eksplisit supaya tervalidasi tsc.
  props: ErrorBoundaryProps;
  state: ErrorBoundaryState = { error: null };

  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.props = props;
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("[ErrorBoundary] Render error caught:", error, info);
  }

  handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="min-h-[40vh] flex items-center justify-center px-4">
          <div className="max-w-md w-full rounded-xl border border-rose-500/30 bg-rose-500/5 p-5 text-center space-y-4">
            <div className="text-xs font-mono text-rose-400 uppercase tracking-widest">Panel crashed</div>
            <div className="text-sm font-mono text-zinc-300 break-words">
              {(this.state.error as Error).message || "Unknown render error"}
            </div>
            <div className="flex items-center justify-center gap-2">
              <button
                type="button"
                onClick={this.handleReload}
                className="px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-mono font-bold transition"
              >
                Reload app
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}