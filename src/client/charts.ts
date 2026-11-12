/**
 * Small HTML/CSS charts for the results page. No chart library: bars and dots are plain
 * elements positioned in percent, so they scale to any width and follow the light/dark
 * tokens in global.css (--viz-*). Every mark has a hover/focus tooltip, and every chart
 * comes with a "Se tallene" table so nothing depends on hovering or on color alone.
 */
import { h, type Child } from './dom.ts';

export interface Tip {
  /** Shown first and strongest, usually the value. */
  value: string;
  /** Secondary lines: what the value is about. */
  lines: string[];
}

// ------------------------------------------------------------------ tooltip

let tipEl: HTMLDivElement | null = null;

function tooltip(): HTMLDivElement {
  if (!tipEl) {
    tipEl = h('div', { className: 'viz-tip', role: 'tooltip', hidden: true });
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

function place(x: number, y: number) {
  const t = tooltip();
  const pad = 12;
  const { width, height } = t.getBoundingClientRect();
  const left = Math.min(window.innerWidth - width - 8, Math.max(8, x + pad));
  const top = y - height - pad < 8 ? y + pad : y - height - pad;
  t.style.left = `${left}px`;
  t.style.top = `${top}px`;
}

/** Makes `el` a hover/focus target that shows `tip`. Keyboard users get the same via focus. */
export function withTip<T extends HTMLElement>(el: T, tip: Tip): T {
  el.tabIndex = 0;
  el.setAttribute('aria-label', [tip.value, ...tip.lines].join(', '));
  const show = (x: number, y: number) => {
    const t = tooltip();
    t.replaceChildren(h('strong', {}, tip.value), ...tip.lines.map((l) => h('div', {}, l)));
    t.hidden = false;
    place(x, y);
    el.classList.add('is-hot');
  };
  const hide = () => {
    tooltip().hidden = true;
    el.classList.remove('is-hot');
  };
  el.addEventListener('pointermove', (e) => show(e.clientX, e.clientY));
  el.addEventListener('pointerleave', hide);
  el.addEventListener('focus', () => {
    const r = el.getBoundingClientRect();
    show(r.left + r.width / 2, r.top);
  });
  el.addEventListener('blur', hide);
  return el;
}

// ------------------------------------------------------------------ shared pieces

const pct = (v: number, min: number, max: number) => `${((Math.min(max, Math.max(min, v)) - min) / (max - min)) * 100}%`;

/** A chart card: title, optional subtitle, the chart, a legend, and a table view. */
export function figure(o: { title: string; subtitle?: string; chart: Child; legend?: Child; table?: HTMLTableElement }) {
  return h('figure', { className: 'card viz' },
    h('figcaption', {},
      h('h3', {}, o.title),
      o.subtitle && h('p', { className: 'small muted' }, o.subtitle),
    ),
    o.legend,
    o.chart,
    o.table && h('details', { className: 'viz-table' }, h('summary', {}, 'Se tallene'), h('div', { className: 'table-scroll' }, o.table)),
  );
}

export function legend(items: { label: string; kind: 'bar' | 'dot'; color: string }[]) {
  return h('div', { className: 'viz-legend' },
    items.map((i) => h('span', {}, h('i', { className: `key-${i.kind}`, style: `background: var(${i.color})` }), i.label)));
}

export function table(head: string[], rows: (string | number)[][], numeric: boolean[] = []) {
  return h('table', {},
    h('thead', {}, h('tr', {}, head.map((c, i) => h('th', { className: numeric[i] ? 'n' : '' }, c)))),
    h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c, i) => h('td', { className: numeric[i] ? 'n' : '' }, String(c)))))),
  );
}

/** Gridlines + tick labels for a horizontal value axis. */
function axis(ticks: number[], min: number, max: number, format: (v: number) => string) {
  return h('div', { className: 'viz-axis', 'aria-hidden': 'true' },
    ticks.map((t) => h('span', { style: `left: ${pct(t, min, max)}` }, format(t))));
}

function grid(ticks: number[], min: number, max: number) {
  return ticks.map((t) => h('i', { className: 'viz-grid', style: `left: ${pct(t, min, max)}`, 'aria-hidden': 'true' }));
}

// ------------------------------------------------------------------ horizontal bars

export interface BarRow {
  label: string;
  sublabel?: string;
  value: number;
  valueLabel: string;
  tip: Tip;
  /** Use the second series color (for example the winner). */
  accent?: boolean;
}

/** Horizontal bars from a baseline at `min`, value at the tip. */
export function bars(rows: BarRow[], o: { min: number; max: number; ticks: number[]; format: (v: number) => string }) {
  return h('div', { className: 'viz-plot' },
    h('div', { className: 'viz-rows' },
      rows.map((r) =>
        h('div', { className: 'viz-row' },
          h('div', { className: 'viz-label' }, r.label, r.sublabel && h('span', { className: 'muted' }, r.sublabel)),
          h('div', { className: 'viz-track' },
            grid(o.ticks, o.min, o.max),
            withTip(h('div', { className: `viz-bar${r.accent ? ' accent' : ''}`, style: `width: ${pct(r.value, o.min, o.max)}` },
              h('span', { className: 'viz-value' }, r.valueLabel)), r.tip),
          ),
        )),
    ),
    h('div', { className: 'viz-row viz-axis-row' }, h('div', {}), axis(o.ticks, o.min, o.max, o.format)),
  );
}

