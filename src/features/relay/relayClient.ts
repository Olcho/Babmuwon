export interface RelayHealth {
  status: 'ok'
  service: string
  linerMode: 'mock' | 'live' | 'disabled'
  channelMode: 'mock' | 'live' | 'disabled'
  localOnly: boolean
}

export interface RelayCatalog {
  foods: string[]
  topics: Record<string, string>
  templateCode: string
  templateText: string
}

/** `POST /local/s2-state` 요청. 백엔드 `validateDocument`와 같은 규칙을 가진다. */
export interface RelayS2StateRequest {
  month: string
  planVersion: number
  planConfirmed: boolean
  docVersion: number
  basedOnPlanVersion: number
  approved: boolean
}

export interface RelayS2StateResponse extends RelayS2StateRequest {
  approvalSource: 'local-client-attestation'
}

export const RELAY_NUTRITION_TOPICS = ['balanced_meals', 'seasonal_foods', 'food_allergy_basics', 'winter_nutrition', 'food_waste'] as const
export type RelayNutritionTopicId = (typeof RELAY_NUTRITION_TOPICS)[number]

/** `POST /ai/s2-news`. menus는 공개 식단 메뉴명 1~3개뿐이다. */
export interface RelayS2NewsRequest { month: string; menus: string[] }
/** `POST /ai/nutrition`. 미리 정한 주제 ID만 허용된다. */
export interface RelayNutritionRequest { topicId: RelayNutritionTopicId }
export interface RelayCitation { title: string; url: string }

export interface RelayAiResponse {
  text: string
  citations: RelayCitation[]
  simulated: boolean
  cached: boolean
  reviewRequired: boolean
  sourceMissing: boolean
  source: 'mock' | 'router' | 'search'
}

/** Router 30초, Search Agent 60초 제한보다 여유 있게 기다린다. */
export const RELAY_ROUTER_TIMEOUT_MS = 40_000
export const RELAY_SEARCH_TIMEOUT_MS = 70_000
const MAX_MENU_CODE_POINTS = 200

/** `POST /ai/substitute-evidence`. 학생과 연결되지 않은 일반 항목 번호(1~19)와 식품명만 보낸다. */
export interface RelaySubstituteEvidenceRequest { allergenNo: number; foodName: string }

/** 외부 전송용 집계 값: 정수 3~100000 또는 정확한 문자열 "3명 미만". 0·1·2는 FE에서 억제한다. */
export const SUPPRESSED_COUNT = '3명 미만' as const
export type RelaySafeCount = number | typeof SUPPRESSED_COUNT
export interface RelayS5BodyRequest {
  counts: {
    byAllergen: { allergenNo: number; students: RelaySafeCount }[]
    byGrade?: { grade: number; students: RelaySafeCount }[]
    provided: RelaySafeCount
    excluded: RelaySafeCount
  }
}

export type RelayErrorKind =
  | 'configuration' // 토큰·주소 미설정 또는 요청 전 로컬 검증 실패
  | 'authentication' // 401
  | 'forbidden' // 403 (Origin/Host 거부 등, 토큰 문제가 아님)
  | 'validation' // 400
  | 'conflict' // 409
  | 'rate_limited' // 429
  | 'network_or_cors'
  | 'timeout'
  | 'server'
  | 'invalid_response'
  | 'request'

const MAX_VERSION = 999_999_999
const MONTH_PATTERN = /^20\d{2}-(0[1-9]|1[0-2])$/

export class RelayApiError extends Error {
  readonly kind: RelayErrorKind
  readonly status?: number
  readonly code?: string

  constructor(kind: RelayErrorKind, message: string, options: { status?: number; code?: string; cause?: unknown } = {}) {
    super(message, { cause: options.cause })
    this.name = 'RelayApiError'
    this.kind = kind
    this.status = options.status
    this.code = options.code
  }
}

type Fetcher = typeof fetch

export class RelayClient {
  private baseUrl: string
  private token = ''
  private readonly fetcher: Fetcher
  private readonly timeoutMs: number

