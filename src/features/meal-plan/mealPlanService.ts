import { db, MealRepository, type MealEntry, type MealPlan, type YearMonth } from '../../data'
import type { MealPlanParseResult } from './mealPlanParser'
import { toMealEntries } from './mealPlanParser'

export interface StoredMealPlan {
  plan: MealPlan
  entries: MealEntry[]
}

export class MealPlanService {
  private readonly meals = new MealRepository(db)

  /** 저장된 모든 월의 식단(최신 월 먼저). */
  async listPlans(): Promise<MealPlan[]> {
    return (await this.meals.getAllPlans()).sort((a, b) => b.yearMonth.localeCompare(a.yearMonth))
  }

  async getLatest(): Promise<StoredMealPlan | undefined> {
    const plans = await this.meals.getAllPlans()
    const plan = plans.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
    if (!plan) return undefined
    return { plan, entries: await this.meals.getEntries(plan.id) }
  }

  async getByMonth(yearMonth: YearMonth): Promise<StoredMealPlan | undefined> {
    const plan = await this.meals.getPlanByMonth(yearMonth)
    if (!plan) return undefined
    return { plan, entries: await this.meals.getEntries(plan.id) }
  }

  async saveUpload(result: MealPlanParseResult, sourceFile: string): Promise<StoredMealPlan> {
    if (!result.yearMonth || result.rows.length === 0 || result.missingHeaders.length > 0) {
      throw new Error('저장할 수 있는 식단 데이터가 없습니다.')
    }
    const existing = await this.meals.getPlanByMonth(result.yearMonth)
    const now = new Date().toISOString()
    const plan: MealPlan = {
      id: existing?.id ?? crypto.randomUUID(),
      yearMonth: result.yearMonth,
      status: 'draft',
      sourceFile,
      unknownCount: result.rows.filter((row) => row.allergenStatus === 'unknown').length,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    const entries = toMealEntries(result.rows, plan.id, now)
    await this.meals.saveDraft(plan, entries)
    return { plan, entries }
  }

  async saveEntry(plan: MealPlan, entry: MealEntry): Promise<StoredMealPlan> {
    await this.meals.updateDraftEntry(entry)
    const entries = await this.meals.getEntries(plan.id)
    const updatedPlan = {
      ...plan,
      unknownCount: entries.filter((item) => item.allergenStatus === 'unknown').length,
      updatedAt: new Date().toISOString(),
    }
    await this.meals.updatePlanMetadata(updatedPlan)
    return { plan: updatedPlan, entries }
  }

  async confirm(plan: MealPlan): Promise<StoredMealPlan> {
    await this.meals.confirm(plan.id)
    const stored = await this.meals.getPlan(plan.id)
    if (!stored) throw new Error('식단을 찾을 수 없습니다.')
    return { plan: stored, entries: await this.meals.getEntries(plan.id) }
  }

  async unconfirm(plan: MealPlan): Promise<StoredMealPlan> {
    await this.meals.unconfirm(plan.id)
    const stored = await this.meals.getPlan(plan.id)
    if (!stored) throw new Error('식단을 찾을 수 없습니다.')
    return { plan: stored, entries: await this.meals.getEntries(plan.id) }
  }
}

export const mealPlanService = new MealPlanService()
