import { getLocale } from "./paraglide/runtime.js";

export function intlLocale(): string {
  const ui = getLocale();
  if (typeof navigator === "undefined") {
    return ui;
  }
  const match = navigator.languages.find((tag) => {
    const lower = tag.toLowerCase();
    return lower === ui || lower.startsWith(`${ui.toLowerCase()}-`);
  });
  return match ?? ui;
}

export function formatDateTime(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleString(intlLocale());
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(intlLocale(), options).format(value);
}

export function formatCount(value: number): string {
  return formatNumber(value, { maximumFractionDigits: 0 });
}

export function formatRate(value: number): string {
  if (!Number.isFinite(value)) {
    return "—";
  }
  if (value === 0) {
    return "0";
  }
  const abs = Math.abs(value);
  if (abs >= 100) {
    return formatNumber(value, { maximumFractionDigits: 1 });
  }
  if (abs >= 1) {
    return formatNumber(value, { maximumFractionDigits: 2 });
  }
  return formatNumber(value, { maximumSignificantDigits: 3 });
}

export function formatMoney(amount: number, currency: string): string {
  try {
    return formatNumber(amount, { style: "currency", currency, maximumFractionDigits: 2 });
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export function formatRelativeTime(iso: string): string {
  const delta = Date.parse(iso) - Date.now();
  if (Number.isNaN(delta)) {
    return iso;
  }
  const rtf = new Intl.RelativeTimeFormat(intlLocale(), { numeric: "auto", style: "narrow" });
  const seconds = Math.round(delta / 1000);
  if (Math.abs(seconds) < 60) {
    return rtf.format(seconds, "second");
  }
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) {
    return rtf.format(minutes, "minute");
  }
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) {
    return rtf.format(hours, "hour");
  }
  return rtf.format(Math.round(hours / 24), "day");
}
