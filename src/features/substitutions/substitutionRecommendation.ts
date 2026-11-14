import type { AllergenNo, AllergenStatus, MealEntry, SubstituteMenu, SubstitutionMemory } from '../../data'

export interface CandidateMenu {
  key: string
  name: string
  slot: string
  allergenStatus: Exclude<AllergenStatus, 'unknown'>
  allergenNos: AllergenNo[]
  energy?: number
  protein?: number
  source: 'meal_plan' | 'seed'
  rememberedCount: number
  nutritionDifference?: number
}

export function recommendSubstitutes(
  original: MealEntry,
  studentAllergens: AllergenNo[],
  mealEntries: MealEntry[],
  substituteMenus: SubstituteMenu[],
  memories: SubstitutionMemory[],
  limit = 5,
): CandidateMenu[] {
  const allergenKey = [...studentAllergens].sort((a, b) => a - b).join(',')
  const memoryCount = new Map(memories
    .filter((memory) => memory.originalMenu === original.menuName && memory.allergenKey === allergenKey)
    .map((memory) => [memory.substituteName, memory.count]))
  const pool: CandidateMenu[] = [
    ...mealEntries.map((entry) => candidateFromMeal(entry, memoryCount.get(entry.menuName) ?? 0)),
    ...substituteMenus.map((menu) => candidateFromSeed(menu, memoryCount.get(menu.name) ?? 0)),
  ].filter((candidate): candidate is CandidateMenu =>
    candidate !== undefined
    && candidate.slot === original.slot
    && candidate.name !== original.menuName
    && !candidate.allergenNos.some((number) => studentAllergens.includes(number)),
  )

  const unique = new Map<string, CandidateMenu>()
  for (const candidate of pool) {
    const current = unique.get(candidate.name)
    if (!current || candidate.source === 'seed') unique.set(candidate.name, candidate)
  }
  const candidates = [...unique.values()].map((candidate) => ({
    ...candidate,
    nutritionDifference: nutritionDifference(original, candidate),
  }))
  candidates.sort((a, b) =>
    b.rememberedCount - a.rememberedCount
    || compareNutrition(a.nutritionDifference, b.nutritionDifference)
    || a.name.localeCompare(b.name, 'ko'),
  )
  return candidates.slice(0, limit)
}

function candidateFromMeal(entry: MealEntry, rememberedCount: number): CandidateMenu | undefined {
  if (entry.allergenStatus === 'unknown') return undefined
  return {
    key: `meal:${entry.id}`, name: entry.menuName, slot: entry.slot,
    allergenStatus: entry.allergenStatus, allergenNos: [...entry.allergenNos],
    energy: entry.energy, protein: entry.protein, source: 'meal_plan', rememberedCount,
  }
}

function candidateFromSeed(menu: SubstituteMenu, rememberedCount: number): CandidateMenu | undefined {
  if (menu.allergenStatus === 'unknown') return undefined
  return {
    key: `seed:${menu.id}`, name: menu.name, slot: menu.slot,
    allergenStatus: menu.allergenStatus, allergenNos: [...menu.allergenNos],
    energy: menu.energy, protein: menu.protein, source: 'seed', rememberedCount,
  }
}

function nutritionDifference(original: MealEntry, candidate: CandidateMenu): number | undefined {
  if (original.energy === undefined || original.protein === undefined || candidate.energy === undefined || candidate.protein === undefined) return undefined
  return Math.abs(original.energy - candidate.energy) + Math.abs(original.protein - candidate.protein) * 10
}

function compareNutrition(a?: number, b?: number): number {
  if (a === undefined && b === undefined) return 0
  if (a === undefined) return 1
  if (b === undefined) return -1
  return a - b
}
