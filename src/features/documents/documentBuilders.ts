import type {
  AllergenNo, Conflict, DataVersion, MealEntry, Student, StudentAllergy, Substitution,
  YearMonth,
} from '../../data'
import { ALLERGEN_ITEMS } from '../students'
import type { S1Document, S1Row, S3Document, S5Document } from './documentModels'

const weekdays = ['일', '월', '화', '수', '목', '금', '토']

export function buildS1Document(
  yearMonth: YearMonth,
  entries: MealEntry[],
  basedOn: DataVersion,
  generatedAt: string,
): S1Document {
  const slots = [...new Set(entries.map((entry) => entry.slot))]
  const dates = [...new Set(entries.map((entry) => entry.date))].sort()
  const rows: S1Row[] = dates.map((date) => ({
    date,
    weekday: weekdays[new Date(`${date}T00:00:00`).getDay()],
    menus: slots.map((slot) => {
      const entry = entries.find((item) => item.date === date && item.slot === slot)
      return { slot, label: entry ? menuLabel(entry) : '' }
    }),
  }))
  const weekMap = new Map<string, S1Row[]>()
  for (const row of rows) {
    const label = weekLabel(row.date)
    weekMap.set(label, [...(weekMap.get(label) ?? []), row])
  }
  return {
    type: 'S1', period: yearMonth, title: `${yearMonth} 월간 식단표`, generatedAt,
    basedOn: pickVersions(basedOn), slots, rows,
    weeks: [...weekMap].map(([label, weekRows]) => ({ label, rows: weekRows })),
    legend: ALLERGEN_ITEMS.map(({ no, name }) => ({ no, name })),
  }
}

export function buildS3Document(
  yearMonth: YearMonth,
  conflicts: Conflict[],
  substitutions: Substitution[],
  students: Student[],
  basedOn: DataVersion,
  generatedAt: string,
): S3Document {
  const substitutionByConflict = new Map(substitutions.map((item) => [item.conflictId, item]))
  const studentById = new Map(students.map((item) => [item.id, item]))
  const active = conflicts.filter((conflict) => conflict.active !== false && conflict.date.startsWith(yearMonth))
  const blocked = active.filter((conflict) => {
    const status = substitutionByConflict.get(conflict.id)?.status
    return conflict.kind === 'unknown_menu' || !['confirmed', 'excludeOnly'].includes(status ?? '')
  })
  if (blocked.length > 0) throw new Error(`확인 필요 또는 미확정 대체식 ${blocked.length}건이 있어 S3를 생성할 수 없습니다.`)

  const rows = active.flatMap((conflict) => {
    const substitution = substitutionByConflict.get(conflict.id)
    const student = studentById.get(conflict.studentId)
    if (!substitution || !student) return []
    return [{
      date: conflict.date,
      weekLabel: weekLabel(conflict.date),
      studentDisplay: `${student.grade}학년 ${student.class}반 ${student.number}번 (${student.alias})`,
      originalMenu: conflict.menuName,
      substituteMenu: substitution.status === 'excludeOnly' ? '제외만' : substitution.substituteName ?? '',
      allergenNos: [...conflict.allergenNos].sort((a, b) => a - b),
      caution: '제품 표시와 교차접촉 가능성을 확인하고 분리 조리',
    }]
  }).sort((a, b) => a.date.localeCompare(b.date) || a.studentDisplay.localeCompare(b.studentDisplay, 'ko'))
  const totals = new Map<string, number>()
  for (const row of rows) totals.set(row.date, (totals.get(row.date) ?? 0) + 1)
  return {
    type: 'S3', period: yearMonth, title: `${yearMonth} 대체식 작업표`, generatedAt,
    basedOn: pickVersions(basedOn), rows,
    dailyTotals: [...totals].map(([date, count]) => ({ date, count })),
  }
}

export function buildS5Document(
  year: `${number}`,
  students: Student[],
  allergies: StudentAllergy[],
  conflicts: Conflict[],
  substitutions: Substitution[],
  basedOn: DataVersion,
  generatedAt: string,
): S5Document {
  const allergiesByNumber = new Map<AllergenNo, Set<string>>()
  for (const allergy of allergies) {
    const ids = allergiesByNumber.get(allergy.allergenNo) ?? new Set<string>()
    ids.add(allergy.studentId)
    allergiesByNumber.set(allergy.allergenNo, ids)
  }
  const studentIdsWithAllergy = new Set(allergies.map((item) => item.studentId))
  const gradeMap = new Map<number, Set<string>>()
  for (const student of students) if (studentIdsWithAllergy.has(student.id)) {
    const ids = gradeMap.get(student.grade) ?? new Set<string>()
    ids.add(student.id)
    gradeMap.set(student.grade, ids)
  }
  const activeConflictIds = new Set(conflicts
    .filter((conflict) => conflict.active !== false && conflict.date.startsWith(year))
    .map((conflict) => conflict.id))
  const yearSubstitutions = substitutions.filter((item) => activeConflictIds.has(item.conflictId))
  const providedCount = yearSubstitutions.filter((item) => item.status === 'confirmed').length
  const excludedCount = yearSubstitutions.filter((item) => item.status === 'excludeOnly').length
  const byAllergen = ALLERGEN_ITEMS.map(({ no, name }) => ({ allergenNo: no, name, students: allergiesByNumber.get(no)?.size ?? 0 }))
  const byGrade = [...gradeMap].sort(([a], [b]) => a - b).map(([grade, ids]) => ({ grade, students: ids.size }))
  const totalStudents = studentIdsWithAllergy.size
  return {
    type: 'S5', period: year, title: `${year}학년도 식품알레르기 운영현황 보고`, generatedAt,
    basedOn: pickVersions(basedOn), byAllergen, byGrade, providedCount, excludedCount, totalStudents,
    reportText: `${year}학년도 현재 등록 기준 알레르기 관리 학생은 ${totalStudents}명이며, 확정 대체식 제공 ${providedCount}건, 제외만 처리 ${excludedCount}건입니다. 본 통계는 이 기기의 로컬 데이터를 기준으로 작성되었습니다.`,
  }
}

function menuLabel(entry: MealEntry): string {
  if (entry.allergenStatus === 'unknown') return `${entry.menuName} (미확인)`
  if (entry.allergenStatus === 'none_confirmed') return entry.menuName
  return `${entry.menuName} ${entry.allergenNos.join('.')}`
}

function weekLabel(date: string): string {
  const value = new Date(`${date}T00:00:00`)
  const day = value.getDay() || 7
  value.setDate(value.getDate() - day + 1)
  const start = value.toISOString().slice(0, 10)
  value.setDate(value.getDate() + 6)
  return `${start} ~ ${value.toISOString().slice(0, 10)}`
}

function pickVersions(version: DataVersion) {
  return {
    planVersion: version.planVersion,
    studentVersion: version.studentVersion,
    substitutionVersion: version.substitutionVersion,
  }
}
