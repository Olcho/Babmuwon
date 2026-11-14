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
    await this.db.transaction('rw', this.db.mealPlans, this.db.dataVersions, async (transaction) => {
      await this.db.mealPlans.update(planId, { status: 'confirmed', confirmedAt, updatedAt: confirmedAt })
      await this.versions.bump('planVersion', transaction)
    })
  }

  async updateEntry(entry: MealEntry): Promise<void> {
    await this.db.transaction('rw', this.db.mealEntries, this.db.dataVersions, async (transaction) => {
      await this.db.mealEntries.put(entry)
      await this.versions.bump('planVersion', transaction)
    })
  }

  async deletePlan(id: EntityId): Promise<void> {
    await this.db.transaction('rw', this.db.mealPlans, this.db.mealEntries, async () => {
      await this.db.mealEntries.where('mealPlanId').equals(id).delete()
      await this.db.mealPlans.delete(id)
    })
  }
}
