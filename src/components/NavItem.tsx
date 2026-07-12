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
      className={`flex flex-col items-center gap-1 px-3 py-2 rounded-lg transition-colors text-xs font-medium
        ${
          isActive
            ? "bg-[#E9FAF3] text-[#04B488]"
            : "text-[#7C7E8C] hover:text-[#44475B] hover:bg-[#F8F8F8]"
        }
      `}
    >
      <span className="w-5 h-5">{icon}</span>
      <span className="hidden md:block">{label}</span>
    </Link>
  );
}
