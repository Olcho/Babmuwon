import {
  DocumentRepository, db,
  type AiDraftMeta, type BabmuwonDatabase, type GeneratedDoc, type ReviewChecklist, type TextDraft,
} from '../../data'
import { ALLOW_LIVE_LINER, PrivacyBlockedError, assertPublicMenus, loadPrivacyTerms } from '../relay/aiPrivacyGuard'
import {
  RELAY_NUTRITION_TOPICS, RelayApiError, relayClient,
  type RelayAiResponse, type RelayHealth, type RelayNutritionRequest, type RelayNutritionTopicId, type RelayS2NewsRequest,
} from '../relay/relayClient'
import type { NarrativeSlot, S2Document } from './documentModels'

/**
 * S2 '이달의 소식'·'영양 정보' 문구 흐름 (명세 6-1, R-16, R-17).
 * AI 응답은 항상 초안으로만 저장한다. 검토 체크 3개와 명시적 승인 없이는 문서에 반영되지 않는다.
 * TextDraft는 검토 기록, S2Document.narrativeSlots는 문서 반영본이다.
 */
export type NarrativeKey = NarrativeSlot['key']
export const NARRATIVE_KEYS: NarrativeKey[] = ['monthlyNews', 'nutritionEducation']

export const NUTRITION_TOPIC_LABELS: Record<RelayNutritionTopicId, string> = {
  balanced_meals: '균형 잡힌 식사', seasonal_foods: '제철 식재료', food_allergy_basics: '식품 알레르기 표시의 이해',
  winter_nutrition: '겨울철 건강한 식습관', food_waste: '음식물 쓰레기 줄이기',
}

export class NarrativeError extends Error {}
/** 서버 측 개인정보 차단이 검증되지 않아 live Liner로는 요청하지 않는다. */
export class LinerModeBlockedError extends NarrativeError {}

export const EMPTY_CHECKLIST: ReviewChecklist = { sourceChecked: false, noMedicalClaim: false, factsChecked: false }
const MAX_TEXT = 2000

export interface NarrativeClient {
  hasToken(): boolean
  health(): Promise<RelayHealth>
  s2News(input: RelayS2NewsRequest): Promise<RelayAiResponse>
  nutrition(input: RelayNutritionRequest): Promise<RelayAiResponse>
}

export class S2NarrativeService {
  private readonly database: BabmuwonDatabase
  private readonly client: NarrativeClient
  private readonly documents: DocumentRepository

  constructor(database: BabmuwonDatabase, client: NarrativeClient) {
    this.database = database
    this.client = client
    this.documents = new DocumentRepository(database)
  }

  /** 문서 월의 확정 식단에 있는 공개 메뉴명(중복 제거). 대표 메뉴 선택지로 쓴다. */
  async listMenuCandidates(docId: string): Promise<{ all: string[]; suggested: string[] }> {
    const doc = await this.requireDraftS2(docId)
    const entries = await this.confirmedEntries(doc)
    const all = [...new Set(entries.map((entry) => entry.menuName))]
    const main = [...new Set(entries.filter((entry) => entry.slot === '주찬').map((entry) => entry.menuName))]
    return { all, suggested: [...main, ...all.filter((name) => !main.includes(name))].slice(0, 3) }
  }

  async getDrafts(docId: string): Promise<Record<NarrativeKey, TextDraft | undefined>> {
    const drafts = await this.documents.getDrafts(docId)
    return { monthlyNews: drafts.find((d) => d.field === 'monthlyNews'), nutritionEducation: drafts.find((d) => d.field === 'nutritionEducation') }
  }

  /** `POST /ai/s2-news`: 월과 대표 메뉴명만 전송한다. */
  async generateNews(docId: string, menus: string[]): Promise<TextDraft> {
    const doc = await this.requireDraftS2(docId)
    const body: RelayS2NewsRequest = { month: doc.yearMonth, menus }
    const publicMenus = new Set((await this.confirmedEntries(doc)).map((entry) => entry.menuName))
    return this.generate(doc, 'monthlyNews', '/ai/s2-news', { month: body.month, menus }, async () => {
      assertPublicMenus(menus, publicMenus, await loadPrivacyTerms(this.database))
      return () => this.client.s2News(body)
    })
  }

  /** `POST /ai/nutrition`: 미리 정한 주제 ID만 전송한다. */
  async generateNutrition(docId: string, topicId: RelayNutritionTopicId): Promise<TextDraft> {
    const doc = await this.requireDraftS2(docId)
    return this.generate(doc, 'nutritionEducation', '/ai/nutrition', { topicId }, async () => {
      if (!(RELAY_NUTRITION_TOPICS as readonly string[]).includes(topicId)) throw new NarrativeError('허용된 영양 교육 주제가 아닙니다.')
      return () => this.client.nutrition({ topicId })
    })
  }

