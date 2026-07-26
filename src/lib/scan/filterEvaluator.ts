export const SUPPORTED_RULE_SCHEMA_VERSION = 1;
export const SUPPORTED_FILTER_EVALUATOR_VERSION = 1;

export type EmailFilterRule = {
  rule_id: string;
  type: "sender_domain" | "sender_email" | "subject_keyword";
  pattern: string;
};

export type FilterSnapshot = {
  includeRules: EmailFilterRule[];
  excludeRules: EmailFilterRule[];
};

export class InvalidFilterSchemaError extends Error {
  constructor(message = "Invalid email filter schema") {
    super(message);
    this.name = "InvalidFilterSchemaError";
  }
}

function parseRule(value: unknown): EmailFilterRule {
  if (!value || typeof value !== "object") {
    throw new InvalidFilterSchemaError();
  }
  const rule = value as Record<string, unknown>;
  if (
    typeof rule.rule_id !== "string" ||
    !rule.rule_id ||
    typeof rule.type !== "string" ||
    typeof rule.pattern !== "string" ||
    !rule.pattern
  ) {
    throw new InvalidFilterSchemaError();
  }
  if (!["sender_domain", "sender_email", "subject_keyword"].includes(rule.type)) {
    throw new InvalidFilterSchemaError("Unsupported email filter rule type");
  }
  return rule as EmailFilterRule;
}

export function validateFilterRules(
  includeRules: unknown,
  excludeRules: unknown,
): FilterSnapshot {
  if (!Array.isArray(includeRules) || !Array.isArray(excludeRules)) {
    throw new InvalidFilterSchemaError();
  }
  const parsed = [...includeRules, ...excludeRules].map(parseRule);
  const ids = parsed.map((rule) => rule.rule_id);
  if (new Set(ids).size !== ids.length) {
    throw new InvalidFilterSchemaError("Duplicate email filter rule id");
  }
  return {
    includeRules: includeRules.map(parseRule),
    excludeRules: excludeRules.map(parseRule),
  };
}

function ruleMatches(
  rule: EmailFilterRule,
  email: { senderDomain: string; senderEmail: string; subject: string },
): boolean {
  const pattern = rule.pattern.toLowerCase();
  if (rule.type === "sender_domain") {
    return email.senderDomain.toLowerCase() === pattern;
  }
  if (rule.type === "sender_email") {
    return email.senderEmail.toLowerCase() === pattern;
  }
  return email.subject.toLowerCase().includes(pattern);
}

export function evaluateFilter(
  snapshot: FilterSnapshot,
  email: { senderDomain: string; senderEmail: string; subject: string },
) {
  const matchedExcludeRuleIds = snapshot.excludeRules
    .filter((rule) => ruleMatches(rule, email))
    .map((rule) => rule.rule_id);
  const matchedIncludeRuleIds = snapshot.includeRules
    .filter((rule) => ruleMatches(rule, email))
    .map((rule) => rule.rule_id);

  const decision =
    matchedExcludeRuleIds.length > 0
      ? "EXCLUDED"
      : snapshot.includeRules.length === 0 || matchedIncludeRuleIds.length > 0
        ? "INCLUDED"
        : "EXCLUDED";

  return { decision, matchedIncludeRuleIds, matchedExcludeRuleIds } as const;
}
