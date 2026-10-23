// 读 Excel / CSV：基于 exceljs（MIT）。统一读成二维数组，日期转成「YYYY-MM-DD HH:mm:ss」文字。
import ExcelJS from 'exceljs';
import type { Cell } from './core';

const pad = (n: number) => String(n).padStart(2, '0');
// exceljs 读出的日期按 UTC 存放表格里显示的时间，这里按 UTC 取出各部分，即表格里看到的时间
const dateText = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;

function cellValue(v: ExcelJS.CellValue): Cell {
  if (v == null) return null;
  if (v instanceof Date) return dateText(v);
  if (typeof v === 'string' || typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (typeof v === 'object') {
    if ('result' in v) return cellValue((v as ExcelJS.CellFormulaValue).result as ExcelJS.CellValue);
    if ('richText' in v) return (v as ExcelJS.CellRichTextValue).richText.map((t) => t.text).join('');
    if ('text' in v) return String((v as ExcelJS.CellHyperlinkValue).text);
    if ('error' in v) return null;
  }
  return String(v);
}

/** CSV 编码：先按 UTF-8，不对再按 GBK（Excel 存的中文 CSV 常是 GBK） */
export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('gbk').decode(bytes);
  }
}

/** 解析 CSV：支持引号、引号内换行与逗号，自动识别逗号 / 制表符 / 分号 */
export function parseCsv(text: string): string[][] {
  const nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  const sep = [',', '\t', ';'].map((s) => [s, first.split(s).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** 读第一个有内容的可见工作表 */
export async function readGrid(bytes: Uint8Array, fileName: string): Promise<Cell[][]> {
  if (/\.(csv|txt)$/i.test(fileName)) return parseCsv(decodeText(bytes));
  if (/\.xls$/i.test(fileName)) throw new Error('旧版 .xls 不支持，请用 Excel 或 WPS 另存为 .xlsx');
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  } catch {
    throw new Error('读不了这个文件，可能已损坏或不是 .xlsx');
  }
  for (const ws of wb.worksheets) {
    if (ws.state !== 'visible') continue;
    const grid: Cell[][] = [];
    ws.eachRow({ includeEmpty: true }, (row, n) => { grid[n - 1] = (row.values as ExcelJS.CellValue[]).slice(1).map(cellValue); });
    for (let i = 0; i < grid.length; i++) grid[i] ??= [];
    if (grid.some((r) => r.some((c) => c !== null && String(c).trim() !== ''))) return grid;
  }
  return [];
}

/** 写一个简单的 xlsx（生成示例文件用） */
export async function writeXlsx(sheet: string, header: string[], rows: Cell[][]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = '篝火 · 订单 / 库存告警推到微信';
  const ws = wb.addWorksheet(sheet, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.addRow(header).font = { bold: true };
  for (const r of rows) ws.addRow(r);
  ws.columns.forEach((c, i) => { c.width = Math.max(10, ...[header[i], ...rows.map((r) => r[i])].map((v) => [...String(v ?? '')].length * 2 + 2)); });
  return new Uint8Array(await wb.xlsx.writeBuffer());
}
