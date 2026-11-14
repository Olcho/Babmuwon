import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { parseMealRows, parseMealWorkbook, splitMenuNameAndAllergens } from './mealPlanParser'

const headers = ['날짜', '슬롯', '메뉴명', '알레르기 번호'] as const

describe('SC-04 식단 엑셀 파서', () => {
  it('정상 번호, 빈 번호, 해당 없음 상태를 구분한다', () => {
    const result = parseMealRows([
      { 날짜: '2026-12-01', 슬롯: '주찬', 메뉴명: '가상볶음', '알레르기 번호': '5.6.13' },
      { 날짜: '2026-12-02', 슬롯: '국', 메뉴명: '가상국', '알레르기 번호': '' },
      { 날짜: '2026-12-03', 슬롯: '후식', 메뉴명: '가상후식', '알레르기 번호': '없음' },
    ], headers)

    expect(result.issues).toEqual([])
    expect(result.rows.map((row) => row.allergenStatus)).toEqual(['listed', 'unknown', 'none_confirmed'])
    expect(result.rows[0]?.allergenNos).toEqual([5, 6, 13])
  })

  it('메뉴명 뒤에 붙은 알레르기 번호를 분리한다', () => {
    expect(splitMenuNameAndAllergens('닭갈비5.6.13')).toEqual({ menuName: '닭갈비', appended: '5.6.13' })
    const result = parseMealRows([
      { 날짜: '2026-12-01', 슬롯: '주찬', 메뉴명: '닭갈비5.6.13', '알레르기 번호': '' },
    ], headers)
    expect(result.rows[0]).toMatchObject({ menuName: '닭갈비', allergenStatus: 'listed', allergenNos: [5, 6, 13] })
  })

  it('잘못된 날짜와 범위 밖 번호를 오류 목록으로 보내고 해당 행을 제외한다', () => {
    const result = parseMealRows([
      { 날짜: '2026-02-30', 슬롯: '주찬', 메뉴명: '날짜오류', '알레르기 번호': '5' },
      { 날짜: '2026-02-20', 슬롯: '국', 메뉴명: '번호오류', '알레르기 번호': '20' },
    ], headers)
    expect(result.rows).toHaveLength(0)
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ row: 2, field: '날짜' }),
      expect.objectContaining({ row: 3, field: '알레르기 번호' }),
    ]))
  })

  it('첫 번째 시트와 열 이름을 기준으로 xlsx를 읽는다', () => {
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
      { 날짜: '2026-12-01', 슬롯: '밥', 메뉴명: '가상밥', '알레르기 번호': '-' },
    ]), '첫시트')
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
      { 날짜: '2027-01-01', 슬롯: '밥', 메뉴명: '읽으면안됨', '알레르기 번호': '1' },
    ]), '둘째시트')
    const data = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
    const result = parseMealWorkbook(data)
    expect(result.yearMonth).toBe('2026-12')
    expect(result.rows[0]?.menuName).toBe('가상밥')
  })
})
