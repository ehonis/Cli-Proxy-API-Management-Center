/**
 * Pool chart: one provider's pooled remaining quota over the visible range.
 * Solid = recorded by the server, dashed = projected at the chosen burn rate,
 * with every reset jump labelled by how much it adds back, and a dashed marker
 * wherever a limit is projected to run out or the weekly limit refills.
 *
 * Layout only; all numbers come from poolModel.ts.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DAY_MS,
  HOUR_MS,
  idleSpans,
  type PoolModel,
  type PoolLimitEvent,
  type PoolLimitEventKind,
  type IdleSchedule,
  type SeriesPoint,
} from './poolModel';
import {
  bandOpacity,
  EVENT_LONG_KEY,
  EVENT_SHORT_KEY,
  formatPercent,
  formatRate,
  formatStamp,
} from './poolFormat';
import styles from './PoolChart.module.scss';

export type PoolChartMode = 'remaining' | 'rate';

export interface PoolChartProps {
  model: PoolModel;
  mode: PoolChartMode;
  startMs: number;
  endMs: number;
  now: number;
  showAccounts: boolean;
  /** Hour columns instead of day columns, for the 5-hour view. */
  hourly?: boolean;
  /** Nightly block with no projected usage, shaded from now onward. */
  idle?: IdleSchedule;
  /** Accessible name, e.g. "Claude pool". */
  label: string;
  /** Smallest refill worth a label, in pool percent. */
  minResetLabel?: number;
  /** Which projected limit events get a marker. */
  eventKinds?: readonly PoolLimitEventKind[];
}

const HEIGHT = 380;
const M = { top: 44, right: 14, bottom: 46, left: 56 };
const LABEL_W = 44;
const LABEL_H = 16;
/** Baselines of the two marker label rows above the plot. */
const EVENT_ROWS = [M.top - 24, M.top - 7];
/** How close the crosshair has to be for the tooltip to list a marker. */
const EVENT_HOVER_PX = 8;
const EVENT_CHAR_W = 6.8;

type Box = { x0: number; x1: number; y0: number; y1: number };
const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

function niceCeil(value: number) {
  if (value <= 1) return 1;
  const exp = 10 ** Math.floor(Math.log10(value));
  // Steps whose half is still a round tick label.
  for (const step of [1, 2, 4, 5, 10]) {
    if (step * exp >= value) return step * exp;
  }
  return 10 * exp;
}

