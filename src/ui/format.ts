// Date helpers. Trip dates are calendar days (YYYY-MM-DD), so they are read
// and shown in UTC to keep a day from shifting with the viewer's time zone.

const dayFormat = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const shortFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const stampFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const toUtc = (isoDate: string) => new Date(`${isoDate}T00:00:00Z`);

export function formatDay(isoDate: string): string {
  return dayFormat.format(toUtc(isoDate));
}

export function formatShortDate(isoDate: string): string {
  return shortFormat.format(toUtc(isoDate));
}

export function formatDateRange(start?: string, end?: string): string {
  if (start && end && start !== end) return `${formatShortDate(start)} to ${formatShortDate(end)}`;
  if (start) return formatShortDate(start);
  if (end) return formatShortDate(end);
  return "";
}

/** 1 for the trip's first day. Null when the date is outside the trip. */
export function tripDayNumber(isoDate: string, tripStart: string, tripEnd: string): number | null {
  if (isoDate < tripStart || isoDate > tripEnd) return null;
  return Math.round((toUtc(isoDate).getTime() - toUtc(tripStart).getTime()) / 86_400_000) + 1;
}

export function formatStamp(isoTimestamp: string): string {
  return stampFormat.format(new Date(isoTimestamp));
}

export function formatTime(hhmm: string): string {
  const [hours, minutes] = hhmm.split(":").map(Number);
  const suffix = hours >= 12 ? "pm" : "am";
  return `${hours % 12 === 0 ? 12 : hours % 12}:${String(minutes).padStart(2, "0")} ${suffix}`;
}
