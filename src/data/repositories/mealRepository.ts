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

  /**
   * 한 달 식단 삭제. 해당 월의 식단·메뉴 행만 지우고 학생·다른 월 데이터는 건드리지 않는다.
   * - 그 달 충돌은 비활성(active=false), 대체식은 obsolete로 바꿔 이력을 남긴다(R-31 '사라진 건 obsolete').
   * - 확정 식단이었다면 planVersion+1, 확정 대체식이 사라지면 substitutionVersion+1.
   * - 그 달 S1~S4와 그 연도 S5의 승인·발송본은 stale(발송본은 correctionNeeded), S2는 Relay 재동기화 대상으로 둔다.
   */
  async deletePlan(id: EntityId, at = new Date().toISOString()): Promise<{ yearMonth: YearMonth; obsoleteSubstitutions: number; staleDocuments: number }> {
    return this.db.transaction(
      'rw',
      [this.db.mealPlans, this.db.mealEntries, this.db.conflicts, this.db.substitutions, this.db.dataVersions, this.db.generatedDocs],
      async (transaction: Transaction) => {
        const plan = await this.db.mealPlans.get(id)
        if (!plan) throw new Error('식단을 찾을 수 없습니다.')
        const month = plan.yearMonth

        await this.db.mealEntries.where('mealPlanId').equals(id).delete()
        await this.db.mealPlans.delete(id)
        if (plan.status === 'confirmed') await this.versions.bump('planVersion', transaction)

        const conflicts = await this.db.conflicts.where('date').startsWith(month).filter((conflict) => conflict.active !== false).toArray()
        await this.db.conflicts.bulkPut(conflicts.map((conflict) => ({ ...conflict, active: false })))
        const conflictIds = new Set(conflicts.map((conflict) => conflict.id))
        const substitutions = (await this.db.substitutions.toArray()).filter((item) => conflictIds.has(item.conflictId) && item.status !== 'obsolete')
        await this.db.substitutions.bulkPut(substitutions.map((item) => ({ ...item, status: 'obsolete' as const, updatedAt: at })))
        if (substitutions.some((item) => item.status === 'confirmed')) await this.versions.bump('substitutionVersion', transaction)

        const year = month.slice(0, 4)
        const affected = await this.db.generatedDocs.where('status').anyOf('approved', 'sent')
          .filter((doc) => (doc.yearMonth === month && doc.docType !== 'S5') || (doc.docType === 'S5' && doc.yearMonth === year)).toArray()
        await this.db.generatedDocs.bulkPut(affected.map((doc) => ({
          ...doc, status: 'stale' as const, approvedAt: undefined,
          staleReason: `${month} 식단이 삭제되어 재검토가 필요합니다.`,
          correctionNeeded: doc.status === 'sent',
          s2DeliveryState: doc.docType === 'S2' && doc.s2DeliveryState !== 'not_connected' ? 'sync_required' as const : doc.s2DeliveryState,
          updatedAt: at,
        })))
        return { yearMonth: month, obsoleteSubstitutions: substitutions.length, staleDocuments: affected.length }
      },
    )
  }
}