  constructor(options: { baseUrl?: string; fetcher?: Fetcher; timeoutMs?: number } = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? 'http://127.0.0.1:3000')
    this.fetcher = options.fetcher ?? fetch
    this.timeoutMs = options.timeoutMs ?? 5000
  }

  configure(baseUrl: string, token: string): void {
    this.baseUrl = normalizeBaseUrl(baseUrl)
    if (token.trim()) this.token = token.trim()
  }

  clearToken(): void { this.token = '' }
  hasToken(): boolean { return this.token.length > 0 }
  getBaseUrl(): string { return this.baseUrl }

  async health(): Promise<RelayHealth> {
    const value = await this.request('/health', false)
    if (!isHealth(value)) throw new RelayApiError('invalid_response', 'Relay health 응답 형식이 올바르지 않습니다.')
    return value
  }

  async catalog(): Promise<RelayCatalog> {
    if (!this.token) throw new RelayApiError('configuration', 'Relay 토큰을 입력해 주세요.')
    const value = await this.request('/catalog', true)
    if (!isCatalog(value)) throw new RelayApiError('invalid_response', 'Relay catalog 응답 형식이 올바르지 않습니다.')
    return value
  }

  /**
   * S2 승인·무효화 상태를 Relay에 보고한다. 월·버전·불리언 플래그만 전송하며 학생·식단 내용은 보내지 않는다.
   * 성공 응답을 받아야만 로컬에서 `synced`로 간주할 수 있다.
   */
  async syncS2State(input: RelayS2StateRequest): Promise<RelayS2StateResponse> {
    assertValidS2State(input)
    const body: RelayS2StateRequest = {
      month: input.month, planVersion: input.planVersion, planConfirmed: input.planConfirmed,
      docVersion: input.docVersion, basedOnPlanVersion: input.basedOnPlanVersion, approved: input.approved,
    }
    const value = await this.post('/local/s2-state', body)
    if (!isS2StateResponse(value)) throw new RelayApiError('invalid_response', 'Relay S2 상태 응답 형식이 올바르지 않습니다.')
    return value
  }

  async s2News(input: RelayS2NewsRequest): Promise<RelayAiResponse> {
    const menus = input.menus
    const invalid = !MONTH_PATTERN.test(input.month) || !Array.isArray(menus) || menus.length < 1 || menus.length > 3
      || menus.some((menu) => typeof menu !== 'string' || !menu.trim() || [...menu].length > MAX_MENU_CODE_POINTS)
    if (invalid) throw new RelayApiError('validation', 'S2 소식 요청은 월(YYYY-MM)과 메뉴명 1~3개(각 200자 이하)만 보낼 수 있습니다.')
    return this.ai('/ai/s2-news', { month: input.month, menus: [...menus] }, RELAY_ROUTER_TIMEOUT_MS)
  }

  async nutrition(input: RelayNutritionRequest): Promise<RelayAiResponse> {
    if (!(RELAY_NUTRITION_TOPICS as readonly string[]).includes(input.topicId)) {
      throw new RelayApiError('validation', '허용된 영양 교육 주제만 요청할 수 있습니다.')
    }
    return this.ai('/ai/nutrition', { topicId: input.topicId }, RELAY_SEARCH_TIMEOUT_MS)
  }

  async substituteEvidence(input: RelaySubstituteEvidenceRequest): Promise<RelayAiResponse> {
    const foodName = input.foodName
    if (!Number.isInteger(input.allergenNo) || input.allergenNo < 1 || input.allergenNo > 19
      || typeof foodName !== 'string' || !foodName.trim() || [...foodName].length > MAX_MENU_CODE_POINTS) {
      throw new RelayApiError('validation', '근거 검색은 알레르기 번호(1~19)와 식품명(200자 이하)만 보낼 수 있습니다.')
    }
    return this.ai('/ai/substitute-evidence', { allergenNo: input.allergenNo, foodName }, RELAY_SEARCH_TIMEOUT_MS)
  }

  async s5Body(input: RelayS5BodyRequest): Promise<RelayAiResponse> {
    return this.ai('/ai/s5-body', toS5Body(input), RELAY_ROUTER_TIMEOUT_MS)
  }

  private async ai(path: string, body: unknown, timeoutMs: number): Promise<RelayAiResponse> {
    const value = await this.post(path, body, timeoutMs)
    if (!isAiResponse(value)) throw new RelayApiError('invalid_response', 'Relay AI 응답 형식이 올바르지 않습니다.')
    return value
  }

  /** 인증이 필요한 JSON POST. 자동 재시도는 하지 않는다. */
  private async post(path: string, body: unknown, timeoutMs?: number): Promise<unknown> {
    if (!this.token) throw new RelayApiError('configuration', 'Relay 토큰을 입력해 주세요.')
    return this.request(path, true, { method: 'POST', body, timeoutMs })
  }

  private async request(
    path: string, authenticated: boolean, options: { method?: 'GET' | 'POST'; body?: unknown; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const method = options.method ?? 'GET'
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs)
    try {
      const headers = new Headers({ Accept: 'application/json' })
      if (authenticated) headers.set('Authorization', `Bearer ${this.token}`)
      let payload: string | undefined
      if (method === 'POST') {
        headers.set('Content-Type', 'application/json')
        payload = JSON.stringify(options.body ?? {})
      }
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
        method, headers, body: payload, cache: 'no-store', signal: controller.signal,
      })
      const body = await readJson(response)
      if (!response.ok) throw statusError(response.status, getErrorCode(body))
      return body
    } catch (error) {
      if (error instanceof RelayApiError) throw error
      const timedOut = error instanceof DOMException && error.name === 'AbortError'
      if (timedOut) throw new RelayApiError('timeout', 'Relay 응답 시간이 초과되었습니다.', { cause: error })
      throw new RelayApiError('network_or_cors', 'Relay 서버에 연결할 수 없습니다. 서버 실행 상태와 CORS 허용 Origin을 확인해 주세요.', { cause: error })
    } finally { clearTimeout(timeout) }
  }
}

