import { ui } from './i18n';

/** The transfer-rate parser stays locale-independent; only its UI is localized. */
export function localizedTimeRemaining(value: string | undefined): string | undefined {
  if (!value) return value;
  let match = /^~(\d+)(s|m) left$/.exec(value);
  if (match) return match[2] === 's' ? ui('time.seconds_left', { count: Number(match[1]) }) : ui('time.minutes_left', { count: Number(match[1]) });
  match = /^~(\d+)(h|d) (\d+)(m|h) left$/.exec(value);
  return match ? match[2] === 'h' ? ui('time.hours_left', { first: Number(match[1]), second: Number(match[3]) }) : ui('time.days_left', { first: Number(match[1]), second: Number(match[3]) }) : value;
}
