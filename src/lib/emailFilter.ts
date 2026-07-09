type Filter = {
  type: string;
  value: string;
  sourceRank: number;
  isActive: boolean;
};

type EmailMeta = {
  from: string;
  subject: string;
};

export type MatchResult = { matched: true; sourceRank: number } | { matched: false };

export function matchesEmailFilter(email: EmailMeta, filters: Filter[]): MatchResult {
  const activeFilters = filters.filter((f) => f.isActive);
  let bestRank: number | null = null;

  for (const filter of activeFilters) {
    let hit = false;

    if (filter.type === "sender_domain") {
      const domain = email.from.split("@")[1]?.toLowerCase() ?? "";
      hit = domain === filter.value.toLowerCase();
    } else if (filter.type === "sender_email") {
      hit = email.from.toLowerCase() === filter.value.toLowerCase();
    } else if (filter.type === "subject_keyword") {
      hit = email.subject.toLowerCase().includes(filter.value.toLowerCase());
    }

    if (hit) {
      if (bestRank === null || filter.sourceRank < bestRank) {
        bestRank = filter.sourceRank;
      }
    }
  }

  if (bestRank !== null) return { matched: true, sourceRank: bestRank };
  return { matched: false };
}
