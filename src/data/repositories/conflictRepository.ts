import type { Transaction } from 'dexie'
import { detectAllergyConflicts, type DetectedConflict } from '../../features/conflicts/conflictDetection'
import type { BabmuwonDatabase } from '../database'
import type { Conflict, DataVersion, EntityId, MealPlan, Student, Substitution, YearMonth } from '../types'

export class ConflictRepository {
  private readonly database: BabmuwonDatabase

  constructor(database: BabmuwonDatabase) { this.database = database }

  getActiveForMonth(yearMonth: YearMonth): Promise<Conflict[]> {
    return this.database.conflicts.where('date').startsWith(yearMonth).filter((conflict) => conflict.active !== false).sortBy('date')
  }

  async refreshConfirmedPlans(at = new Date().toISOString()): Promise<void> {
    const plans = await this.database.mealPlans.where('status').equals('confirmed').toArray()
    if (plans.length === 0) return
    await this.database.transaction(
      'rw',
      [
        this.database.mealPlans, this.database.mealEntries, this.database.students,
        this.database.studentAllergies, this.database.dataVersions, this.database.conflicts,
        this.database.substitutions,
      ],
      async (transaction: Transaction) => {
        const version = (await this.database.dataVersions.get('current')) ?? {
          id: 'current' as const, planVersion: 0, studentVersion: 0, substitutionVersion: 0, updatedAt: at,
        }
        for (const plan of plans) await this.reconcilePlan(plan, version, at, transaction)
      },
    )
  }

  async reconcilePlan(
    plan: MealPlan,
    version: DataVersion,
    at: string,
    _transaction?: Transaction,
  ): Promise<void> {
    const [entries, students, allergies] = await Promise.all([
      this.database.mealEntries.where('mealPlanId').equals(plan.id).toArray(),
      this.database.students.toArray(),
      this.database.studentAllergies.toArray(),
    ])
    const detected = detectAllergyConflicts(entries, students, allergies)
    const existing = (await this.database.conflicts.where('date').startsWith(plan.yearMonth).toArray())
      .filter((conflict) => conflict.active !== false)
    const substitutions = await this.database.substitutions.toArray()
    const substitutionByConflict = new Map(substitutions.map((item) => [item.conflictId, item]))
    const studentById = new Map(students.map((student) => [student.id, student]))
    const unused = new Set(existing.map((conflict) => conflict.id))
    const conflictsToSave: Conflict[] = []
    const substitutionsToSave: Substitution[] = []

    for (const next of detected) {
      const exact = existing.find((old) => unused.has(old.id) && conflictKey(old) === conflictKey(next))
      if (exact) {
        unused.delete(exact.id)
        conflictsToSave.push({ ...next, id: exact.id, active: true })
        continue
      }
      const changed = existing.find((old) => unused.has(old.id) && isSameConflictPosition(old, next))
      if (changed) {
        unused.delete(changed.id)
        conflictsToSave.push({ ...next, id: changed.id, active: true })
        const substitution = substitutionByConflict.get(changed.id)
        substitutionsToSave.push(substitution
          ? changedSubstitution(substitution, version, at)
          : newSubstitution(changed.id, studentById.get(next.studentId), version, at))
        continue
      }
      const id = crypto.randomUUID()
      conflictsToSave.push({ ...next, id, active: true })
      substitutionsToSave.push(newSubstitution(id, studentById.get(next.studentId), version, at))
    }

    for (const id of unused) {
      const conflict = existing.find((item) => item.id === id)
      if (conflict) conflictsToSave.push({ ...conflict, active: false })
      const substitution = substitutionByConflict.get(id)
      if (substitution) substitutionsToSave.push({ ...substitution, status: 'obsolete', updatedAt: at })
    }
    await this.database.conflicts.bulkPut(conflictsToSave)
    await this.database.substitutions.bulkPut(substitutionsToSave)
  }
}

function conflictKey(conflict: DetectedConflict | Conflict): string {
  return [
    conflict.date, conflict.studentId, conflict.slot ?? '', conflict.menuName, conflict.kind,
    [...conflict.allergenNos].sort((a, b) => a - b).join(','),
  ].join('|')
}

function isSameConflictPosition(previous: Conflict, next: DetectedConflict): boolean {
  if (previous.date !== next.date || previous.studentId !== next.studentId) return false
  if (previous.slot && next.slot) return previous.slot === next.slot
  return previous.menuName === next.menuName
}

function changedSubstitution(substitution: Substitution, version: DataVersion, at: string): Substitution {
  return {
    ...substitution,
    status: substitution.status === 'excludeOnly' ? 'excludeOnly' : 'needs_review',
    checkedProcessed: false,
    checkedAt: undefined,
    basedOn: { planVersion: version.planVersion, studentVersion: version.studentVersion },
    updatedAt: at,
  }
}

function newSubstitution(
  conflictId: EntityId,
  student: Student | undefined,
  version: DataVersion,
  at: string,
): Substitution {
  return {
    id: crypto.randomUUID(), conflictId, checkedProcessed: false,
    status: student?.needsSubstitute === false ? 'excludeOnly' : 'pending',
    basedOn: { planVersion: version.planVersion, studentVersion: version.studentVersion },
    createdAt: at, updatedAt: at,
  }
}