function statusError(status: number, code?: string): RelayApiError {
  const options = { status, code }
  if (status === 401) return new RelayApiError('authentication', 'Relay 토큰이 올바르지 않거나 인증이 거부되었습니다.', options)
  if (status === 403) return new RelayApiError('forbidden', 'Relay가 이 브라우저의 접근(Origin/Host)을 허용하지 않습니다. Relay CORS 설정을 확인해 주세요.', options)
  if (status === 400) return new RelayApiError('validation', 'Relay가 요청 형식을 거부했습니다.', options)
  if (status === 409) return new RelayApiError('conflict', 'Relay에 기록된 상태와 충돌합니다. 최신 문서 버전으로 다시 동기화해야 합니다.', options)
  if (status === 429) return new RelayApiError('rate_limited', 'Relay가 처리 중인 요청이 많습니다. 잠시 후 다시 시도해 주세요.', options)
  if (status >= 500) return new RelayApiError('server', 'Relay 서버에서 오류가 발생했습니다.', options)
  return new RelayApiError('request', 'Relay 요청이 거부되었습니다.', options)
}

/** 백엔드 validateDocument와 동일한 불변식을 요청 전에 검사한다. */
function assertValidS2State(input: RelayS2StateRequest): void {
  const fail = (message: string) => { throw new RelayApiError('configuration', message) }
  if (!MONTH_PATTERN.test(input.month)) fail('S2 대상 월 형식이 올바르지 않습니다.')
  for (const value of [input.planVersion, input.docVersion, input.basedOnPlanVersion]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_VERSION) fail('S2 버전은 1 이상의 정수여야 합니다.')
  }
  if (input.basedOnPlanVersion > input.planVersion) fail('S2 기반 식단 버전이 현재 식단 버전보다 클 수 없습니다.')
  if (input.approved && (!input.planConfirmed || input.planVersion !== input.basedOnPlanVersion)) {
    fail('승인 상태는 식단이 확정되어 있고 최신 식단 버전 기준일 때만 보고할 수 있습니다.')
  }
}

async function readJson(response: Response): Promise<unknown> {
  try { return await response.json() }
  catch (error) { throw new RelayApiError('invalid_response', 'Relay가 JSON이 아닌 응답을 반환했습니다.', { status: response.status, cause: error }) }
}

