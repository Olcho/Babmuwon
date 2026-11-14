import type { BabmuwonDatabase } from '../database'
import type {
  AllergenNo,
  Conflict,
  DataVersion,
  EntityId,
  MealEntry,
  MealPlan,
  Student,
  Substitution,
  YearMonth,
} from '../types'
import type { Transaction } from 'dexie'
import { VersionRepository } from './versionRepository'

export class MealRepository {
  private readonly db: BabmuwonDatabase
  private readonly versions: VersionRepository

  constructor(db: BabmuwonDatabase) {
    this.db = db
    this.versions = new VersionRepository(db)
  }

  getPlan(id: EntityId) { return this.db.mealPlans.get(id) }
  getAllPlans() { return this.db.mealPlans.toArray() }
  getPlanByMonth(yearMonth: YearMonth) { return this.db.mealPlans.where('yearMonth').equals(yearMonth).first() }
  getEntries(mealPlanId: EntityId) { return this.db.mealEntries.where('mealPlanId').equals(mealPlanId).sortBy('date') }

  async saveDraft(plan: MealPlan, entries: MealEntry[]): Promise<void> {
    await this.db.transaction('rw', this.db.mealPlans, this.db.mealEntries, async () => {
      await this.db.mealPlans.put(plan)
      await this.db.mealEntries.where('mealPlanId').equals(plan.id).delete()
      await this.db.mealEntries.bulkPut(entries)
    })
  }

  async confirm(planId: EntityId, confirmedAt = new Date().toISOString()): Promise<void> {
    await this.db.transaction(
      'rw',
      [
        this.db.mealPlans,
        this.db.mealEntries,
        this.db.dataVersions,
        this.db.students,
        this.db.studentAllergies,
        this.db.conflicts,
        this.db.substitutions,
        this.db.generatedDocs,
      ],
      async (transaction: Transaction) => {
        const plan = await this.db.mealPlans.get(planId)
        if (!plan) throw new Error('식단을 찾을 수 없습니다.')

        await this.db.mealPlans.update(planId, { status: 'confirmed', confirmedAt, updatedAt: confirmedAt })
        const version = await this.versions.bump('planVersion', transaction)
        await this.reconcileConflicts(plan, version, confirmedAt)

        const activeDocuments = await this.db.generatedDocs
          .where('status')
          .anyOf('approved', 'sent')
          .filter((doc) => doc.yearMonth === plan.yearMonth)
          .toArray()
        await this.db.generatedDocs.bulkPut(activeDocuments.map((doc) => ({
          ...doc,
          status: 'stale' as const,
          approvedAt: undefined,
          staleReason: `${plan.yearMonth} 식단이 다시 확정되어 재검토가 필요합니다.`,
          correctionNeeded: doc.status === 'sent',
          updatedAt: confirmedAt,
        })))
      },
    )
  }

