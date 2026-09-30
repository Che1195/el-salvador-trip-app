import {
  BUDGET_CATEGORIES,
  STATUSES,
  type BudgetCategory,
  type BudgetData,
  type BudgetTotals,
  type Status,
} from "./model";

/** Line total in cents. Inputs are validated integers, so this stays exact. */
export function lineTotalCents(line: Pick<BudgetData, "unitCents" | "quantity">): number {
  return line.unitCents * line.quantity;
}

/**
 * Totals for the budget screen. All arithmetic is on integer cents; nothing
 * is rounded until the per-traveler split, which reports its remainder.
 */
export function computeBudgetTotals(lines: readonly BudgetData[], travelers: number): BudgetTotals {
  if (!Number.isInteger(travelers) || travelers < 1) {
    throw new RangeError("travelers must be a positive integer");
  }

  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
  const byCategory = Object.fromEntries(BUDGET_CATEGORIES.map((c) => [c, 0])) as Record<
    BudgetCategory,
    number
  >;
  let paidCents = 0;
  let unpaidCommittedCents = 0;

  for (const line of lines) {
    const total = lineTotalCents(line);
    if (!Number.isSafeInteger(total) || total < 0) {
      throw new RangeError("budget line total is out of range");
    }
    byStatus[line.status] += total;
    const committed = line.status !== "considering";
    // Category totals describe the plan, so options still being considered stay out.
    if (committed) byCategory[line.category] += total;
    if (line.paid) paidCents += total;
    else if (committed) unpaidCommittedCents += total;
  }

  const committedCents = byStatus.selected + byStatus.booked;
  const perTravelerCents = Math.floor(committedCents / travelers);

  return {
    currency: "USD",
    byStatus,
    byCategory,
    committedCents,
    paidCents,
    unpaidCommittedCents,
    travelers,
    perTravelerCents,
    perTravelerRemainderCents: committedCents - perTravelerCents * travelers,
  };
}

/** "1234" cents -> "$12.34". Pure string math, no floats. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  const rest = String(abs % 100).padStart(2, "0");
  return `${sign}$${dollars}.${rest}`;
}

/** Parses "12", "12.3", "1,234.50" or "$12.34" into cents. Null when it is not a price. */
export function parseDollarsToCents(input: string): number | null {
  const cleaned = input.trim().replace(/^\$/, "").replace(/,/g, "");
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  return whole * 100 + fraction;
}
