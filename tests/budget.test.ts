import { describe, expect, it } from "vitest";
import { computeBudgetTotals, formatCents, lineTotalCents, parseDollarsToCents } from "@/domain/budget";
import type { BudgetData } from "@/domain/model";

const line = (overrides: Partial<BudgetData>): BudgetData => ({
  label: "Line",
  category: "other",
  unitCents: 0,
  quantity: 1,
  status: "selected",
  paid: false,
  ...overrides,
});

describe("budget math", () => {
  it("multiplies unit price by quantity in whole cents", () => {
    expect(lineTotalCents({ unitCents: 1999, quantity: 3 })).toBe(5997);
  });

  it("adds totals by status, category, paid state and traveler", () => {
    const totals = computeBudgetTotals(
      [
        line({ category: "transport", unitCents: 41250, quantity: 2, status: "booked", paid: true }),
        line({ category: "lodging", unitCents: 9800, quantity: 4, status: "booked" }),
        line({ category: "activities", unitCents: 4500, quantity: 2, status: "selected" }),
        line({ category: "transport", unitCents: 5575, quantity: 3, status: "considering" }),
      ],
      2,
    );
    expect(totals.byStatus).toEqual({ considering: 16725, selected: 9000, booked: 121700 });
    expect(totals.committedCents).toBe(130700);
    expect(totals.paidCents).toBe(82500);
    expect(totals.unpaidCommittedCents).toBe(48200);
    // Options still being considered are not part of the plan's category totals.
    expect(totals.byCategory).toEqual({ lodging: 39200, transport: 82500, food: 0, activities: 9000, other: 0 });
    expect(totals.perTravelerCents).toBe(65350);
    expect(totals.perTravelerRemainderCents).toBe(0);
  });

  it("stays exact where floating point would drift", () => {
    // 0.1 + 0.2 style amounts: ten cents and twenty cents, many times over.
    const lines = Array.from({ length: 1000 }, (_, i) => line({ unitCents: i % 2 ? 10 : 20 }));
    expect(computeBudgetTotals(lines, 1).committedCents).toBe(15000);
  });

  it("reports the cents left over by an uneven split", () => {
    const totals = computeBudgetTotals([line({ unitCents: 10000 })], 3);
    expect(totals.perTravelerCents).toBe(3333);
    expect(totals.perTravelerRemainderCents).toBe(1);
    expect(totals.perTravelerCents * 3 + totals.perTravelerRemainderCents).toBe(totals.committedCents);
  });

  it("returns zeros for an empty budget", () => {
    const totals = computeBudgetTotals([], 2);
    expect(totals.committedCents).toBe(0);
    expect(totals.perTravelerCents).toBe(0);
  });

  it("refuses a traveler count it cannot divide by", () => {
    expect(() => computeBudgetTotals([], 0)).toThrow(RangeError);
    expect(() => computeBudgetTotals([], 1.5)).toThrow(RangeError);
  });

  it("formats and parses money without floats", () => {
    expect(formatCents(123456)).toBe("$1,234.56");
    expect(formatCents(5)).toBe("$0.05");
    expect(parseDollarsToCents("1,234.5")).toBe(123450);
    expect(parseDollarsToCents("$19.99")).toBe(1999);
    expect(parseDollarsToCents("0.07")).toBe(7);
    expect(parseDollarsToCents("12.345")).toBeNull();
    expect(parseDollarsToCents("-3")).toBeNull();
    expect(parseDollarsToCents("abc")).toBeNull();
  });
});
