"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { HealthStrip } from "./health";
import { cx } from "./ui/primitives";

const LINKS = [
  { href: "/", label: "Console", match: (p: string) => p === "/" || (p.startsWith("/runs/") && p.length > 6) },
  { href: "/runs", label: "Runs", match: (p: string) => p === "/runs" },
  { href: "/benchmarks", label: "Benchmarks", match: (p: string) => p.startsWith("/benchmarks") },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/95 backdrop-blur">
      <div className="flex h-11 items-center gap-4 px-4">
        <Link href="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight text-fg">
          <Logo />
          Overclock
        </Link>
        <nav aria-label="Primary" className="flex items-center gap-0.5">
          {LINKS.map((l) => {
            const active = l.match(pathname);
            return (
              <Link key={l.href} href={l.href} aria-current={active ? "page" : undefined} className={cx("rounded px-2 py-1 text-[13px] transition-colors", active ? "bg-raised text-fg" : "text-muted hover:text-fg")}>
                {l.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto hidden sm:block">
          <HealthStrip />
        </div>
      </div>
      <div className="border-t border-line px-4 py-1.5 sm:hidden">
        <HealthStrip />
      </div>
    </header>
  );
}

function Logo() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <rect x="1" y="1" width="16" height="16" rx="4" fill="none" stroke="#3d8bff" strokeWidth="1.5" />
      <path d="M5 11.5 8 6.5l2.5 3.5L13 6" fill="none" stroke="#2fd27a" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
