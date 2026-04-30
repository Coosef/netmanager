import ExcelJS from 'exceljs'

export async function exportToExcel(
  sheets: { name: string; data: Record<string, unknown>[] }[],
  filename: string,
) {
  const workbook = new ExcelJS.Workbook()

  for (const sheet of sheets) {
    if (!sheet.data.length) continue
    const keys = Object.keys(sheet.data[0])
    const worksheet = workbook.addWorksheet(sheet.name.slice(0, 31))

    worksheet.columns = keys.map((key) => ({
      header: key,
      key,
      width: Math.max(key.length, ...sheet.data.map((r) => String(r[key] ?? '').length), 10),
    }))

    worksheet.getRow(1).font = { bold: true }
    worksheet.addRows(sheet.data)
  }

  const buffer = await workbook.xlsx.writeBuffer()
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${filename}.xlsx`
  a.click()
  URL.revokeObjectURL(url)
}
