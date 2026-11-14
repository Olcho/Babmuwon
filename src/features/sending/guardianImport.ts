import * as XLSX from 'xlsx'
import type { MockSendService } from './mockSendService'

/** F5-3 '엑셀 불러오기': 첫 시트에서 이름표(또는 표시명)·번호(또는 전화번호) 열을 읽어 가상 보호자로 추가한다. 형식 검사·중복 차단은 addGuardian이 한다. */
export async function importGuardiansFromWorkbook(service: MockSendService, data: ArrayBuffer): Promise<{ added: number; errors: string[] }> {
  const workbook = XLSX.read(data, { type: 'array' })
  const sheet = workbook.Sheets[workbook.SheetNames[0] ?? '']
  if (!sheet) return { added: 0, errors: ['시트를 찾을 수 없습니다.'] }
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' })
  let added = 0
  const errors: string[] = []
  for (const [index, row] of rows.entries()) {
    const label = String(row['이름표'] ?? row['표시명'] ?? '').trim()
    const phone = String(row['번호'] ?? row['전화번호'] ?? '').trim()
    if (!label && !phone) continue
    try { await service.addGuardian({ label, phone }); added += 1 }
    catch (error) { errors.push(`${index + 2}행: ${error instanceof Error ? error.message : '추가하지 못했습니다.'}`) }
  }
  if (rows.length > 0 && !('이름표' in rows[0]! || '표시명' in rows[0]!)) errors.unshift('머리글에 ‘이름표’(또는 ‘표시명’)와 ‘번호’(또는 ‘전화번호’) 열이 필요합니다.')
  return { added, errors }
}
