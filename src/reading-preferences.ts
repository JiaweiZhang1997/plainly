export interface ReadingAppearance { fontSize: number; cardWidth: number; cardMaxHeight: number; }
export const APPEARANCE_DEFAULTS: ReadingAppearance = { fontSize: 12, cardWidth: 350, cardMaxHeight: 580 };
export const APPEARANCE_LIMITS = { fontSize: [6, 24], cardWidth: [200, 800], cardMaxHeight: [180, 1000] } as const;
export function boundedInteger(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.max(min, Math.min(max, value))) : fallback;
}
export function normalizeAppearance(raw?: Partial<ReadingAppearance>): ReadingAppearance {
  return Object.fromEntries(Object.entries(APPEARANCE_DEFAULTS).map(([key, fallback]) => {
    const field = key as keyof ReadingAppearance, [min, max] = APPEARANCE_LIMITS[field];
    return [field, boundedInteger(raw?.[field], fallback, min, max)];
  })) as unknown as ReadingAppearance;
}

// Give smaller values the left half of the track without reducing the existing upper limits.
export function appearanceToSlider(field: keyof ReadingAppearance, value: number) {
  const [min, max] = APPEARANCE_LIMITS[field], middle = APPEARANCE_DEFAULTS[field];
  const bounded = boundedInteger(value, middle, min, max);
  return bounded <= middle ? (bounded - min) / (middle - min) * 500 : 500 + (bounded - middle) / (max - middle) * 500;
}
export function appearanceFromSlider(field: keyof ReadingAppearance, position: number) {
  const [min, max] = APPEARANCE_LIMITS[field], middle = APPEARANCE_DEFAULTS[field];
  const p = Number.isFinite(position) ? Math.max(0, Math.min(1000, position)) : 500;
  return Math.round(p <= 500 ? min + p / 500 * (middle - min) : middle + (p - 500) / 500 * (max - middle));
}
