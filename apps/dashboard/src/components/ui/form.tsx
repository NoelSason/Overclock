import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { cx } from "./primitives";

const control = "w-full rounded-md border border-line-strong bg-sunken px-2 text-[13px] text-fg placeholder:text-dim hover:border-[#3b4757] focus:border-accent focus:outline-none disabled:opacity-50";

export function Field({ label, htmlFor, hint, children, className }: { label: ReactNode; htmlFor: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cx("flex min-w-0 flex-col gap-1", className)}>
      <label htmlFor={htmlFor} className="flex items-baseline gap-2 text-[11px] font-medium text-muted">
        {label}
        {hint && <span className="truncate font-normal text-dim">{hint}</span>}
      </label>
      {children}
    </div>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cx(control, "h-8", className)} />;
}

export function TextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={cx(control, "py-1.5 leading-5", className)} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cx(control, "h-8 pr-6", className)}>
      {children}
    </select>
  );
}

/** Accessible switch: a checkbox styled as a toggle, with its label clickable. */
export function Toggle({ id, label, checked, onChange, disabled, hint }: { id: string; label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; hint?: ReactNode }) {
  return (
    <label htmlFor={id} className={cx("flex cursor-pointer items-center gap-2 text-xs select-none", disabled && "cursor-not-allowed opacity-50")}>
      <input id={id} type="checkbox" role="switch" className="peer sr-only" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span aria-hidden className="relative h-4 w-7 shrink-0 rounded-full border border-line-strong bg-sunken transition-colors peer-checked:border-accent peer-checked:bg-accent/30 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent after:absolute after:top-0.5 after:left-0.5 after:h-2.5 after:w-2.5 after:rounded-full after:bg-muted after:transition-transform peer-checked:after:translate-x-3 peer-checked:after:bg-accent-soft" />
      <span className="text-fg">{label}</span>
      {hint && <span className="text-dim">{hint}</span>}
    </label>
  );
}
