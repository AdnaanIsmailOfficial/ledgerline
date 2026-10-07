"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Requests" },
  { href: "/policies", label: "Policies" },
] as const;

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 text-sm" aria-label="Main">
      {LINKS.map((link) => {
        const active = pathname === link.href;
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={`rounded-md px-3 py-1.5 transition-colors ${
              active ? "bg-raised text-fg" : "text-muted hover:text-fg"
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
