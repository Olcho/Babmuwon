import * as XLSX from 'xlsx'
import type { AllergenNo, AllergenStatus, ISODate, MealEntry, YearMonth } from '../../data'

const REQUIRED_HEADERS = ['날짜', '슬롯', '메뉴명', '알레르기 번호'] as const

export interface MealPlanParseIssue {
  row: number
  field: string
  value: unknown
  message: string
}

export interface ParsedMealRow {
  row: number
  date: ISODate
  slot: string
  menuName: string
  allergenStatus: AllergenStatus
  allergenNos: AllergenNo[]
}

export interface MealPlanParseResult {
  rows: ParsedMealRow[]
  issues: MealPlanParseIssue[]
  missingHeaders: string[]
  yearMonth?: YearMonth
}

export interface ParsedAllergenValue {
  status: AllergenStatus
  allergenNos: AllergenNo[]
  error?: string
}

type ExcelRow = Record<string, unknown>

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim()
}

export function parseAllergenValue(value: unknown): ParsedAllergenValue {
  const raw = text(value)
  if (!raw) return { status: 'unknown', allergenNos: [] }
  if (raw === '-' || raw === '없음') return { status: 'none_confirmed', allergenNos: [] }

  const tokens = raw.split(/[.,\s]+/).filter(Boolean)
  if (tokens.length === 0 || tokens.some((token) => !/^\d+$/.test(token))) {
    return { status: 'unknown', allergenNos: [], error: '알레르기 번호는 점, 쉼표 또는 공백으로 구분해 주세요.' }
  }
  const numbers = [...new Set(tokens.map(Number))]
  const invalid = numbers.filter((number) => !Number.isInteger(number) || number < 1 || number > 19)
  if (invalid.length > 0) {
    return { status: 'unknown', allergenNos: [], error: `1~19 범위를 벗어난 번호: ${invalid.join(', ')}` }
  }
  return { status: 'listed', allergenNos: numbers.sort((a, b) => a - b) as AllergenNo[] }
}

export function splitMenuNameAndAllergens(menuValue: unknown): { menuName: string; appended?: string } {
  const menuName = text(menuValue)
  const match = menuName.match(/^(.*?\D)(\d{1,2}(?:[.,]\d{1,2})+)$/)
  if (!match) return { menuName }
  return { menuName: match[1].trim(), appended: match[2] }
}

function toISODate(value: unknown): ISODate | undefined {
  let year: number
  let month: number
  let day: number

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    year = value.getFullYear()
    month = value.getMonth() + 1
    day = value.getDate()
  } else if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value)
    if (!parsed) return undefined
    year = parsed.y
    month = parsed.m
    day = parsed.d
  } else {
    const match = text(value).match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/)
    if (!match) return undefined
    year = Number(match[1])
    month = Number(match[2])
    day = Number(match[3])
  }

  const candidate = new Date(year, month - 1, day)
  if (candidate.getFullYear() !== year || candidate.getMonth() !== month - 1 || candidate.getDate() !== day) return undefined
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function parseMealRows(rows: ExcelRow[], headers: readonly string[] = REQUIRED_HEADERS): MealPlanParseResult {
  const missingHeaders = REQUIRED_HEADERS.filter((header) => !headers.includes(header))
  if (missingHeaders.length > 0) return { rows: [], issues: [], missingHeaders }

  const parsedRows: ParsedMealRow[] = []
  const issues: MealPlanParseIssue[] = []

  rows.forEach((row, index) => {
    const rowNumber = index + 2
    const date = toISODate(row['날짜'])
    const slot = text(row['슬롯'])
    const splitMenu = splitMenuNameAndAllergens(row['메뉴명'])
    const explicitAllergens = text(row['알레르기 번호'])
    const allergenValue = explicitAllergens || splitMenu.appended || ''
    const allergens = parseAllergenValue(allergenValue)

    if (!date) issues.push({ row: rowNumber, field: '날짜', value: row['날짜'], message: '유효한 날짜가 아닙니다.' })
    if (!slot) issues.push({ row: rowNumber, field: '슬롯', value: row['슬롯'], message: '필수 항목입니다.' })
    if (!splitMenu.menuName) issues.push({ row: rowNumber, field: '메뉴명', value: row['메뉴명'], message: '필수 항목입니다.' })
    if (allergens.error) issues.push({ row: rowNumber, field: '알레르기 번호', value: allergenValue, message: allergens.error })
    if (!date || !slot || !splitMenu.menuName || allergens.error) return

    parsedRows.push({ row: rowNumber, date, slot, menuName: splitMenu.menuName, allergenStatus: allergens.status, allergenNos: allergens.allergenNos })
  })

  const months = [...new Set(parsedRows.map((row) => row.date.slice(0, 7)))]
  if (months.length > 1) {
    parsedRows.forEach((row) => issues.push({ row: row.row, field: '날짜', value: row.date, message: '한 파일에는 같은 달의 식단만 넣어 주세요.' }))
    return { rows: [], issues, missingHeaders, yearMonth: undefined }
  }
  return { rows: parsedRows, issues, missingHeaders, yearMonth: months[0] as YearMonth | undefined }
}

export function parseMealWorkbook(data: ArrayBuffer): MealPlanParseResult {
  const workbook = XLSX.read(data, { type: 'array', cellDates: true })
  const firstSheetName = workbook.SheetNames[0]
  if (!firstSheetName) return { rows: [], issues: [], missingHeaders: [...REQUIRED_HEADERS] }
  const sheet = workbook.Sheets[firstSheetName]
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', raw: true })
  const headers = (matrix[0] ?? []).map(text)
  const rows = XLSX.utils.sheet_to_json<ExcelRow>(sheet, { defval: '', raw: true })
  return parseMealRows(rows, headers)
}

export function toMealEntries(rows: ParsedMealRow[], mealPlanId: string, now: string): MealEntry[] {
  return rows.map((row) => ({
    id: `${mealPlanId}:${row.row}`,
    mealPlanId,
    date: row.date,
    slot: row.slot,
    menuName: row.menuName,
    allergenStatus: row.allergenStatus,
    allergenNos: row.allergenNos,
    statusSource: 'excel',
    statusSetAt: now,
  }))
}
