export type Phase = 'bet' | 'spin' | 'result';
export type Color = 'r' | 'b' | 'g';

export interface Chip { v: number; c: string; }
export interface Pocket { n: number; color: Color; d: string; tx: number; ty: number; rot: number; }
/** col/row = desktop grid position, mcol/mrow = mobile (vertical table) grid position. */
export interface Cell { key: string; label: string; cls: string; col: string; row: string; mcol: string; mrow: string; }
/** A player shown in the left sidebar (joins the list when "he places his bet"). */
export interface Bot { name: string; cur: string; amt: number; target :number}
export interface HistoryEntry { round: number; number: number; staked: number; returned: number; time: string; }

/** Wheel geometry. pw/ph = pointer half-width / height, fs = pocket label font size, label = label radius (0..1 across the ring). */
export interface Geo {
  cx: number; cy: number; rOut: number; rIn: number; step: number;
  label: number; fs: number; pw: number; ph: number; vb: string;
}

/** European wheel pocket order, clockwise. */
export const ORDER: number[] = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23,
  10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26
];

export const REDS = new Set<number>([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

export const colorOf = (n: number): Color => (n === 0 ? 'g' : REDS.has(n) ? 'r' : 'b');

export const CHIPS: Chip[] = [
  { v: 0.1, c: '#e9b824' },
  { v: 0.2, c: '#7b3fe4' },
  { v: 0.5, c: '#2f80ed' },
  { v: 1, c: '#27ae60' },
  { v: 5, c: '#f2994a' },
  { v: 10, c: '#eb4d8a' },
  { v: 25, c: '#3d5afe' },
  { v: 100, c: '#c2415a' }
];

/**
 * Desktop: circle centre sits above the viewport, only the bottom arc shows (narrow, table-width).
 * Pocket 90deg = straight down = under the pointer.
 */

export const WHEEL_D: Geo = {
  cx: 600, cy: -390, rOut: 670, rIn: 545, step: 360 / 37,
  label: 0.68, fs: 30, pw: 24, ph: 50, vb: '30 -40 1140 332'
};

export const WHEEL_M: Geo = {
  cx: 300, cy: 300, rOut: 282, rIn: 188, step: 360 / 37,
  label: 0.78, fs: 24, pw: 20, ph: 40, vb: '0 0 600 600'
};

/** Kept for the service (only uses WHEEL.step, identical in both geometries). */
export const WHEEL = WHEEL_D;

/** Payout multiplier (total returned per unit staked, stake included) for a bet key on a number. */
export function payout(key: string, n: number): number {
  if (key === 'n' + n) return 36;
  if (n === 0) return 0;
  if (key.startsWith('n')) return 0;
  if (key.startsWith('col')) { const c = n % 3 === 0 ? 3 : n % 3; return key === 'col' + c ? 3 : 0; }
  if (key.startsWith('doz')) return key === 'doz' + Math.ceil(n / 12) ? 3 : 0;
  switch (key) {
    case 'low': return n <= 18 ? 2 : 0;
    case 'high': return n >= 19 ? 2 : 0;
    case 'even': return n % 2 === 0 ? 2 : 0;
    case 'odd': return n % 2 === 1 ? 2 : 0;
    case 'red': return REDS.has(n) ? 2 : 0;
    case 'black': return !REDS.has(n) ? 2 : 0;
    default: return 0;
  }
}

export function betLabel(key: string): string {
  if (key.startsWith('n')) return 'Number ' + key.slice(1);
  const map: Record<string, string> = {
    col1: 'Column 1', col2: 'Column 2', col3: 'Column 3',
    doz1: '1st 12', doz2: '2nd 12', doz3: '3rd 12',
    low: '1 to 18', high: '19 to 36', even: 'Even', odd: 'Odd', red: 'Red', black: 'Black'
  };
  return map[key] ?? key;
}

/**
 * Builds the betting-table cells.
 * Desktop: 0 column, 3x12 grid, 2:1 columns, dozens, outside bets (rows below).
 * Mobile : vertical table — 0 on top, 12 rows of 3, 2:1 under, dozens + outside bets on the right.
 */
export function buildCells(): Cell[] {
  const cells: Cell[] = [];
  cells.push({ key: 'n0', label: '0', cls: 'zero', col: '1', row: '1 / span 3', mcol: '1 / span 3', mrow: '1' });

  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 12; c++) {
      const n = c * 3 + (3 - r);
      cells.push({
        key: 'n' + n, label: String(n), cls: colorOf(n),
        col: String(c + 2), row: String(r + 1),
        mcol: String(((n - 1) % 3) + 1), mrow: String(Math.ceil(n / 3) + 1)
      });
    }
    const col = 3 - r;
    cells.push({
      key: 'col' + col, label: '2 : 1', cls: 'colbet',
      col: '14', row: String(r + 1), mcol: String(col), mrow: '14'
    });
  }

  ['1ST 12', '2ND 12', '3RD 12'].forEach((lbl, d) =>
    cells.push({
      key: 'doz' + (d + 1), label: lbl, cls: 'outside doz',
      col: `${2 + d * 4} / span 4`, row: '4',
      mcol: '4', mrow: `${2 + d * 4} / span 4`
    })
  );

  const outs: Array<[string, string, string]> = [
    ['low', '1 TO 18', 'outside'],
    ['even', 'EVEN', 'outside'],
    ['red', '', 'swatch-r'],
    ['black', '', 'swatch-b'],
    ['odd', 'ODD', 'outside'],
    ['high', '19 TO 36', 'outside']
  ];
  outs.forEach((o, i) =>
    cells.push({
      key: o[0], label: o[1], cls: o[2],
      col: `${2 + i * 2} / span 2`, row: '5',
      mcol: '5', mrow: `${2 + i * 2} / span 2`
    })
  );

  return cells;
}

/** Pre-computes the SVG arc path + label transform for each wheel pocket. */
export function buildPockets(g: Geo = WHEEL_D): Pocket[] {
  const { cx, cy, rOut, rIn, step, label } = g;
  const pol = (r: number, deg: number): [number, number] => {
    const a = (deg * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  return ORDER.map((n, i) => {
    const mid = 90 + i * step;            // 90deg = straight down = under the pointer
    const a0 = mid - step / 2, a1 = mid + step / 2;
    const [x1, y1] = pol(rOut, a0), [x2, y2] = pol(rOut, a1);
    const [x3, y3] = pol(rIn, a1), [x4, y4] = pol(rIn, a0);
    const [tx, ty] = pol(rIn + (rOut - rIn) * label, mid);
    return {
      n,
      color: colorOf(n),
      d: `M${x1} ${y1} A${rOut} ${rOut} 0 0 1 ${x2} ${y2} L${x3} ${y3} A${rIn} ${rIn} 0 0 0 ${x4} ${y4} Z`,
      tx, ty, rot: mid - 90
    };
  });
}

export const BOT_NAMES = [
  'AJAY', 'Priyanka Mew…', 'zulekhan511', 'hamade', 'MILAN1895', 'cnnkbgs', 'klopy',
  '53006079476', 'ff3b4d8b-113…', '1167b45c-675…', '2039_a93b021…', 'RAVINDRA',
  'db9107c9-e43…', 'Indigo Zany …', 'vc7750316013'
];
export const CURRENCIES = ['$', '£', 'Rs', '₹', '€'];