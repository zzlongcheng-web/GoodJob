/** China CRM business display timezone; absolute timestamps are not changed. */
export const CRM_BUSINESS_TIME_ZONE = "Asia/Shanghai";

/** Do not reinterpret legacy date-only or timezone-less values. */
export function crmDisplayInstant(value: string): Date | null {
  const text = value.trim();
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/iu.test(text)) return null;
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? date : null;
}
export function beijingDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CRM_BUSINESS_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function formatBeijingInstant(date: Date, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("zh-CN", { hourCycle: "h23", ...options, timeZone: CRM_BUSINESS_TIME_ZONE }).format(date);
}
