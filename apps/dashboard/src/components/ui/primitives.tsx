import type { ButtonHTMLAttributes, ReactNode } from "react";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export type Tone = "neutral" | "accent" | "ok" | "warn" | "bad" | "violet";

const TONE: Record<Tone, string> = {
  neutral: "border-line-strong text-muted bg-raised",
  accent: "border-accent/40 text-accent-soft bg-accent/10",
  ok: "border-ok/40 text-ok bg-ok/10",
  warn: "border-warn/40 text-warn bg-warn/10",
  bad: "border-bad/40 text-bad bg-bad/10",
  violet: "border-violet/40 text-violet bg-violet/10",
};

export function Badge({ tone = "neutral", children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex items-center gap-1 rounded border px-1.5 py-px text-[11px] font-medium leading-4 whitespace-nowrap", TONE[tone], className)}>
      {children}
    </span>
  );
}

export function Dot({ color, className }: { color: string; className?: string }) {
  return <span aria-hidden className={cx("inline-block h-2 w-2 shrink-0 rounded-full", className)} style={{ background: color }} />;
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const BUTTON: Record<ButtonVariant, string> = {
  primary: "bg-accent text-white border-accent hover:bg-[#5598ff] disabled:bg-accent/30 disabled:border-accent/20 disabled:text-white/50",
  secondary: "bg-raised text-fg border-line-strong hover:border-[#3b4757] hover:bg-[#1a212a] disabled:text-dim disabled:hover:bg-raised",
  ghost: "bg-transparent text-muted border-transparent hover:text-fg hover:bg-raised disabled:text-dim",
  danger: "bg-bad/10 text-bad border-bad/40 hover:bg-bad/20 disabled:opacity-40",
};

export function Button({ variant = "secondary", size = "md", className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "sm" | "md" }) {
  return (
    <button
      type="button"
      {...rest}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-md border font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed",
        size === "sm" ? "h-7 px-2 text-xs" : "h-8 px-3 text-[13px]",
        BUTTON[variant],
        className,
      )}
    />
  );
}

export function Panel({ title, subtitle, actions, children, className, bodyClassName, id }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string; id?: string }) {
  return (
    <section id={id} aria-labelledby={id ? `${id}-title` : undefined} className={cx("flex min-w-0 flex-col rounded-lg border border-line bg-panel", className)}>
      <header className="flex min-h-10 items-center gap-2 border-b border-line px-3 py-2">
        <h2 id={id ? `${id}-title` : undefined} className="text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
          {title}
        </h2>
        {subtitle && <span className="truncate text-xs text-dim">{subtitle}</span>}
        <div className="ml-auto flex items-center gap-1.5">{actions}</div>
      </header>
      <div className={cx("min-h-0 flex-1", bodyClassName ?? "p-3")}>{children}</div>
    </section>
  );
}

/** A labelled metric. `value` is display text; `raw` is the machine-readable value for tests. */
export function Stat({ label, value, sub, testId, raw, tone, className }: { label: ReactNode; value: ReactNode; sub?: ReactNode; testId?: string; raw?: number | string | null; tone?: "ok" | "accent" | "warn" | "bad"; className?: string }) {
  const toneClass = tone === "ok" ? "text-ok" : tone === "accent" ? "text-accent-soft" : tone === "warn" ? "text-warn" : tone === "bad" ? "text-bad" : "text-fg";
  return (
    <div className={cx("min-w-0", className)}>
      <div className="truncate text-[11px] text-muted">{label}</div>
      <div data-testid={testId} data-value={raw ?? ""} className={cx("tnum truncate font-mono text-lg leading-7 font-medium", toneClass)}>
        {value}
      </div>
      {sub && <div className="tnum truncate text-[11px] text-dim">{sub}</div>}
    </div>
  );
}

export function Empty({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("flex items-center justify-center rounded-md border border-dashed border-line px-3 py-6 text-center text-xs text-dim", className)}>{children}</div>;
}

export function KeyValue({ items, className }: { items: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <dl className={cx("grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs", className)}>
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="tnum min-w-0 truncate font-mono text-fg">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
