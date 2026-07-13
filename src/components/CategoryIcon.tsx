"use client";
import * as PhosphorIcons from "@phosphor-icons/react";
import { initialsColor, categoryInitials } from "@/lib/categoryIcons";

type Props = {
  name: string;
  slug: string;
  label: string;
  size?: number;
  className?: string;
};

export function CategoryIcon({ name, slug, label, size = 22, className = "" }: Props) {
  const Icon = name
    ? (PhosphorIcons as unknown as Record<string, React.ComponentType<{ size?: number; weight?: string; className?: string }>>)[name]
    : null;

  if (Icon) {
    return <Icon size={size} weight="regular" className={className} />;
  }

  const bg = initialsColor(slug);
  const initials = categoryInitials(label);
  const boxSize = size + 10;
  return (
    <span
      className={`inline-flex items-center justify-center rounded-lg font-bold text-white ${className}`}
      style={{ width: boxSize, height: boxSize, background: bg, fontSize: size * 0.45 }}
    >
      {initials}
    </span>
  );
}
