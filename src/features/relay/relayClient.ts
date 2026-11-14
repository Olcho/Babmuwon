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

export type RelayErrorKind = 'configuration' | 'authentication' | 'network_or_cors' | 'server' | 'invalid_response' | 'request'

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

  private async request(path: string, authenticated: boolean): Promise<unknown> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const headers = new Headers({ Accept: 'application/json' })
      if (authenticated) headers.set('Authorization', `Bearer ${this.token}`)
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
        method: 'GET', headers, cache: 'no-store', signal: controller.signal,
      })
      const body = await readJson(response)
      if (!response.ok) {
        const code = getErrorCode(body)
        if (response.status === 401 || response.status === 403) {
          throw new RelayApiError('authentication', 'Relay 토큰이 올바르지 않거나 인증이 거부되었습니다.', { status: response.status, code })
        }
        if (response.status >= 500) throw new RelayApiError('server', 'Relay 서버에서 오류가 발생했습니다.', { status: response.status, code })
        throw new RelayApiError('request', 'Relay 요청이 거부되었습니다.', { status: response.status, code })
      }
      return body
    } catch (error) {
      if (error instanceof RelayApiError) throw error
      const timedOut = error instanceof DOMException && error.name === 'AbortError'
      throw new RelayApiError('network_or_cors', timedOut
        ? 'Relay 응답 시간이 초과되었습니다.'
        : 'Relay 서버에 연결할 수 없습니다. 서버 실행 상태와 CORS 허용 Origin을 확인해 주세요.', { cause: error })
    } finally { clearTimeout(timeout) }
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

function getErrorCode(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const code = (value as Record<string, unknown>).error
  return typeof code === 'string' ? code : undefined
}

export const relayClient = new RelayClient()
