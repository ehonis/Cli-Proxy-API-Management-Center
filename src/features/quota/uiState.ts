import {
  QUOTA_SORT_MODES,
  QUOTA_TAB_ORDER,
  type QuotaSortMode,
  type QuotaTabId,
} from './constants';

/** 额度页 UI 偏好：会话级持久化（sessionStorage），跨会话不携带。 */
export type QuotaViewMode = 'ledger' | 'cards';

export type QuotaPoolUiState = {
  mode?: 'remaining' | 'rate';
  window?: 'weekly' | 'five-hour' | 'combined';
  providers?: 'separate' | 'combined';
  burnWindow?: 1 | 3 | 6;
  future?: 'same' | 'double' | 'half' | 'none';
  showAccounts?: boolean;
};

export type QuotaUiState = {
  tab?: QuotaTabId;
  sortMode?: QuotaSortMode;
  viewMode?: QuotaViewMode;
  showEmails?: boolean;
  pool?: QuotaPoolUiState;
  collapsed?: string[];
};

const readPoolState = (raw: unknown): QuotaPoolUiState | undefined => {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  return {
    mode: value.mode === 'rate' || value.mode === 'remaining' ? value.mode : undefined,
    window:
      value.window === 'weekly' || value.window === 'five-hour' || value.window === 'combined'
        ? value.window
        : undefined,
    providers:
      value.providers === 'separate' || value.providers === 'combined'
        ? value.providers
        : undefined,
    burnWindow:
      value.burnWindow === 1 || value.burnWindow === 3 || value.burnWindow === 6
        ? value.burnWindow
        : undefined,
    future:
      value.future === 'same' ||
      value.future === 'double' ||
      value.future === 'half' ||
      value.future === 'none'
        ? value.future
        : undefined,
    showAccounts: typeof value.showAccounts === 'boolean' ? value.showAccounts : undefined,
  };
};

const QUOTA_UI_STATE_KEY = 'quotaPage.uiState';

const QUOTA_TAB_ID_SET = new Set<string>(['all', ...QUOTA_TAB_ORDER]);
const QUOTA_SORT_MODE_SET = new Set<string>(QUOTA_SORT_MODES);

export const isQuotaTabId = (value: unknown): value is QuotaTabId =>
  typeof value === 'string' && QUOTA_TAB_ID_SET.has(value);

export const isQuotaSortMode = (value: unknown): value is QuotaSortMode =>
  typeof value === 'string' && QUOTA_SORT_MODE_SET.has(value);

export const readQuotaUiState = (): QuotaUiState | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(QUOTA_UI_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as QuotaUiState;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      tab: isQuotaTabId(parsed.tab) ? parsed.tab : undefined,
      sortMode: isQuotaSortMode(parsed.sortMode) ? parsed.sortMode : undefined,
      viewMode:
        parsed.viewMode === 'ledger' || parsed.viewMode === 'cards' ? parsed.viewMode : undefined,
      showEmails: typeof parsed.showEmails === 'boolean' ? parsed.showEmails : undefined,
      pool: readPoolState(parsed.pool),
      collapsed: Array.isArray(parsed.collapsed)
        ? parsed.collapsed.filter((item): item is string => typeof item === 'string')
        : undefined,
    };
  } catch {
    return null;
  }
};

/**
 * Merge into whatever is already stored.
 *
 * Callers write one preference at a time — the tab strip knows nothing about
 * the sort control — so a whole-object write would silently drop the other
 * field every time either one changed.
 */
export const writeQuotaUiState = (state: QuotaUiState) => {
  if (typeof window === 'undefined') return;
  try {
    const next = { ...readQuotaUiState(), ...state };
    window.sessionStorage.setItem(QUOTA_UI_STATE_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
};
