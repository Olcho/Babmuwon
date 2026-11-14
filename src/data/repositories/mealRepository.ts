import type { BabmuwonDatabase } from '../database'
import type { EntityId, MealEntry, MealPlan, YearMonth } from '../types'
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
      this.db.mealPlans,
      this.db.dataVersions,
      this.db.substitutions,
      this.db.generatedDocs,
      async (transaction) => {
      await this.db.mealPlans.update(planId, { status: 'confirmed', confirmedAt, updatedAt: confirmedAt })
      await this.versions.bump('planVersion', transaction)
      const confirmedSubstitutions = await this.db.substitutions.where('status').equals('confirmed').toArray()
      await this.db.substitutions.bulkPut(confirmedSubstitutions.map((item) => ({
        ...item, status: 'needs_review' as const, checkedProcessed: false, checkedAt: undefined, updatedAt: confirmedAt,
      })))
      const activeDocuments = await this.db.generatedDocs.where('status').anyOf('approved', 'sent').toArray()
      await this.db.generatedDocs.bulkPut(activeDocuments.map((doc) => ({
        ...doc,
        status: 'stale' as const,
        approvedAt: undefined,
        staleReason: '식단이 다시 확정되어 재검토가 필요합니다.',
        correctionNeeded: doc.status === 'sent',
        updatedAt: confirmedAt,
      })))
    })
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
