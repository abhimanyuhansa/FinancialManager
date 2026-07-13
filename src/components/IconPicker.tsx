"use client";
import * as PhosphorIcons from "@phosphor-icons/react";
import { ICON_GROUPS } from "@/lib/categoryIcons";

type Props = {
  selected: string;
  onSelect: (iconName: string) => void;
};

export function IconPicker({ selected, onSelect }: Props) {
  return (
    <div className="max-h-64 overflow-y-auto pr-1">
      {ICON_GROUPS.map((group) => (
        <div key={group.label} className="mb-3">
          <p className="text-[10px] font-semibold text-[#A1A3AD] uppercase tracking-wide mb-1.5">
            {group.label}
          </p>
          <div className="grid grid-cols-8 gap-1">
            {group.icons.map(({ name, label }) => {
              const Icon = (PhosphorIcons as unknown as Record<string, React.ComponentType<{ size?: number; weight?: string }>>)[name];
              if (!Icon) return null;
              const isSelected = selected === name;
              return (
                <button
                  key={name}
                  type="button"
                  title={label}
                  onClick={() => onSelect(name)}
                  className={`flex flex-col items-center gap-0.5 p-1.5 rounded-lg transition-colors ${
                    isSelected
                      ? "bg-[#E9FAF3] text-[#04B488]"
                      : "hover:bg-[#F8F8F8] text-[#7C7E8C]"
                  }`}
                >
                  <Icon size={18} weight={isSelected ? "fill" : "regular"} />
                  <span className="text-[9px] leading-none truncate w-full text-center">{label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
