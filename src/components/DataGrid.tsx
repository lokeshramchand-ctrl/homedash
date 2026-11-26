import { useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './ui';

export const pretty = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));

function Cell({ v }: { v: unknown }) {
  if (v === null || v === undefined) return <i className="dm-null">null</i>;
  if (typeof v === 'boolean') return <span className="dm-bool">{String(v)}</span>;
  if (typeof v === 'number') return <span className="dm-num">{v}</span>;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && keys[0].startsWith('$')) return <span className="dm-ext" title={keys[0]}>{pretty(o[keys[0]])}</span>;
    return <span className="dm-obj">{JSON.stringify(v)}</span>;
  }
  return <>{String(v)}</>;
}

/** Read-only table of rows. Click a header to sort, click a row to open it. */
export function DataGrid({ columns, rows, sort, dir, onSort, onRow, extra }: {
  columns: string[]; rows: Record<string, unknown>[];
  sort?: string; dir?: 'asc' | 'desc'; onSort?: (c: string) => void; onRow?: (r: Record<string, unknown>, i: number) => void;
  extra?: (r: Record<string, unknown>, i: number) => ReactNode;
}) {
  const [wrap, setWrap] = useState(false);
  return (
    <div className="dm-grid-wrap">
      <div className="dm-grid-tools"><button className="btn btn-ghost btn-sm" onClick={() => setWrap((w) => !w)}>{wrap ? 'Truncate cells' : 'Wrap cells'}</button></div>
      <div className={`dm-grid ${wrap ? 'wrap' : ''}`}>
        <table>
          <thead>
            <tr>
              <th className="dm-idx">#</th>
              {columns.map((c) => (
                <th key={c} className={onSort ? 'sortable' : ''} onClick={() => onSort?.(c)} title={c}>
                  {c}{sort === c && <Icon name="chevron" size={11} />}{sort === c && <small>{dir === 'desc' ? '↓' : '↑'}</small>}
                </th>
              ))}
              {extra && <th />}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={onRow ? 'click' : ''} onClick={() => onRow?.(r, i)}>
                <td className="dm-idx">{i + 1}</td>
                {columns.map((c) => <td key={c}><Cell v={r[c]} /></td>)}
                {extra && <td onClick={(e) => e.stopPropagation()}>{extra(r, i)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function download(name: string, text: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/^[=+\-@]/.test(s) && Number.isNaN(Number(s))) s = `'${s}`; // stop spreadsheets from running it as a formula
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(cell).join(','), ...rows.map((r) => columns.map((c) => cell(r[c])).join(','))].join('\r\n');
}
