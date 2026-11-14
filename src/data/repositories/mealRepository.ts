import type { BabmuwonDatabase } from '../database'
import type { EntityId, MealEntry, MealPlan, YearMonth } from '../types'
import type { Transaction } from 'dexie'
import { ConflictRepository } from './conflictRepository'
import { VersionRepository } from './versionRepository'

export class MealRepository {
  private readonly db: BabmuwonDatabase
  private readonly versions: VersionRepository
  private readonly conflicts: ConflictRepository

  constructor(db: BabmuwonDatabase) {
    this.db = db
    this.versions = new VersionRepository(db)
    this.conflicts = new ConflictRepository(db)
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
        await this.conflicts.reconcilePlan(plan, version, confirmedAt, transaction)

        const activeDocuments = await this.db.generatedDocs
          .where('status')
          .anyOf('approved', 'sent')
          .filter((doc) => doc.yearMonth === plan.yearMonth || (doc.docType === 'S5' && doc.yearMonth === plan.yearMonth.slice(0, 4)))
          .toArray()
        await this.db.generatedDocs.bulkPut(activeDocuments.map((doc) => ({
          ...doc,
          status: 'stale' as const,
          approvedAt: undefined,
          staleReason: `${plan.yearMonth} 식단이 다시 확정되어 재검토가 필요합니다.`,
          correctionNeeded: doc.status === 'sent',
          s2DeliveryState: doc.docType === 'S2' ? 'sync_required' as const : doc.s2DeliveryState,
          updatedAt: confirmedAt,
        })))
      },
    )
  }

  async unconfirm(planId: EntityId): Promise<void> {
    const now = new Date().toISOString()
    await this.db.transaction('rw', this.db.mealPlans, this.db.generatedDocs, async () => {
      const plan = await this.db.mealPlans.get(planId)
      await this.db.mealPlans.update(planId, { status: 'draft', confirmedAt: undefined, updatedAt: now })
      if (!plan) return
      // 확정 해제 중에는 해당 월 S2 승인본을 사용할 수 없다. 다른 월과 다른 문서 종류는 건드리지 않는다.
      const approved = await this.db.generatedDocs.where('status').anyOf('approved', 'sent')
        .filter((doc) => doc.docType === 'S2' && doc.yearMonth === plan.yearMonth).toArray()
      await this.db.generatedDocs.bulkPut(approved.map((doc) => ({
        ...doc, status: 'stale' as const, approvedAt: undefined,
        staleReason: `${plan.yearMonth} 식단 확정이 해제되어 재검토가 필요합니다.`,
        correctionNeeded: doc.status === 'sent',
        s2DeliveryState: 'sync_required' as const, updatedAt: now,
      })))
    })
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
