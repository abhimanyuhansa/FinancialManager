import {
  evaluateFilter,
  InvalidFilterSchemaError,
  validateFilterRules,
} from "@/lib/scan/filterEvaluator";

describe("Phase 1A email filter evaluator", () => {
  it("gives exclusion rules precedence over inclusion rules", () => {
    const snapshot = validateFilterRules(
      [
        {
          rule_id: "include-bank",
          type: "sender_domain",
          pattern: "bank.example",
        },
      ],
      [
        {
          rule_id: "exclude-marketing",
          type: "subject_keyword",
          pattern: "offer",
        },
      ],
    );

    expect(
      evaluateFilter(snapshot, {
        senderDomain: "BANK.EXAMPLE",
        senderEmail: "alerts@bank.example",
        subject: "Limited Offer",
      }),
    ).toEqual({
      decision: "EXCLUDED",
      matchedIncludeRuleIds: ["include-bank"],
      matchedExcludeRuleIds: ["exclude-marketing"],
    });
  });

  it("includes all messages when no include rules are configured", () => {
    const snapshot = validateFilterRules([], []);
    expect(
      evaluateFilter(snapshot, {
        senderDomain: "merchant.example",
        senderEmail: "receipt@merchant.example",
        subject: "Receipt",
      }).decision,
    ).toBe("INCLUDED");
  });

  it("rejects duplicate ids and unsupported rule types", () => {
    expect(() =>
      validateFilterRules(
        [{ rule_id: "same", type: "sender_domain", pattern: "a.example" }],
        [{ rule_id: "same", type: "sender_email", pattern: "b@example" }],
      ),
    ).toThrow(InvalidFilterSchemaError);
    expect(() =>
      validateFilterRules(
        [{ rule_id: "regex", type: "regex", pattern: ".*" }],
        [],
      ),
    ).toThrow("Unsupported email filter rule type");
  });
});
