import type { AllergenNo, Conflict, MealEntry, Student, StudentAllergy } from '../../data'

export type DetectedConflict = Omit<Conflict, 'id'>

export function detectAllergyConflicts(
  entries: MealEntry[],
  students: Student[],
  allergies: StudentAllergy[],
): DetectedConflict[] {
  const allergiesByStudent = new Map<string, AllergenNo[]>()
  for (const allergy of allergies) {
    const list = allergiesByStudent.get(allergy.studentId) ?? []
    list.push(allergy.allergenNo)
    allergiesByStudent.set(allergy.studentId, list)
  }

  const result: DetectedConflict[] = []
  for (const entry of entries) {
    if (entry.allergenStatus === 'none_confirmed') continue
    for (const student of students) {
      const studentAllergies = allergiesByStudent.get(student.id) ?? []
      if (studentAllergies.length === 0) continue
      const matched = entry.allergenStatus === 'unknown'
        ? studentAllergies
        : studentAllergies.filter((allergenNo) => entry.allergenNos.includes(allergenNo))
      if (matched.length === 0) continue
      result.push({
        date: entry.date,
        studentId: student.id,
        mealEntryId: entry.id,
        slot: entry.slot,
        menuName: entry.menuName,
        kind: entry.allergenStatus === 'unknown' ? 'unknown_menu' : 'allergen',
        allergenNos: [...matched].sort((a, b) => a - b),
        active: true,
      })
    }
  }
  return result.sort((a, b) => a.date.localeCompare(b.date) || a.studentId.localeCompare(b.studentId) || (a.slot ?? '').localeCompare(b.slot ?? ''))
}
