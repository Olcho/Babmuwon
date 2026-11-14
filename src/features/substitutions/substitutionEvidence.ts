import { db, type AllergenNo, type BabmuwonDatabase } from '../../data'
import { LinerModeBlockedError, assertMockLiner, logAiCall } from '../relay/aiGate'
import { PrivacyBlockedError, assertPublicMenus, loadPrivacyTerms } from '../relay/aiPrivacyGuard'
import { RelayApiError, relayClient, type RelayAiResponse, type RelayHealth, type RelaySubstituteEvidenceRequest } from '../relay/relayClient'

/**
 * 대체식 후보의 참고 근거 조회 (명세 5-5, F2-8, P1).
 * 결과는 영양사가 읽는 참고 자료일 뿐이며 대체식 확정·후보 목록·안전 판단에 어떤 영향도 주지 않는다.
 * 이 모듈은 Substitution 상태를 읽지도 쓰지도 않는다.
 */
export interface EvidenceClient {
  hasToken(): boolean
  health(): Promise<RelayHealth>
  substituteEvidence(input: RelaySubstituteEvidenceRequest): Promise<RelayAiResponse>
}

export interface StoredEvidence {
  allergenNo: AllergenNo
  foodName: string
  response: RelayAiResponse
  fetchedAt: string
}

export class EvidenceError extends Error {}

const CACHE_PREFIX = 'substitute-evidence'

export class SubstitutionEvidenceService {
  private readonly database: BabmuwonDatabase
  private readonly client: EvidenceClient

  constructor(database: BabmuwonDatabase, client: EvidenceClient) {
    this.database = database
    this.client = client
  }

  /** 이전에 조회해 로컬에 저장한 결과. 네트워크 요청을 하지 않는다. */
  async getStored(foodName: string, allergenNo: AllergenNo): Promise<StoredEvidence | undefined> {
    const row = await this.database.apiCache.get(cacheKey(foodName, allergenNo))
    return row ? { allergenNo, foodName, response: row.response as RelayAiResponse, fetchedAt: row.createdAt } : undefined
  }

  /**
   * `POST /ai/substitute-evidence`. 보내는 값은 알레르기 번호 1개와 후보 식품명뿐이다.
   * 학생·가명·학년반·학생의 알레르기 조합은 포함하지 않으며 요청 기록에도 학생 정보와 연결하지 않는다.
   */
  async fetchEvidence(foodName: string, allergenNo: AllergenNo): Promise<StoredEvidence> {
    const endpoint = '/ai/substitute-evidence'
    if (!this.client.hasToken()) throw new EvidenceError('Relay에 연결되어 있지 않습니다. 근거 조회 없이도 대체식을 확인·확정할 수 있습니다.')
    try {
      if (!Number.isInteger(allergenNo) || allergenNo < 1 || allergenNo > 19) throw new EvidenceError('알레르기 번호(1~19)를 선택해 주세요.')
      assertPublicMenus([foodName], await this.publicFoodNames(), await loadPrivacyTerms(this.database))
      await assertMockLiner(this.client)
    } catch (error) {
      await logAiCall(this.database, endpoint, {}, 'blocked')
      throw error
    }
    const allowed = { allergenNo, foodName }
    let response: RelayAiResponse
    try { response = await this.client.substituteEvidence(allowed) }
    catch (error) { await logAiCall(this.database, endpoint, allowed, 'error'); throw error }
    await logAiCall(this.database, endpoint, allowed, response.cached ? 'cached' : 'ok')
    const fetchedAt = new Date().toISOString()
    await this.database.apiCache.put({ queryHash: cacheKey(foodName, allergenNo), response, createdAt: fetchedAt })
    return { allergenNo, foodName, response, fetchedAt }
  }

  /** 후보로 쓰일 수 있는 공개 식품명: 저장된 식단의 메뉴명과 대체 메뉴 목록. */
  private async publicFoodNames(): Promise<Set<string>> {
    const [entries, seeds] = await Promise.all([this.database.mealEntries.toArray(), this.database.substituteMenus.toArray()])
    return new Set([...entries.map((entry) => entry.menuName), ...seeds.map((menu) => menu.name)])
  }
}

function cacheKey(foodName: string, allergenNo: number): string {
  return `${CACHE_PREFIX}|${allergenNo}|${foodName}`
}

export function describeEvidenceError(error: unknown): string {
  if (error instanceof PrivacyBlockedError || error instanceof EvidenceError || error instanceof LinerModeBlockedError) return error.message
  if (error instanceof RelayApiError) return `${error.message}${error.code ? ` (${error.code})` : ''} 근거 조회 없이도 대체식을 확인·확정할 수 있습니다.`
  return '근거를 조회하지 못했습니다. 근거 조회 없이도 대체식을 확인·확정할 수 있습니다.'
}

export const substitutionEvidenceService = new SubstitutionEvidenceService(db, relayClient)
