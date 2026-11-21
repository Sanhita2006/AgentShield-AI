/**
 * Integer-paise monetary helpers.
 * All monetary amounts stored in SQLite (balances, transaction amounts, grant caps,
 * baseline means/stds) MUST be exact non-negative safe integers in paise (1 INR = 100 paise).
 * Rupee values are converted only at the HTTP / SDK / UI boundary.
 */

export const PAISE_PER_RUPEE = 100;

/**
 * Converts a rupee number (max 2 decimal places) to exact integer paise.
 * Handles binary floating-point artifacts like `0.1 + 0.2` (0.30000000000000004)
 * and `4999.99 * 100` (499999) while rejecting genuine sub-paisa precision (e.g. 100.123).
 */
export function tryRupeesToPaise(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  const scaled = value * PAISE_PER_RUPEE;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 1e-6) {
    return null;
  }
  if (!Number.isSafeInteger(rounded)) {
    return null;
  }
  return rounded;
}

export function rupeesToPaise(value: number): number {
  const paise = tryRupeesToPaise(value);
  if (paise === null) {
    throw new Error(`Invalid rupee amount (must be non-negative with at most 2 decimals): ${value}`);
  }
  return paise;
}

export function paiseToRupees(paise: number): number {
  if (!Number.isFinite(paise)) return 0;
  return Math.round(paise) / PAISE_PER_RUPEE;
}

export function formatInrFromPaise(paise: number, options?: { alwaysShowDecimals?: boolean }): string {
  const rupees = paiseToRupees(paise);
  const hasPaise = Math.round(paise) % 100 !== 0;
  const minFrac = options?.alwaysShowDecimals || hasPaise ? 2 : 0;
  return `₹${rupees.toLocaleString('en-IN', {
    minimumFractionDigits: minFrac,
    maximumFractionDigits: 2,
  })}`;
}
