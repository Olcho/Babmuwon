import {
  SubstitutionRepository,
  db,
  type AllergenNo,
  type AllergenStatus,
  type BabmuwonDatabase,
  type Conflict,
  type MealEntry,
  type Student,
  type Substitution,
  type YearMonth,
} from '../../data'
import { ConflictDetectionService } from '../conflicts'
import { DEFAULT_SUBSTITUTE_MENUS } from './substituteMenuSeeds'
import { recommendSubstitutes, type CandidateMenu } from './substitutionRecommendation'

export interface SubstitutionItem {
  conflict: Conflict
  student: Student
  original: MealEntry
  studentAllergens: AllergenNo[]
  substitution: Substitution
  candidates: CandidateMenu[]
}

export interface SubstitutionOverview {
  state: 'ready' | 'no_meal_plan' | 'not_confirmed' | 'no_students'
  months: YearMonth[]
  selectedMonth?: YearMonth
  items: SubstitutionItem[]
}

export interface SubstitutionSelection {
  name: string
  allergenStatus: Exclude<AllergenStatus, 'unknown'>
  allergenNos: AllergenNo[]
  source: 'recommended' | 'manual'
}

export class SubstitutionValidationError extends Error {}

export class SubstitutionService {
  private readonly database: BabmuwonDatabase
  private readonly seedMenus: typeof DEFAULT_SUBSTITUTE_MENUS
  private readonly conflicts: ConflictDetectionService
  private readonly substitutions: SubstitutionRepository

  constructor(
    database: BabmuwonDatabase,
    seedMenus = DEFAULT_SUBSTITUTE_MENUS,
  ) {
    this.database = database
    this.seedMenus = seedMenus
    this.conflicts = new ConflictDetectionService(database)
    this.substitutions = new SubstitutionRepository(database)
  }

  async load(yearMonth?: YearMonth): Promise<SubstitutionOverview> {
    await this.ensureSeedMenus()
    const conflictOverview = await this.conflicts.load(yearMonth)
    if (conflictOverview.state !== 'ready' || !conflictOverview.selectedPlan) {
      return {
        state: conflictOverview.state,
        months: conflictOverview.plans.filter((plan) => plan.status === 'confirmed').map((plan) => plan.yearMonth),
        selectedMonth: conflictOverview.selectedPlan?.yearMonth,
        items: [],
      }
    }
    const plan = conflictOverview.selectedPlan
    const [entries, seedMenus, memories, allergies, substitutions] = await Promise.all([
      this.database.mealEntries.where('mealPlanId').equals(plan.id).toArray(),
      this.database.substituteMenus.toArray(),
      this.database.substitutionMemories.toArray(),
      this.database.studentAllergies.toArray(),
      this.database.substitutions.toArray(),
    ])
    const entryById = new Map(entries.map((entry) => [entry.id, entry]))
    const substitutionByConflict = new Map(substitutions.map((substitution) => [substitution.conflictId, substitution]))
    const items = conflictOverview.results.flatMap(({ conflict, student }) => {
      const original = entryById.get(conflict.mealEntryId)
      const substitution = substitutionByConflict.get(conflict.id)
      if (!original || !substitution) return []
      const studentAllergens = allergies.filter((allergy) => allergy.studentId === student.id).map((allergy) => allergy.allergenNo)
      const candidates = conflict.kind === 'unknown_menu' || student.needsSubstitute === false ? [] : recommendSubstitutes(
        original, studentAllergens, entries, seedMenus, memories,
      )
      return [{ conflict, student, original, studentAllergens, substitution, candidates }]
    })
    return {
      state: 'ready',
      months: conflictOverview.plans.map((item) => item.yearMonth),
      selectedMonth: plan.yearMonth,
      items,
    }
  }

