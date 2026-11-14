import type { SubstituteMenu } from '../../data'

export const DEFAULT_SUBSTITUTE_MENUS: SubstituteMenu[] = [
  seed('seed-rice-1', '흰쌀밥', '밥'), seed('seed-rice-2', '찹쌀밥', '밥'),
  seed('seed-soup-1', '맑은무국', '국'), seed('seed-soup-2', '채소국', '국'),
  seed('seed-main-1', '두부구이', '주찬', [5]), seed('seed-main-2', '닭고기구이', '주찬', [15]),
  seed('seed-main-3', '돼지고기볶음', '주찬', [10]),
  seed('seed-side-1', '오이무침', '부찬'), seed('seed-side-2', '감자조림', '부찬'),
  seed('seed-kimchi-1', '백김치', '김치'),
  seed('seed-dessert-1', '바나나', '후식'), seed('seed-dessert-2', '귤', '후식'),
]

function seed(id: string, name: string, slot: string, allergenNos: SubstituteMenu['allergenNos'] = []): SubstituteMenu {
  return { id, name, slot, allergenStatus: allergenNos.length > 0 ? 'listed' : 'none_confirmed', allergenNos }
}