  private async reconcileConflicts(plan: MealPlan, version: DataVersion, at: string): Promise<void> {
    const entries = await this.db.mealEntries.where('mealPlanId').equals(plan.id).toArray()
    const students = await this.db.students.toArray()
    const allergies = await this.db.studentAllergies.toArray()
    const allergiesByStudent = new Map<EntityId, AllergenNo[]>()
    for (const allergy of allergies) {
      const list = allergiesByStudent.get(allergy.studentId) ?? []
      list.push(allergy.allergenNo)
      allergiesByStudent.set(allergy.studentId, list)
    }

    const detected = this.detectConflicts(entries, students, allergiesByStudent)
    const existing = (await this.db.conflicts.where('date').startsWith(plan.yearMonth).toArray())
      .filter((conflict) => conflict.active !== false)
    const substitutions = await this.db.substitutions.toArray()
    const substitutionByConflict = new Map(substitutions.map((item) => [item.conflictId, item]))
    const studentById = new Map(students.map((student) => [student.id, student]))
    const unused = new Set(existing.map((conflict) => conflict.id))
    const conflictsToSave: Conflict[] = []
    const substitutionsToSave: Substitution[] = []

    for (const next of detected) {
      const exact = existing.find((old) => unused.has(old.id) && this.conflictKey(old) === this.conflictKey(next))
      if (exact) {
        unused.delete(exact.id)
        conflictsToSave.push({ ...next, id: exact.id, active: true })
        continue
      }

      const changed = existing.find((old) => unused.has(old.id) && this.isSameConflictPosition(old, next))
      if (changed) {
        unused.delete(changed.id)
        conflictsToSave.push({ ...next, id: changed.id, active: true })
        const substitution = substitutionByConflict.get(changed.id)
        if (substitution) {
          substitutionsToSave.push({
            ...substitution,
            status: substitution.status === 'excludeOnly' ? 'excludeOnly' : 'needs_review',
            checkedProcessed: false,
            checkedAt: undefined,
            basedOn: { planVersion: version.planVersion, studentVersion: version.studentVersion },
            updatedAt: at,
          })
        } else {
          substitutionsToSave.push(this.newSubstitution(changed.id, studentById.get(next.studentId), version, at))
        }
        continue
      }

      const id = crypto.randomUUID()
      conflictsToSave.push({ ...next, id, active: true })
      substitutionsToSave.push(this.newSubstitution(id, studentById.get(next.studentId), version, at))
    }

    for (const id of unused) {
      const conflict = existing.find((item) => item.id === id)
      if (conflict) conflictsToSave.push({ ...conflict, active: false })
      const substitution = substitutionByConflict.get(id)
      if (substitution) substitutionsToSave.push({ ...substitution, status: 'obsolete', updatedAt: at })
    }

    await this.db.conflicts.bulkPut(conflictsToSave)
    await this.db.substitutions.bulkPut(substitutionsToSave)
  }

  private detectConflicts(
    entries: MealEntry[],
    students: Student[],
    allergiesByStudent: Map<EntityId, AllergenNo[]>,
  ): Omit<Conflict, 'id'>[] {
    const result: Omit<Conflict, 'id'>[] = []
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
    return result
  }

  private conflictKey(conflict: Omit<Conflict, 'id'> | Conflict): string {
    return [
      conflict.date,
      conflict.studentId,
      conflict.slot ?? '',
      conflict.menuName,
      conflict.kind,
      [...conflict.allergenNos].sort((a, b) => a - b).join(','),
    ].join('|')
  }

  private isSameConflictPosition(previous: Conflict, next: Omit<Conflict, 'id'>): boolean {
    if (previous.date !== next.date || previous.studentId !== next.studentId) return false
    if (previous.slot && next.slot) return previous.slot === next.slot
    return previous.menuName === next.menuName
  }

  private newSubstitution(
    conflictId: EntityId,
    student: Student | undefined,
    version: DataVersion,
    at: string,
  ): Substitution {
    return {
      id: crypto.randomUUID(),
      conflictId,
      checkedProcessed: false,
      status: student?.needsSubstitute === false ? 'excludeOnly' : 'pending',
      basedOn: { planVersion: version.planVersion, studentVersion: version.studentVersion },
      createdAt: at,
      updatedAt: at,
    }
  }

  async unconfirm(planId: EntityId): Promise<void> {
    const now = new Date().toISOString()
    await this.db.mealPlans.update(planId, { status: 'draft', confirmedAt: undefined, updatedAt: now })
  }

  async updateDraftEntry(entry: MealEntry): Promise<void> {
    await this.db.mealEntries.put(entry)
  }

  async updatePlanMetadata(plan: MealPlan): Promise<void> {
    await this.db.mealPlans.put(plan)
  }

  async deletePlan(id: EntityId): Promise<void> {
    await this.db.transaction('rw', this.db.mealPlans, this.db.mealEntries, async () => {
      await this.db.mealEntries.where('mealPlanId').equals(id).delete()
      await this.db.mealPlans.delete(id)
    })
  }
}
