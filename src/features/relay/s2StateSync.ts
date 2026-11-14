import { DocumentRepository, VersionRepository, db, type BabmuwonDatabase, type GeneratedDoc } from '../../data'
import { DocumentService, isS2SendEligible } from '../documents/documentService'
import { RelayApiError, relayClient, type RelayS2StateRequest, type RelayS2StateResponse } from './relayClient'

/**
 * S2 승인 상태를 Relay `POST /local/s2-state`에 보고한다.
 *
 * Relay는 FE가 보고한 메타데이터만 기록하며 IndexedDB나 PDF를 검증하지 않는다.
 * 따라서 발송 가능 여부(`checkSendEligibility`)는 항상 로컬 데이터로 다시 확인한다.
 * 전송하는 값은 월·버전 번호·불리언뿐이며 학생·식단·학교 정보는 포함하지 않는다.
 */
export interface S2StateClient {
  hasToken(): boolean
  syncS2State(input: RelayS2StateRequest): Promise<RelayS2StateResponse>
}

export type S2SyncStatus = 'synced' | 'failed' | 'not_connected' | 'skipped' | 'superseded'

export interface S2SyncOutcome {
  month: string
  docId?: string
  status: S2SyncStatus
  message: string
  errorCode?: string
}

export interface S2SendEligibility {
  eligible: boolean
  reason?: string
}

const MAX_ATTEMPTS = 3

export class S2StateSyncService {
  private readonly database: BabmuwonDatabase
  private readonly client: S2StateClient
  private readonly documents: DocumentRepository
  private readonly documentService: DocumentService
  private readonly versions: VersionRepository
  private readonly inFlight = new Map<string, Promise<S2SyncOutcome>>()

  constructor(database: BabmuwonDatabase, client: S2StateClient) {
    this.database = database
    this.client = client
    this.documents = new DocumentRepository(database)
    this.documentService = new DocumentService(database)
    this.versions = new VersionRepository(database)
  }

  /**
   * 한 달의 최신 S2 문서 상태를 보고한다. 같은 월의 동시 호출은 하나로 합친다.
   * `force`는 이미 synced인 문서도 다시 보고한다(재연결 후 복구용).
   */
  syncMonth(month: string, options: { force?: boolean } = {}): Promise<S2SyncOutcome> {
    const running = this.inFlight.get(month)
    if (running) return running
    const task = this.runMonth(month, Boolean(options.force)).finally(() => { this.inFlight.delete(month) })
    this.inFlight.set(month, task)
    return task
  }

  /** S2 문서가 있는 모든 월을 월별로 독립 처리한다. 한 달의 실패가 다른 달에 영향을 주지 않는다. */
  async syncAll(options: { force?: boolean } = {}): Promise<S2SyncOutcome[]> {
    const months = [...new Set((await this.allS2()).map((doc) => doc.yearMonth))].sort()
    const outcomes: S2SyncOutcome[] = []
    for (const month of months) outcomes.push(await this.syncMonth(month, options))
    return outcomes
  }

  /** 발송 직전 확인. 로컬 데이터 기준 최신 승인본이고 Relay 동기화가 끝난 문서만 통과한다. */
  async checkSendEligibility(docId: string): Promise<S2SendEligibility> {
    const doc = await this.documents.get(docId)
    if (!doc || doc.docType !== 'S2') return { eligible: false, reason: 'S2 문서를 찾을 수 없습니다.' }
    if (doc.status === 'stale') return { eligible: false, reason: doc.staleReason ?? '재검토가 필요한 문서입니다.' }
    if (doc.status !== 'approved') return { eligible: false, reason: '승인된 S2만 발송할 수 있습니다.' }
    const latest = await this.latestForMonth(doc.yearMonth)
    if (latest && latest.docVersion > doc.docVersion) return { eligible: false, reason: '더 최신 S2 버전이 있습니다.' }
    if (!await this.documentService.isCurrent(doc)) {
      await this.documentService.invalidate(doc.id, STALE_REASON)
      return { eligible: false, reason: `${STALE_REASON} Relay 재동기화가 필요합니다.` }
    }
    if (!isS2SendEligible(doc)) return { eligible: false, reason: deliveryStateReason(doc.s2DeliveryState) }
    return { eligible: true }
  }