  /** 직접 입력 또는 AI 초안 수정. 수정하면 검토 체크와 승인이 모두 초기화된다. */
  async saveText(docId: string, key: NarrativeKey, text: string): Promise<TextDraft> {
    const doc = await this.requireDraftS2(docId)
    const value = text.trim()
    if (!value) throw new NarrativeError('문구를 입력해 주세요.')
    if (value.length > MAX_TEXT) throw new NarrativeError(`문구는 ${MAX_TEXT}자 이하여야 합니다.`)
    const existing = (await this.getDrafts(docId))[key]
    const aiDerived = existing && (existing.source === 'router' || existing.source === 'liner')
    const draft: TextDraft = aiDerived
      ? { ...existing, text: value, edited: existing.edited || value !== existing.text, reviewChecklist: { ...EMPTY_CHECKLIST }, approved: false }
      : this.newDraft(doc, key, existing?.source === 'template' && value === existing.text ? 'template' : 'manual', value, [])
    await this.persist(doc, key, draft)
    return draft
  }

  /** Relay 실패·오프라인 때 쓰는 기존 로컬 기본 문구(R-17). */
  async useTemplate(docId: string, key: NarrativeKey): Promise<TextDraft> {
    const doc = await this.requireDraftS2(docId)
    const month = Number(doc.yearMonth.slice(5))
    const text = key === 'monthlyNews'
      ? `${month}월 급식 안내입니다. 이달 식단과 알레르기 유발식품 표시를 확인해 주세요.`
      : '다양한 음식을 골고루 먹고 충분히 물을 마시는 습관이 건강한 식생활의 기본입니다.'
    const draft = this.newDraft(doc, key, 'template', text, [])
    await this.persist(doc, key, draft)
    return draft
  }

  async setChecklist(docId: string, key: NarrativeKey, checklist: ReviewChecklist): Promise<TextDraft> {
    const doc = await this.requireDraftS2(docId)
    const draft = (await this.getDrafts(docId))[key]
    if (!draft) throw new NarrativeError('검토할 문구가 없습니다.')
    // 체크 변경은 기존 승인을 해제한다. 승인은 항상 별도의 명시적 동작이다.
    const next = { ...draft, reviewChecklist: { ...checklist }, approved: false }
    await this.persist(doc, key, next)
    return next
  }

  /** 승인해야만 문서에 반영된다. AI 초안은 검토 체크 3개가 모두 필요하다. */
  async approveText(docId: string, key: NarrativeKey): Promise<TextDraft> {
    const doc = await this.requireDraftS2(docId)
    const draft = (await this.getDrafts(docId))[key]
    if (!draft || !draft.text.trim()) throw new NarrativeError('승인할 문구가 없습니다.')
    if (isAiSource(draft.source)) {
      const missing = missingChecks(draft.reviewChecklist)
      if (missing.length > 0) throw new NarrativeError(`검토 항목을 모두 확인해 주세요: ${missing.join(', ')}`)
    }
    const approved = { ...draft, approved: true }
    await this.persist(doc, key, approved)
    return approved
  }

  private async generate(
    doc: GeneratedDoc, key: NarrativeKey, endpoint: string, allowedFields: Record<string, unknown>,
    prepare: () => Promise<() => Promise<RelayAiResponse>>,
  ): Promise<TextDraft> {
    if (!this.client.hasToken()) throw new NarrativeError('Relay에 연결되어 있지 않습니다. 직접 입력하거나 기본 문구를 사용해 주세요.')
    let call: () => Promise<RelayAiResponse>
    try { call = await prepare() }
    catch (error) {
      await this.log(endpoint, {}, 'blocked')
      throw error
    }
    try {
      await this.assertMockOnly()
    } catch (error) {
      await this.log(endpoint, {}, 'blocked')
      throw error
    }
    let response: RelayAiResponse
    try { response = await call() }
    catch (error) { await this.log(endpoint, allowedFields, 'error'); throw error }
    await this.log(endpoint, allowedFields, response.cached ? 'cached' : 'ok')

    const meta: AiDraftMeta = {
      simulated: response.simulated, sourceMissing: response.sourceMissing,
      // 서버 값과 무관하게 FE는 항상 검토를 요구한다.
      reviewRequired: true, cached: response.cached, upstream: response.source,
    }
    const draft: TextDraft = {
      ...this.newDraft(doc, key, key === 'monthlyNews' ? 'router' : 'liner', response.text, response.citations), meta,
    }
    await this.persist(doc, key, draft)
    return draft
  }