// ------------------------------------------------------------------ diverging bars

export interface DivergingRow {
  label: string;
  sublabel?: string;
  value: number;
  valueLabel: string;
  tip: Tip;
}

/** Bars left (negative, cool) or right (positive, warm) of a zero line. */
export function diverging(rows: DivergingRow[], o: { limit: number; ticks: number[]; format: (v: number) => string }) {
  const min = -o.limit;
  const max = o.limit;
  return h('div', { className: 'viz-plot' },
    h('div', { className: 'viz-rows' },
      rows.map((r) => {
        const neg = r.value < 0;
        const start = pct(Math.min(0, r.value), min, max);
        const width = `${(Math.abs(r.value) / (max - min)) * 100}%`;
        return h('div', { className: 'viz-row' },
          h('div', { className: 'viz-label' }, r.label, r.sublabel && h('span', { className: 'muted' }, r.sublabel)),
          h('div', { className: 'viz-track' },
            grid(o.ticks, min, max),
            h('i', { className: 'viz-zero', style: `left: ${pct(0, min, max)}`, 'aria-hidden': 'true' }),
            withTip(h('div', { className: `viz-bar diverge ${neg ? 'neg' : 'pos'}`, style: `left: ${start}; width: ${width}` },
              h('span', { className: 'viz-value' }, r.valueLabel)), r.tip),
          ),
        );
      }),
    ),
    h('div', { className: 'viz-row viz-axis-row' }, h('div', {}), axis(o.ticks, min, max, o.format)),
  );
}

// ------------------------------------------------------------------ dot rows

export interface Dot {
  value: number;
  tip: Tip;
  accent?: boolean;
  /** Short text under the dot, e.g. a year. */
  label?: string;
}

/** One row per item with dots on a shared value scale, and a hairline from lowest to highest. */
export function dotRows(rows: { label: string; sublabel?: string; dots: Dot[] }[], o: { min: number; max: number; ticks: number[]; format: (v: number) => string }) {
  return h('div', { className: 'viz-plot' },
    h('div', { className: 'viz-rows' },
      rows.map((r) => {
        const values = r.dots.map((d) => d.value);
        const lo = Math.min(...values);
        const hi = Math.max(...values);
        return h('div', { className: `viz-row dots${r.dots.some((d) => d.label) ? ' labelled' : ''}` },
          h('div', { className: 'viz-label' }, r.label, r.sublabel && h('span', { className: 'muted' }, r.sublabel)),
          h('div', { className: 'viz-track' },
            grid(o.ticks, o.min, o.max),
            h('i', { className: 'viz-range', style: `left: ${pct(lo, o.min, o.max)}; width: calc(${pct(hi, o.min, o.max)} - ${pct(lo, o.min, o.max)})`, 'aria-hidden': 'true' }),
            // Accent dots last, so they sit on top.
            [...r.dots].sort((a, b) => Number(!!a.accent) - Number(!!b.accent)).map((d) =>
              withTip(h('span', { className: `viz-dot${d.accent ? ' accent' : ''}`, style: `left: ${pct(d.value, o.min, o.max)}` },
                d.label && h('small', {}, d.label)), d.tip)),
          ),
        );
      }),
    ),
    h('div', { className: 'viz-row viz-axis-row' }, h('div', {}), axis(o.ticks, o.min, o.max, o.format)),
  );
}

// ------------------------------------------------------------------ heatmap

/** Grid of cells colored on one sequential (blue) scale from `min` to `max`, value printed inside. */
export function heatmap(o: {
  rows: string[];
  columns: string[];
  values: (number | null)[][];
  min: number;
  max: number;
  format: (v: number) => string;
  tip: (row: number, column: number) => Tip;
}) {
  const steps = 12;
  return h('div', { className: 'viz-heat', style: `grid-template-columns: minmax(4.5rem, 1.4fr) repeat(${o.columns.length}, minmax(2.25rem, 1fr))` },
    h('span', {}),
    o.columns.map((c) => h('span', { className: 'viz-heat-col' }, c)),
    o.rows.map((r, i) => [
      h('span', { className: 'viz-heat-row' }, r),
      o.columns.map((_, j) => {
        const v = o.values[i]![j];
        if (v == null) return h('span', { className: 'viz-cell empty', 'aria-label': `${r}, ${o.columns[j]}: ingen karakter` }, '–');
        const step = Math.round(((Math.min(o.max, Math.max(o.min, v)) - o.min) / (o.max - o.min)) * steps);
        return withTip(h('span', { className: `viz-cell heat-${step}` }, o.format(v)), o.tip(i, j));
      }),
    ]),
  );
}

/** Legend for the heatmap's color scale. */
export function heatLegend(min: string, max: string) {
  return h('div', { className: 'viz-legend' },
    h('span', {}, min),
    h('span', { className: 'viz-heat-scale', 'aria-hidden': 'true' }, Array.from({ length: 13 }, (_, i) => h('i', { className: `heat-${i}` }))),
    h('span', {}, max),
  );
}
