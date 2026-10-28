export interface Clock {
  now(): Date;
}

export function businessDate(date: Date): string {
  return new Date(date.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

export function daysBetween(from: Date, to: Date): number {
  return (Date.parse(businessDate(to)) - Date.parse(businessDate(from))) / 86_400_000;
}