  private async runMonth(month: string, force: boolean): Promise<S2SyncOutcome> {
    if (!this.client.hasToken()) {
      return { month, status: 'not_connected', message: 'Relay 연결이 필요합니다. 연결 전까지 S2는 발송할 수 없습니다.' }
    }
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      let doc = await this.latestForMonth(month)
      if (!doc) return { month, status: 'skipped', message: `${month} S2 문서가 없습니다.` }
      if (doc.status === 'approved' && !await this.documentService.isCurrent(doc)) {
        doc = await this.documentService.invalidate(doc.id, STALE_REASON)
      }
      // Relay에 한 번도 보고한 적 없는 초안·재검토 문서는 보낼 상태가 없다.
      if (doc.s2DeliveryState === 'not_connected' || (doc.s2DeliveryState === 'synced' && !force)) {
        return { month, docId: doc.id, status: 'skipped', message: '동기화할 변경이 없습니다.' }
      }
      const snapshot = doc
      try {
        const request = await this.buildRequest(snapshot)
        const response = await this.client.syncS2State(request)
        assertEcho(request, response)
        const fresh = await this.documents.get(snapshot.id)
        // 요청 중 문서가 바뀌었다면(재확정·확정 해제 등) 이번 성공을 최신 상태로 인정하지 않고 다시 보고한다.
        if (!fresh || fresh.updatedAt !== snapshot.updatedAt || fresh.status !== snapshot.status) continue
        await this.documents.save({ ...fresh, s2DeliveryState: 'synced' })
        return {
          month, docId: fresh.id, status: 'synced',
          message: request.approved ? `${month} S2 v${fresh.docVersion} 승인 상태를 Relay에 동기화했습니다.` : `${month} S2 v${fresh.docVersion} 무효 상태를 Relay에 동기화했습니다.`,
        }
      } catch (error) {
        return this.recordFailure(month, snapshot.id, error)
      }
    }
    return { month, status: 'superseded', message: '동기화 중 문서가 계속 변경되어 완료하지 못했습니다. 다시 시도해 주세요.' }
  }

  private async buildRequest(doc: GeneratedDoc): Promise<RelayS2StateRequest> {
    const [plan, version] = await Promise.all([
      this.database.mealPlans.where('yearMonth').equals(doc.yearMonth).first(), this.versions.get(),
    ])
    const planConfirmed = plan?.status === 'confirmed'
    const approved = doc.status === 'approved' && planConfirmed && await this.documentService.isCurrent(doc)
    const basedOnPlanVersion = doc.basedOn.planVersion
    // 승인 시에는 문서 기준 버전과 일치시키고, 무효화 시에는 현재 식단 버전을 보고한다(Relay는 감소를 거부한다).
    // 식단 버전은 전역 카운터라 다른 달의 확정이 이 달의 승인본 버전에 영향을 주지 않도록 승인 시 문서 기준 값을 쓴다.
    const planVersion = approved ? basedOnPlanVersion : Math.max(version.planVersion, basedOnPlanVersion)
    return { month: doc.yearMonth, planVersion, planConfirmed, docVersion: doc.docVersion, basedOnPlanVersion, approved }
  }

  private async recordFailure(month: string, docId: string, error: unknown): Promise<S2SyncOutcome> {
    const fresh = await this.documents.get(docId)
    if (fresh && fresh.s2DeliveryState !== 'not_connected') await this.documents.save({ ...fresh, s2DeliveryState: 'sync_failed' })
    const relayError = error instanceof RelayApiError ? error : undefined
    const detail = relayError?.code ? ` (${relayError.code})` : ''
    return {
      month, docId, status: 'failed', errorCode: relayError?.code,
      message: `${relayError?.message ?? 'Relay 동기화 중 알 수 없는 오류가 발생했습니다.'}${detail} 동기화되기 전까지 발송할 수 없습니다.`,
    }
  }

  private async allS2() {
    return (await this.documents.getAll()).filter((doc) => doc.docType === 'S2')
  }

  private async latestForMonth(month: string) {
    return (await this.allS2()).filter((doc) => doc.yearMonth === month).sort((a, b) => b.docVersion - a.docVersion)[0]
  }
}

const STALE_REASON = '기준 데이터가 변경되어 재검토가 필요합니다.'

function deliveryStateReason(state: GeneratedDoc['s2DeliveryState']): string {
  if (state === 'sync_failed') return 'Relay 동기화에 실패했습니다. 재동기화 후 발송할 수 있습니다.'
  if (state === 'sync_required') return 'Relay 동기화가 필요합니다.'
  return 'Relay에 연결되지 않았습니다.'
}

function assertEcho(request: RelayS2StateRequest, response: RelayS2StateResponse): void {
  const same = (['month', 'planVersion', 'planConfirmed', 'docVersion', 'basedOnPlanVersion', 'approved'] as const)
    .every((key) => request[key] === response[key])
  if (!same) throw new RelayApiError('invalid_response', 'Relay가 요청과 다른 S2 상태를 반환했습니다.')
}

export const s2StateSync = new S2StateSyncService(db, relayClient)
