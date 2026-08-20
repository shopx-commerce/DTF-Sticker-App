import type { ReactNode } from "react";

// Shared chrome for the auth pages, mirroring sticker-maker.tsx's header mark.
export default function AuthLayout({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2.5 mb-8">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-slate-800 to-slate-950 flex items-center justify-center shadow-sm">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><path d="M8 12h8"/><path d="M12 8v8"/></svg>
          </div>
          <span
            className="text-xl text-white font-bold tracking-tight"
            style={{ fontFamily: "'Georgia', 'Times New Roman', serif", letterSpacing: "-0.02em" }}
          >
            AnyContour
          </span>
        </div>
        <div className="bg-white rounded-xl shadow-xl p-8">
          <h1 className="text-xl font-semibold text-slate-900 mb-1">{title}</h1>
          {description && <p className="text-sm text-slate-500 mb-6">{description}</p>}
          {children}
        </div>
        {footer && <div className="mt-6 text-center text-sm text-slate-400">{footer}</div>}
      </div>
    </div>
  );
}