  /** live Liner는 서버 측 개인정보 차단 검증 전까지 호출하지 않는다. */
  private async assertMockOnly(): Promise<void> {
    const health = await this.client.health()
    if (health.linerMode === 'mock') return
    if (health.linerMode === 'live' && ALLOW_LIVE_LINER) return
    throw new LinerModeBlockedError(health.linerMode === 'live'
      ? 'Relay가 실제 Liner(live) 모드입니다. 서버 측 개인정보 차단이 검증되기 전에는 AI 요청을 보내지 않습니다. Mock 모드에서만 사용할 수 있습니다.'
      : 'Relay의 Liner가 비활성화되어 있습니다.')
  }

  private newDraft(doc: GeneratedDoc, key: NarrativeKey, source: TextDraft['source'], text: string, citations: TextDraft['citations']): TextDraft {
    return {
      id: `${doc.id}:${key}`, generatedDocId: doc.id, docType: 'S2', field: key, source, text, citations: citations.map((c) => ({ ...c })),
      edited: false, reviewChecklist: { ...EMPTY_CHECKLIST }, approved: false,
    }
  }

  /** TextDraft(검토 기록)와 문서 슬롯(반영본)을 한 트랜잭션으로 갱신한다. */
  private async persist(doc: GeneratedDoc, key: NarrativeKey, draft: TextDraft): Promise<void> {
    await this.database.transaction('rw', this.database.generatedDocs, this.database.textDrafts, async () => {
      const fresh = await this.database.generatedDocs.get(doc.id)
      if (!fresh || fresh.status !== 'draft') throw new NarrativeError('초안 상태의 S2만 문구를 수정할 수 있습니다.')
      const content = fresh.content as S2Document
      const slots = content.narrativeSlots.map((slot): NarrativeSlot => slot.key !== key ? slot : {
        ...slot, state: draft.approved ? 'approved' : 'draft', source: draft.source === 'router' || draft.source === 'liner' || draft.source === 'template' ? draft.source : 'manual',
        text: draft.text, citations: draft.citations,
        simulated: draft.meta?.simulated, sourceMissing: draft.meta?.sourceMissing,
      })
      await this.database.textDrafts.put(draft)
      await this.database.generatedDocs.put({ ...fresh, content: { ...content, narrativeSlots: slots }, updatedAt: new Date().toISOString() })
    })
  }

  private async log(endpoint: string, allowedFields: Record<string, unknown>, status: 'ok' | 'blocked' | 'error' | 'cached') {
    // 허용 필드 값만 남기고 차단된 요청의 값은 기록하지 않는다(E6).
    await this.database.apiCallLogs.add({ id: crypto.randomUUID(), at: new Date().toISOString(), endpoint, allowedFields, status })
  }

  private async confirmedEntries(doc: GeneratedDoc) {
    const plan = await this.database.mealPlans.where('yearMonth').equals(doc.yearMonth).first()
    if (!plan || plan.status !== 'confirmed') throw new NarrativeError('확정된 월간 식단이 필요합니다.')
    return this.database.mealEntries.where('mealPlanId').equals(plan.id).toArray()
  }

  private async requireDraftS2(docId: string): Promise<GeneratedDoc> {
    const doc = await this.documents.get(docId)
    if (!doc || doc.docType !== 'S2' || !doc.content) throw new NarrativeError('S2 문서를 찾을 수 없습니다.')
    if (doc.status !== 'draft') throw new NarrativeError('초안 상태의 S2만 문구를 수정할 수 있습니다. 승인·재검토 문서는 다시 생성해 주세요.')
    return doc
  }
}

export function isAiSource(source: TextDraft['source']): boolean { return source === 'router' || source === 'liner' }

export function missingChecks(checklist: ReviewChecklist): string[] {
  return [
    checklist.sourceChecked ? '' : '출처 확인', checklist.noMedicalClaim ? '' : '치료·효능 단정 없음', checklist.factsChecked ? '' : '숫자·메뉴명 확인',
  ].filter(Boolean)
}

/** UI용: 오류를 사용자에게 보여줄 한국어 메시지로 바꾼다. */
export function describeNarrativeError(error: unknown): string {
  if (error instanceof PrivacyBlockedError || error instanceof NarrativeError) return error.message
  if (error instanceof RelayApiError) {
    const code = error.code ? ` (${error.code})` : ''
    return `${error.message}${code} 직접 입력하거나 기본 문구를 사용할 수 있습니다.`
  }
  return 'AI 문구를 생성하지 못했습니다. 직접 입력하거나 기본 문구를 사용할 수 있습니다.'
}

export const s2NarrativeService = new S2NarrativeService(db, relayClient)