/** Lookup on a sorted series; the later point wins on equal timestamps. */
function valueAt(series: SeriesPoint[], t: number): number | null {
  if (series.length === 0 || t < series[0].t || t > series[series.length - 1].t) return null;
  let lo = 0;
  let hi = series.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (series[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = series[lo];
  const b = series[hi];
  if (b.t === a.t || t === a.t) return a.v;
  return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
}

function indexAt(series: SeriesPoint[], t: number) {
  let best = 0;
  for (let i = 0; i < series.length; i += 1) {
    if (series[i].t <= t) best = i;
    else break;
  }
  return best;
}

export function PoolChart({
  model,
  mode,
  startMs,
  endMs,
  now,
  showAccounts,
  hourly = false,
  idle,
  label,
  minResetLabel = 0,
  eventKinds = [],
}: PoolChartProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const gradientId = useId();
  const clipId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(960);
  const [hoverT, setHoverT] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setWidth(Math.max(320, Math.round(el.clientWidth)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const plotW = width - M.left - M.right;
  const plotH = HEIGHT - M.top - M.bottom;
  const span = endMs - startMs;
  const x = (ms: number) => M.left + ((ms - startMs) / span) * plotW;
  const tAt = (px: number) => startMs + ((px - M.left) / plotW) * span;

  const rateMode = mode === 'rate';
  const recorded = rateMode ? model.recordedRate : model.recorded;
  const projected = rateMode ? model.projectedRate : model.projected;

  const yMax = useMemo(() => {
    if (!rateMode) return Math.max(100, model.capacity);
    const peak = Math.max(
      0,
      ...model.recordedRate.map((p) => p.v),
      ...model.projectedRate.map((p) => p.v)
    );
    return niceCeil(peak * 1.25 || 1);
  }, [rateMode, model]);
  const y = (v: number) => M.top + (1 - Math.max(0, Math.min(v, yMax)) / yMax) * plotH;

  const visible = (series: SeriesPoint[]) => {
    const pad = (span / plotW) * 4;
    return series.filter((p) => p.t >= startMs - pad && p.t <= endMs + pad);
  };
  const line = (series: SeriesPoint[]) =>
    series
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`)
      .join('');
  const area = (series: SeriesPoint[]) =>
    series.length < 2
      ? ''
      : `${line(series)}L${x(series[series.length - 1].t).toFixed(1)},${y(0)}L${x(series[0].t).toFixed(1)},${y(0)}Z`;

  const recordedVisible = visible(recorded);
  const projectedVisible = visible(projected);

  /* ---------- per-account stacked bands ---------- */

  const bands = useMemo(() => {
    if (!showAccounts || rateMode) return [];
    const keys = model.accounts.map((a) => a.key);
    const build = (times: SeriesPoint[], byAccount: Record<string, number[]>) => {
      const lower = times.map(() => 0);
      return keys.map((key) => {
        const values = byAccount[key] ?? [];
        const top = times.map((_, i) => lower[i] + (values[i] ?? 0));
        const band = times.map((p, i) => ({ t: p.t, lo: lower[i], hi: top[i] }));
        for (let i = 0; i < lower.length; i += 1) lower[i] = top[i];
        return band;
      });
    };
    const rec = build(model.recorded, model.recordedByAccount);
    const proj = build(model.projected, model.projectedByAccount);
    return keys.map((key, index) => ({ key, recorded: rec[index], projected: proj[index] }));
  }, [showAccounts, rateMode, model]);

  const bandPath = (band: { t: number; lo: number; hi: number }[]) => {
    const pad = (span / plotW) * 4;
    const pts = band.filter((p) => p.t >= startMs - pad && p.t <= endMs + pad);
    if (pts.length < 2) return '';
    const top = pts.map(
      (p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.hi).toFixed(1)}`
    );
    const bottom = [...pts].reverse().map((p) => `L${x(p.t).toFixed(1)},${y(p.lo).toFixed(1)}`);
    return `${top.join('')}${bottom.join('')}Z`;
  };

  /* ---------- reset labels ---------- */

  const resetLabels = useMemo(() => {
    if (rateMode) return [];
    const placed: Box[] = [];
    const out: {
      key: string;
      x: number;
      y: number;
      text: string;
      projected: boolean;
      title: string;
    }[] = [];
    for (const reset of model.resets) {
      if (reset.t < startMs || reset.t > endMs || reset.delta < minResetLabel) continue;
      const series = reset.projected ? model.projected : model.recorded;
      const v = valueAt(series, reset.t + 1) ?? valueAt(series, reset.t);
      if (v === null) continue;
      const cx = x(reset.t);
      const lineY = y(v);
      // The Now label and dot own the space around the present moment.
      if (now >= startMs && now <= endMs && Math.abs(cx - x(now)) < LABEL_W / 2 + 4) {
        continue;
      }
      // On a narrow chart only the bigger refills earn a label.
      if (plotW < 400 && reset.delta < 20) continue;
      // Above the line first, then tucked under it, then further up.
      const candidates = [lineY - 12, lineY + 20, lineY - 30, lineY + 38];
      let chosen: number | null = null;
      for (const cy of candidates) {
        const box = { x0: cx - LABEL_W / 2, x1: cx + LABEL_W / 2, y0: cy - LABEL_H, y1: cy + 2 };
        if (cy - LABEL_H < 6 || cy > M.top + plotH - 4) continue;
        if (placed.some((other) => overlaps(box, other))) continue;
        placed.push(box);
        chosen = cy;
        break;
      }
      if (chosen === null) continue;
      out.push({
        key: `${reset.t}-${reset.projected ? 'p' : 'r'}`,
        x: cx,
        y: chosen,
        text: `+${Math.round(reset.delta)}%`,
        projected: reset.projected,
        title: `${formatStamp(reset.t, locale)} · ${reset.labels.join(', ')}`,
      });
    }
    return out;
    // x/y depend on width and yMax, both captured via plotW/yMax.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rateMode, model, startMs, endMs, plotW, yMax, locale, now, minResetLabel]);

  /* ---------- limit markers ---------- */

  const markers = useMemo(() => {
    const placed: Box[] = [];
    if (now >= startMs && now <= endMs) {
      // The Now label sits in the top row.
      placed.push({
        x0: x(now) - 20,
        x1: x(now) + 20,
        y0: EVENT_ROWS[0] - 14,
        y1: EVENT_ROWS[0] + 3,
      });
    }
    // Weekly run-outs claim label space first; 5-hour ones repeat and give way.
    const priority: Record<PoolLimitEventKind, number> = {
      'weekly-out': 0,
      'weekly-reset': 1,
      'five-out': 2,
    };
    const events = model.limitEvents
      .filter((e) => eventKinds.includes(e.kind) && e.t > now && e.t >= startMs && e.t <= endMs)
      .sort((a, b) => priority[a.kind] - priority[b.kind] || a.t - b.t);
    const out = events.map((event: PoolLimitEvent) => {
      const cx = x(event.t);
      const text = t(EVENT_SHORT_KEY[event.kind]);
      const half = (text.length * EVENT_CHAR_W) / 2 + 4;
      let labelY: number | null = null;
      for (const row of EVENT_ROWS) {
        const box = { x0: cx - half, x1: cx + half, y0: row - 14, y1: row + 3 };
        if (box.x0 < 2 || box.x1 > width - 2) continue;
        if (placed.some((other) => overlaps(box, other))) continue;
        placed.push(box);
        labelY = row;
        break;
      }
      return { key: `${event.kind}-${event.t}`, event, cx, text, labelY };
    });
    return out.sort((a, b) => a.event.t - b.event.t);
    // x depends on width via plotW.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, eventKinds, startMs, endMs, now, plotW, width, t]);

  /* ---------- axes ---------- */

  const days = useMemo(() => {
    const out: {
      t: number;
      end: number;
      weekday: string;
      day: string;
      weekend: boolean;
      today: boolean;
    }[] = [];
    if (hourly) {
      // Three-hour columns, wider on a narrow chart; midnight carries the date.
      const stepHours = plotW / ((endMs - startMs) / HOUR_MS) < 14 ? 6 : 3;
      const d = new Date(startMs);
      d.setMinutes(0, 0, 0);
      d.setHours(Math.ceil(d.getHours() / stepHours) * stepHours);
      while (d.getTime() < endMs) {
        const colStart = d.getTime();
        const next = new Date(d);
        next.setHours(next.getHours() + stepHours);
        const midnight = d.getHours() === 0;
        out.push({
          t: colStart,
          end: Math.min(next.getTime(), endMs),
          weekday: d.toLocaleTimeString(locale, { hour: 'numeric' }),
          day: midnight ? d.toLocaleDateString(locale, { weekday: 'short', day: 'numeric' }) : '',
          weekend: false,
          today: now >= colStart && now < next.getTime(),
        });
        d.setTime(next.getTime());
      }
      return out;
    }
    const todayStart = new Date(now).setHours(0, 0, 0, 0);
    // Step by calendar day, not 24h: a DST change makes one day 23 or 25 hours.
    const d = new Date(startMs);
    d.setHours(0, 0, 0, 0);
    while (d.getTime() < endMs) {
      const dayStart = d.getTime();
      const next = new Date(d);
      next.setDate(next.getDate() + 1);
      out.push({
        t: dayStart,
        end: Math.min(next.getTime(), endMs),
        weekday: d.toLocaleDateString(locale, { weekday: 'short' }),
        day: String(d.getDate()),
        weekend: d.getDay() === 0 || d.getDay() === 6,
        today: dayStart === todayStart,
      });
      d.setDate(d.getDate() + 1);
    }
    return out;
  }, [startMs, endMs, now, locale, hourly, plotW]);

  // Thin the day labels when days get narrow; today always keeps its label.
  const pxPerDay = plotW / Math.max(1, days.length);
  const labelEvery = hourly ? (pxPerDay < 34 ? 2 : 1) : pxPerDay < 18 ? 3 : pxPerDay < 34 ? 2 : 1;
  const anchor = Math.max(
    0,
    days.findIndex((day) => day.today)
  );
  const showDayLabel = (index: number) =>
    Math.abs(index - anchor) % labelEvery === 0 || (hourly && days[index].day !== '');

  const yTicks = [0, yMax / 2, yMax];
  const tickLabel = (v: number) =>
    rateMode ? (Number.isInteger(v) ? `${v}%/h` : formatRate(v)) : formatPercent(v);

  const nowVisible = now >= startMs && now <= endMs;
  const nowValue = rateMode ? (model.burnPerHour ?? 0) : (model.current ?? 0);

  /* ---------- hover / keyboard crosshair ---------- */

  const hover = useMemo(() => {
    if (hoverT === null) return null;
    const isProjected = hoverT > now;
    const series = isProjected ? projected : recorded;
    const v = valueAt(series, hoverT);
    if (v === null) return null;
    let accounts: { label: string; v: number }[] = [];
    if (!rateMode && showAccounts) {
      const base = isProjected ? model.projected : model.recorded;
      const byAccount = isProjected ? model.projectedByAccount : model.recordedByAccount;
      const idx = indexAt(base, hoverT);
      // Each account's own level, not its weighted share of the pool.
      accounts = model.accounts.map((a) => ({
        label: a.label,
        v: ((byAccount[a.key]?.[idx] ?? 0) * 100) / a.share,
      }));
    }
    const nearPx = (EVENT_HOVER_PX * span) / plotW;
    const events = markers.map((m) => m.event).filter((e) => Math.abs(e.t - hoverT) <= nearPx);
    return { t: hoverT, v, isProjected, accounts, events };
  }, [hoverT, now, projected, recorded, rateMode, showAccounts, model, markers, span, plotW]);

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * width;
    if (px < M.left || px > M.left + plotW) {
      setHoverT(null);
      return;
    }
    setHoverT(tAt(px));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = hourly
      ? event.shiftKey
        ? HOUR_MS
        : 15 * 60_000
      : event.shiftKey
        ? DAY_MS
        : HOUR_MS;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      setHoverT((prev) => {
        const base = prev ?? now;
        const next = base + (event.key === 'ArrowLeft' ? -step : step);
        return Math.max(startMs, Math.min(endMs, next));
      });
    } else if (event.key === 'Home') {
      event.preventDefault();
      setHoverT(now);
    } else if (event.key === 'Escape') {
      setHoverT(null);
    }
  };

  const tooltipLeft = hover ? Math.min(Math.max(x(hover.t), M.left + 90), width - 100) : 0;
  const hasData = recordedVisible.length > 1 || projectedVisible.length > 1;

  return (
    <div
      ref={wrapRef}
      className={styles.wrap}
      tabIndex={0}
      role="group"
      aria-label={t('quota_management.pool_chart_label', { name: label })}
      onKeyDown={onKeyDown}
      onBlur={() => setHoverT(null)}
    >
      <svg
        className={styles.svg}
        width={width}
        height={HEIGHT}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHoverT(null)}
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--pool-accent)" stopOpacity="0.28" />
            <stop offset="78%" stopColor="var(--pool-accent)" stopOpacity="0.02" />
          </linearGradient>
          <clipPath id={clipId}>
            <rect x={M.left} y={0} width={plotW} height={M.top + plotH} />
          </clipPath>
        </defs>

        {/* quiet hours and off days: only the projection assumes them, so shade the future */}
        {idleSpans(Math.max(startMs, now), endMs, idle ?? {}).map((span) => (
          <rect
            key={`q${span.startMs}`}
            className={styles.quietBand}
            x={x(span.startMs)}
            y={M.top}
            width={Math.max(0, x(span.endMs) - x(span.startMs))}
            height={plotH}
          />
        ))}

        {/* day columns + horizontal guides */}
        {days.map((day) => (
          <line
            key={`g${day.t}`}
            className={styles.dayLine}
            x1={x(day.t)}
            x2={x(day.t)}
            y1={M.top}
            y2={M.top + plotH}
          />
        ))}
        {yTicks.map((v) => (
          <g key={`y${v}`}>
            <line
              className={v === 0 ? styles.baseLine : styles.gridLine}
              x1={M.left}
              x2={M.left + plotW}
              y1={y(v)}
              y2={y(v)}
            />
            <text className={styles.yLabel} x={M.left - 10} y={y(v) + 4} textAnchor="end">
              {tickLabel(v)}
            </text>
          </g>
        ))}

        <g clipPath={`url(#${clipId})`}>
          {bands.length > 0 ? (
            bands.map((band, index) => (
              <g key={band.key} style={{ opacity: bandOpacity(index, bands.length) }}>
                <path className={styles.band} d={bandPath(band.recorded)} />
                <path
                  className={`${styles.band} ${styles.bandProjected}`}
                  d={bandPath(band.projected)}
                />
              </g>
            ))
          ) : (
            <>
              {recordedVisible.length > 1 && (
                <path d={area(recordedVisible)} fill={`url(#${gradientId})`} />
              )}
              {projectedVisible.length > 1 && (
                <path
                  d={area(projectedVisible)}
                  fill={`url(#${gradientId})`}
                  className={styles.projectedArea}
                />
              )}
            </>
          )}
          {recordedVisible.length > 1 && (
            <path className={styles.recordedLine} d={line(recordedVisible)} />
          )}
          {projectedVisible.length > 1 && (
            <path className={styles.projectedLine} d={line(projectedVisible)} />
          )}
        </g>

        {markers.map((marker) => (
          <g key={marker.key} className={styles[`event-${marker.event.kind}`]}>
            <line
              className={styles.eventLine}
              x1={marker.cx}
              x2={marker.cx}
              y1={marker.labelY === null ? M.top : marker.labelY + 4}
              y2={M.top + plotH}
            />
            {marker.labelY !== null && (
              <text
                className={styles.eventLabel}
                x={marker.cx}
                y={marker.labelY}
                textAnchor="middle"
              >
                <title>
                  {`${t(EVENT_LONG_KEY[marker.event.kind])} · ${formatStamp(marker.event.t, locale)} · ${marker.event.labels.join(', ')}`}
                </title>
                {marker.text}
              </text>
            )}
          </g>
        ))}

        {resetLabels.map((label) => (
          <text
            key={label.key}
            className={label.projected ? styles.resetLabelProjected : styles.resetLabel}
            x={label.x}
            y={label.y}
            textAnchor="middle"
          >
            <title>{label.title}</title>
            {label.text}
          </text>
        ))}

        {nowVisible && (
          <g>
            <line
              className={styles.nowLine}
              x1={x(now)}
              x2={x(now)}
              y1={M.top - 14}
              y2={M.top + plotH + 4}
            />
            <text className={styles.nowLabel} x={x(now)} y={M.top - 20} textAnchor="middle">
              {t('quota_management.pool_now')}
            </text>
            {hasData && <circle className={styles.nowDot} cx={x(now)} cy={y(nowValue)} r={4.5} />}
          </g>
        )}

        {days.map((day, index) =>
          !showDayLabel(index) ? null : (
            <text
              key={`x${day.t}`}
              className={`${styles.xLabel} ${day.today ? styles.xLabelToday : ''}`}
              x={x(hourly ? day.t : (day.t + day.end) / 2)}
              y={M.top + plotH + 20}
              textAnchor="middle"
            >
              <tspan x={x(hourly ? day.t : (day.t + day.end) / 2)}>{day.weekday}</tspan>
              <tspan x={x(hourly ? day.t : (day.t + day.end) / 2)} dy={17}>
                {day.day}
              </tspan>
            </text>
          )
        )}

        {hover && (
          <g>
            <line
              className={styles.crosshair}
              x1={x(hover.t)}
              x2={x(hover.t)}
              y1={M.top}
              y2={M.top + plotH}
            />
            <circle className={styles.hoverDot} cx={x(hover.t)} cy={y(hover.v)} r={4} />
          </g>
        )}
      </svg>

      {!hasData && (
        <div className={styles.empty} role="status">
          {t('quota_management.pool_no_data')}
        </div>
      )}

      {hover && (
        <div
          className={styles.tooltip}
          style={{ left: tooltipLeft }}
          role="status"
          aria-live="polite"
        >
          <div className={styles.tooltipStamp}>{formatStamp(hover.t, locale)}</div>
          <div className={styles.tooltipValue}>
            <span>{rateMode ? formatRate(hover.v) : formatPercent(hover.v)}</span>
            <span className={styles.tooltipKind}>
              {hover.isProjected
                ? t('quota_management.pool_legend_projected')
                : t('quota_management.pool_legend_recorded')}
            </span>
          </div>
          {hover.events.length > 0 && (
            <ul className={styles.tooltipEvents}>
              {hover.events.map((e) => (
                <li key={`${e.kind}-${e.t}`} className={styles[`event-${e.kind}`]}>
                  <span className={styles.tooltipEventName}>
                    {t(EVENT_LONG_KEY[e.kind])} · {formatStamp(e.t, locale)}
                  </span>
                  <span>{e.labels.join(', ')}</span>
                </li>
              ))}
            </ul>
          )}
          {hover.accounts.length > 0 && (
            <ul className={styles.tooltipAccounts}>
              {hover.accounts.map((a) => (
                <li key={a.label}>
                  <span>{a.label}</span>
                  <span>{formatPercent(a.v)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