function normalizeBaseUrl(rawValue: string): string {
  const value = rawValue.trim()
  if (!value) throw new RelayApiError('configuration', 'Relay 서버 주소를 입력해 주세요.')
  let url: URL
  try { url = new URL(value) }
  catch (error) { throw new RelayApiError('configuration', 'Relay 서버 주소 형식이 올바르지 않습니다.', { cause: error }) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new RelayApiError('configuration', 'http 또는 https Relay 주소만 사용할 수 있습니다.')
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

function isHealth(value: unknown): value is RelayHealth {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return item.status === 'ok' && typeof item.service === 'string'
    && ['mock', 'live', 'disabled'].includes(String(item.linerMode))
    && ['mock', 'live', 'disabled'].includes(String(item.channelMode))
    && typeof item.localOnly === 'boolean'
}

function isCatalog(value: unknown): value is RelayCatalog {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return Array.isArray(item.foods) && item.foods.every((food) => typeof food === 'string')
    && Boolean(item.topics) && typeof item.topics === 'object' && !Array.isArray(item.topics)
    && Object.values(item.topics as Record<string, unknown>).every((topic) => typeof topic === 'string')
    && typeof item.templateCode === 'string' && typeof item.templateText === 'string'
}

function isS2StateResponse(value: unknown): value is RelayS2StateResponse {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return typeof item.month === 'string' && typeof item.planConfirmed === 'boolean' && typeof item.approved === 'boolean'
    && ['planVersion', 'docVersion', 'basedOnPlanVersion'].every((key) => Number.isSafeInteger(item[key]))
    && item.approvalSource === 'local-client-attestation'
}

/** 백엔드 validateS5와 같은 규칙으로 검사하고, 허용된 필드만 복사해 새 객체로 만든다. */
function toS5Body(input: RelayS5BodyRequest): RelayS5BodyRequest {
  const fail = () => { throw new RelayApiError('validation', 'S5 집계 요청 형식이 올바르지 않습니다. 0~2명 집계는 "3명 미만"으로 바꿔야 합니다.') }
  const safe = (value: unknown): RelaySafeCount => {
    if (value === SUPPRESSED_COUNT) return value
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 3 || value > 100_000) return fail() as never
    return value
  }
  const counts = input?.counts
  if (!counts || !Array.isArray(counts.byAllergen) || counts.byAllergen.length > 19) return fail() as never
  const allergens = new Set<number>()
  const byAllergen = counts.byAllergen.map((item) => {
    if (!Number.isInteger(item.allergenNo) || item.allergenNo < 1 || item.allergenNo > 19 || allergens.has(item.allergenNo)) return fail() as never
    allergens.add(item.allergenNo)
    return { allergenNo: item.allergenNo, students: safe(item.students) }
  })
  let byGrade: { grade: number; students: RelaySafeCount }[] | undefined
  if (counts.byGrade !== undefined) {
    if (!Array.isArray(counts.byGrade) || counts.byGrade.length > 6) return fail() as never
    const grades = new Set<number>()
    byGrade = counts.byGrade.map((item) => {
      if (!Number.isInteger(item.grade) || item.grade < 1 || item.grade > 6 || grades.has(item.grade)) return fail() as never
      grades.add(item.grade)
      return { grade: item.grade, students: safe(item.students) }
    })
  }
  return { counts: { byAllergen, ...(byGrade ? { byGrade } : {}), provided: safe(counts.provided), excluded: safe(counts.excluded) } }
}

function isAiResponse(value: unknown): value is RelayAiResponse {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return typeof item.text === 'string' && item.text.trim().length > 0 && item.text.length <= 20_000
    && ['simulated', 'cached', 'reviewRequired', 'sourceMissing'].every((key) => typeof item[key] === 'boolean')
    && ['mock', 'router', 'search'].includes(String(item.source))
    && Array.isArray(item.citations) && item.citations.length <= 20 && item.citations.every(isCitation)
}

/** 출처 링크는 http(s)만 허용한다. 텍스트는 React 텍스트로만 렌더링한다. */
function isCitation(value: unknown): value is RelayCitation {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  if (typeof item.title !== 'string' || typeof item.url !== 'string') return false
  try { return ['http:', 'https:'].includes(new URL(item.url).protocol) } catch { return false }
}

function getErrorCode(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const code = (value as Record<string, unknown>).error
  return typeof code === 'string' ? code : undefined
}

export const relayClient = new RelayClient()
