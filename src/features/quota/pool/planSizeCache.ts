/**
 * Plan sizes remembered per credential, so the pool is weighted correctly
 * right after a reload, before any live quota has been fetched. Plans change
 * rarely; a fresh fetch overwrites the stored value.
 */

const KEY = 'quotaPage.planSizes';

function readAll(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export function rememberedPlanSize(key: string): number | null {
  const value = readAll()[key];
  return typeof value === 'number' && value > 0 ? value : null;
}

export function rememberPlanSize(key: string, size: number) {
  try {
    const all = readAll();
    if (all[key] === size) return;
    all[key] = size;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Storage blocked: the pool falls back to equal sizes until quotas load.
  }
}
