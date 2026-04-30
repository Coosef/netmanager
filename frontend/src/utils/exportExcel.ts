import * as XLSX from 'xlsx'

export function exportToExcel(
  sheets: { name: string; data: Record<string, unknown>[] }[],
  filename: string,
) {
  const wb = XLSX.utils.book_new()
  for (const sheet of sheets) {
    if (!sheet.data.length) continue
    const ws = XLSX.utils.json_to_sheet(sheet.data)
    // Auto column widths
    const cols = Object.keys(sheet.data[0]).map((key) => ({
      wch: Math.max(key.length, ...sheet.data.map((r) => String(r[key] ?? '').length), 10),
    }))
    ws['!cols'] = cols
    XLSX.utils.book_append_sheet(wb, ws, sheet.name.slice(0, 31))
  }
  XLSX.writeFile(wb, `${filename}.xlsx`)
}
