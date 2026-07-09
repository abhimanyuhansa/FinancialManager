"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

type NavItemProps = {
  href: string;
  label: string;
  icon: React.ReactNode;
};

export function NavItem({ href, label, icon }: NavItemProps) {
  const pathname = usePathname();
  const isActive = pathname === href || pathname.startsWith(href + "/");

  return (
    <Link
      href={href}
      className={`flex flex-col items-center gap-1 px-3 py-2 rounded-xl transition-colors text-xs font-medium
        ${
          isActive
            ? "bg-[#e8ecf8] text-[#5b7cfa]"
            : "text-gray-500 hover:text-gray-700 hover:bg-gray-100"
        }
      `}
    >
      <span className="w-5 h-5">{icon}</span>
      <span className="hidden md:block">{label}</span>
    </Link>
  );
}
