import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { parseMealWorkbook } from './mealPlanParser'
import { createMealTemplateWorkbook } from './mealPlanTemplate'

describe('식단 엑셀 템플릿', () => {
  it('템플릿을 그대로 올리면 오류 없이 읽히고 세 가지 알레르기 상태가 구분된다', () => {
    const buffer = XLSX.write(createMealTemplateWorkbook(), { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
    const result = parseMealWorkbook(buffer)
    expect(result.missingHeaders).toEqual([])
    expect(result.issues).toEqual([])
    expect(result.yearMonth).toBe('2026-12')
    expect(result.rows.find((row) => row.menuName === '닭갈비')).toMatchObject({ allergenStatus: 'listed', allergenNos: [5, 6, 13, 15] })
    expect(result.rows.find((row) => row.menuName === '귤')?.allergenStatus).toBe('none_confirmed')
  })
})
