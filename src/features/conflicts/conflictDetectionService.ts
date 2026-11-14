import {
  ConflictRepository,
  db,
  type AllergenNo,
  type BabmuwonDatabase,
  type Conflict,
  type MealPlan,
  type Student,
  type Substitution,
  type YearMonth,
} from '../../data'

export interface ConflictResult {
  conflict: Conflict
  student: Student
  substitution?: Substitution
}

export interface ConflictOverview {
  state: 'ready' | 'no_meal_plan' | 'not_confirmed' | 'no_students'
  plans: MealPlan[]
  selectedPlan?: MealPlan
  results: ConflictResult[]
  conflictCount: number
  unknownCount: number
  affectedStudentCount: number
}

export class ConflictDetectionService {
  private readonly database: BabmuwonDatabase
  private readonly repository: ConflictRepository

  constructor(database: BabmuwonDatabase) {
    this.database = database
    this.repository = new ConflictRepository(database)
  }

  async load(yearMonth?: YearMonth): Promise<ConflictOverview> {
    const allPlans = await this.database.mealPlans.toArray()
    if (allPlans.length === 0) return emptyOverview('no_meal_plan')
    const plans = allPlans.filter((plan) => plan.status === 'confirmed').sort((a, b) => b.yearMonth.localeCompare(a.yearMonth))
    if (plans.length === 0) return { ...emptyOverview('not_confirmed'), plans: allPlans }
    const selectedPlan = plans.find((plan) => plan.yearMonth === yearMonth) ?? plans[0]
    const students = await this.database.students.toArray()
    if (students.length === 0) return { ...emptyOverview('no_students'), plans, selectedPlan }

    const version = (await this.database.dataVersions.get('current')) ?? {
      id: 'current' as const, planVersion: 0, studentVersion: 0, substitutionVersion: 0, updatedAt: new Date().toISOString(),
    }
    await this.database.transaction(
      'rw',
      [
        this.database.mealPlans, this.database.mealEntries, this.database.students,
        this.database.studentAllergies, this.database.conflicts, this.database.substitutions,
      ],
      () => this.repository.reconcilePlan(selectedPlan, version, new Date().toISOString()),
    )

    const [conflicts, substitutions] = await Promise.all([
      this.repository.getActiveForMonth(selectedPlan.yearMonth),
      this.database.substitutions.toArray(),
    ])
    const studentById = new Map(students.map((student) => [student.id, student]))
    const substitutionByConflict = new Map(substitutions.map((substitution) => [substitution.conflictId, substitution]))
    const results = conflicts.flatMap((conflict) => {
      const student = studentById.get(conflict.studentId)
      return student ? [{ conflict, student, substitution: substitutionByConflict.get(conflict.id) }] : []
    })
    return {
      state: 'ready', plans, selectedPlan, results,
      conflictCount: results.filter((item) => item.conflict.kind === 'allergen').length,
      unknownCount: results.filter((item) => item.conflict.kind === 'unknown_menu').length,
      affectedStudentCount: new Set(results.map((item) => item.student.id)).size,
    }
  }
}

function emptyOverview(state: ConflictOverview['state']): ConflictOverview {
  return { state, plans: [], results: [], conflictCount: 0, unknownCount: 0, affectedStudentCount: 0 }
}

export function allergenNumbersLabel(numbers: AllergenNo[]): string {
  return numbers.join(', ')
}

export const conflictDetectionService = new ConflictDetectionService(db)
