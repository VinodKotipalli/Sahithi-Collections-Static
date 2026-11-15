const inrWholeFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

const inrDecimalFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatINR(amount: number): string {
  return Number.isInteger(amount) ? inrWholeFormatter.format(amount) : inrDecimalFormatter.format(amount);
}

export function formatPaiseINR(paise: number): string {
  const rupees = paise / 100;
  return paise % 100 === 0 ? inrWholeFormatter.format(rupees) : inrDecimalFormatter.format(rupees);
}

export function formatTimestamp(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(ms));
}
