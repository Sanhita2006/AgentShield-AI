/**
 * Timezone-aware clock helpers.
 * Never rely on the host server's local timezone (often UTC in containers/cloud VMs)
 * when evaluating customer behavioral hours such as 3:00 AM IST.
 */

export const DEFAULT_CUSTOMER_TIMEZONE = 'Asia/Kolkata';

export function getHourInTimezone(timestampMs: number, timeZone: string = DEFAULT_CUSTOMER_TIMEZONE): number {
  const tz = timeZone && timeZone.trim() ? timeZone.trim() : DEFAULT_CUSTOMER_TIMEZONE;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(new Date(timestampMs));
    const hourRaw = Number(parts.find((p) => p.type === 'hour')?.value);
    if (Number.isInteger(hourRaw)) {
      return hourRaw % 24;
    }
  } catch {
    // Unknown/invalid IANA timezone falls back to Asia/Kolkata below
  }

  const fallbackParts = new Intl.DateTimeFormat('en-US', {
    timeZone: DEFAULT_CUSTOMER_TIMEZONE,
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestampMs));
  const fallbackHour = Number(fallbackParts.find((p) => p.type === 'hour')?.value ?? new Date(timestampMs).getUTCHours());
  return fallbackHour % 24;
}

export function formatHour12(hour: number): string {
  const h = ((Math.trunc(hour) % 24) + 24) % 24;
  const display = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${display}:00 ${h >= 12 ? 'PM' : 'AM'}`;
}