  async confirm(conflictId: string, selection: SubstitutionSelection, checkedProcessed: boolean): Promise<void> {
    if (!checkedProcessed) throw new SubstitutionValidationError('원재료와 교차접촉 확인 항목을 체크해 주세요.')
    const conflict = await this.database.conflicts.get(conflictId)
    if (!conflict || conflict.active === false) throw new SubstitutionValidationError('현재 유효한 충돌을 찾을 수 없습니다.')
    if (conflict.kind === 'unknown_menu') throw new SubstitutionValidationError('미확인 메뉴는 대체식을 확정할 수 없습니다. 메뉴 정보를 먼저 확인해 주세요.')
    const student = await this.database.students.get(conflict.studentId)
    if (!student?.needsSubstitute) throw new SubstitutionValidationError('대체식 불필요 학생은 제외만 처리하며 대체식을 확정하지 않습니다.')
    const studentAllergens = (await this.database.studentAllergies.where('studentId').equals(conflict.studentId).toArray()).map((item) => item.allergenNo)
    this.validateSelection(selection, studentAllergens)
    if (selection.source === 'recommended') await this.assertCurrentCandidate(conflict, selection, studentAllergens)

    const current = await this.database.substitutions.where('conflictId').equals(conflict.id).first()
    if (!current) throw new SubstitutionValidationError('대체식 저장 정보를 찾을 수 없습니다.')
    const version = (await this.database.dataVersions.get('current')) ?? {
      id: 'current' as const, planVersion: 0, studentVersion: 0, substitutionVersion: 0, updatedAt: new Date().toISOString(),
    }
    const at = new Date().toISOString()
    await this.substitutions.save({
      ...current,
      substituteName: selection.name.trim(),
      substituteAllergenStatus: selection.allergenStatus,
      substituteAllergenNos: [...selection.allergenNos].sort((a, b) => a - b),
      selectionSource: selection.source,
      checkedProcessed: true,
      checkedAt: at,
      status: 'confirmed',
      basedOn: { planVersion: version.planVersion, studentVersion: version.studentVersion },
      updatedAt: at,
    }, {
      originalMenu: conflict.menuName,
      allergenKey: [...studentAllergens].sort((a, b) => a - b).join(','),
      substituteName: selection.name.trim(),
    })
  }

  async cancelConfirmation(conflictId: string): Promise<void> {
    const conflict = await this.database.conflicts.get(conflictId)
    const current = await this.database.substitutions.where('conflictId').equals(conflictId).first()
    if (!conflict || !current) throw new SubstitutionValidationError('대체식 정보를 찾을 수 없습니다.')
    if (current.status !== 'confirmed') return
    await this.substitutions.save({
      ...current, status: 'pending', checkedProcessed: false, checkedAt: undefined, updatedAt: new Date().toISOString(),
    })
  }

  private validateSelection(selection: SubstitutionSelection, studentAllergens: AllergenNo[]): void {
    if (!selection.name.trim()) throw new SubstitutionValidationError('대체 메뉴명을 입력해 주세요.')
    if (selection.allergenStatus === 'listed' && selection.allergenNos.length === 0) {
      throw new SubstitutionValidationError('직접 입력 메뉴의 알레르기 번호를 입력해 주세요.')
    }
    if (new Set(selection.allergenNos).size !== selection.allergenNos.length
      || selection.allergenNos.some((number) => !Number.isInteger(number) || number < 1 || number > 19)) {
      throw new SubstitutionValidationError('알레르기 번호가 올바르지 않습니다.')
    }
    const overlap = selection.allergenNos.filter((number) => studentAllergens.includes(number))
    if (overlap.length > 0) throw new SubstitutionValidationError(`학생 알레르기와 겹치는 번호가 있습니다: ${overlap.join(', ')}`)
  }

  private async assertCurrentCandidate(
    conflict: Conflict,
    selection: SubstitutionSelection,
    studentAllergens: AllergenNo[],
  ): Promise<void> {
    const plan = await this.database.mealPlans.where('yearMonth').equals(conflict.date.slice(0, 7)).first()
    const original = await this.database.mealEntries.get(conflict.mealEntryId)
    if (!plan || !original) throw new SubstitutionValidationError('확정 식단 정보를 찾을 수 없습니다.')
    const [entries, menus, memories] = await Promise.all([
      this.database.mealEntries.where('mealPlanId').equals(plan.id).toArray(),
      this.database.substituteMenus.toArray(),
      this.database.substitutionMemories.toArray(),
    ])
    const candidates = recommendSubstitutes(original, studentAllergens, entries, menus, memories)
    const valid = candidates.some((candidate) => candidate.name === selection.name
      && candidate.allergenStatus === selection.allergenStatus
      && sameNumbers(candidate.allergenNos, selection.allergenNos))
    if (!valid) throw new SubstitutionValidationError('후보 정보가 변경되었습니다. 최신 후보를 다시 선택해 주세요.')
  }

  private async ensureSeedMenus(): Promise<void> {
    if (this.seedMenus.length > 0) await this.database.substituteMenus.bulkPut(this.seedMenus)
  }
}

function sameNumbers(a: AllergenNo[], b: AllergenNo[]): boolean {
  return JSON.stringify([...a].sort((x, y) => x - y)) === JSON.stringify([...b].sort((x, y) => x - y))
}

export const substitutionService = new SubstitutionService(db)
