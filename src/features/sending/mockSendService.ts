import {
  db,
  type BabmuwonDatabase, type GeneratedDoc, type Guardian, type SendAttempt, type SendBatch, type SendRecipient,
} from '../../data'
import { DocumentService } from '../documents/documentService'

/**
 * 학부모 발송 Mock 시연 (명세 7장 F5, SC-07의 로컬 시뮬레이션).
 *
 * - 실제 채널톡·카카오 알림톡·Relay(`/send/*`, `/local/s2-state`)를 호출하지 않는다. 이 모듈은 Relay 코드를 import하지 않는다.
 * - 발송 가능 여부는 실제 발송과 같은 로컬 검증(DocumentService.checkS2LocalEligibility)을 쓴다.
 *   Relay 동기화(s2DeliveryState)는 실제 발송 경로에서만 요구한다.
 * - 저장은 기존 Guardian / SendBatch / SendRecipient 테이블을 그대로 쓰고, Mock 기록은 SendBatch.simulated=true로 구분한다.
 * - 화면 문구는 'Mock 발송 성공' 등으로 표시하며 실제 수신을 뜻하지 않는다(R-28).
 */

export const MOCK_TEMPLATE_CODE = 'mock-lunch-notice'
export const MOCK_FAILURE_CODE = 'MOCK_SIMULATED_FAILURE'
export const MOCK_INTERRUPTED_CODE = 'MOCK_INTERRUPTED'
export const MAX_MOCK_RECIPIENTS = 10 // Relay 데모 한도와 같게 둔다.
export const MAX_MOCK_RETRIES = 3

export class MockSendError extends Error {}

export interface MockSendOptions {
  /** 이 보호자들은 가상 실패로 처리한다(재시도 시연용). */
  failGuardianIds?: string[]
  /** 수신자 1명당 처리 지연(ms). 화면에서 '대기' 상태를 보여주기 위한 값이며 테스트는 0. */
  delayMs?: number
  /** 상태가 바뀔 때마다 호출된다(UI 갱신용). */
  onProgress?: () => void
}

export interface MockRecipientView {
  recipient: SendRecipient
  guardianLabel: string
  maskedPhone: string
  retryable: boolean
}

export interface MockBatchView {
  batch: SendBatch
  month: string
  recipients: MockRecipientView[]
  totals: { count: number; pending: number; requested: number; failed: number; delivered: number }
  /** 발송한 S2가 더는 최신 승인본이 아니면 정정 안내가 필요하다(R-33). */
  correctionNeeded: boolean
  correctionReason?: string
}

export interface GuardianInput { label: string; phone: string }

const PHONE_PATTERN = /^010-?(\d{4})-?(\d{4})$/

export class MockSendService {
  private readonly database: BabmuwonDatabase
  private readonly documents: DocumentService
  private readonly running = new Set<string>()

  constructor(database: BabmuwonDatabase) {
    this.database = database
    this.documents = new DocumentService(database)
  }

  // ---- 가상 보호자 (F5-3) -------------------------------------------------

  async listGuardians(): Promise<Guardian[]> {
    return (await this.database.guardians.toArray()).sort((a, b) => a.label.localeCompare(b.label, 'ko'))
  }

  /** 번호 형식 검사·정규화, 중복 번호 차단, 무작위 channelMemberId 발급. 학생과 연결하지 않는다. */
  async addGuardian(input: GuardianInput): Promise<Guardian> {
    const label = input.label.trim()
    if (!label || label.length > 40) throw new MockSendError('보호자 표시명을 1~40자로 입력해 주세요.')
    const phone = normalizePhone(input.phone)
    if (await this.database.guardians.where('phone').equals(phone).count() > 0) throw new MockSendError('이미 등록된 전화번호입니다.')
    const guardian: Guardian = { id: crypto.randomUUID(), label, phone, channelMemberId: crypto.randomUUID() }
    await this.database.guardians.add(guardian)
    return guardian
  }

  async removeGuardian(id: string): Promise<void> {
    await this.database.guardians.delete(id) // 발송 이력은 보존한다(이력에는 '삭제된 보호자'로 표시).
  }

  /** 시연용 가상 보호자. 실제 사용하지 않는 010-0000-xxxx 번호만 쓴다. */
  async addDemoGuardians(): Promise<Guardian[]> {
    const added: Guardian[] = []
    for (const [index, name] of ['가상 보호자 A', '가상 보호자 B', '가상 보호자 C'].entries()) {
      const phone = `010-0000-000${index + 1}`
      if (await this.database.guardians.where('phone').equals(phone).count() > 0) continue
      added.push(await this.addGuardian({ label: name, phone }))
    }
    return added
  }

  // ---- 발송 조건 ------------------------------------------------------------

  /** 월별 최신 S2 목록(발송 대상 선택용). */
  async listLatestS2(): Promise<GeneratedDoc[]> {
    const docs = (await this.database.generatedDocs.toArray()).filter((doc) => doc.docType === 'S2')
    const latest = new Map<string, GeneratedDoc>()
    for (const doc of docs) if ((latest.get(doc.yearMonth)?.docVersion ?? 0) < doc.docVersion) latest.set(doc.yearMonth, doc)
    return [...latest.values()].sort((a, b) => b.yearMonth.localeCompare(a.yearMonth))
  }

  /** 알림톡 미리보기 문구. 학교명은 로컬 학교 설정에서 가져온다. */
  async previewText(doc: Pick<GeneratedDoc, 'yearMonth'>): Promise<string> {
    return mockAlimtalkText(doc.yearMonth, (await this.database.schools.get('school'))?.name)
  }

  /** Mock 발송 가능 여부: 로컬 승인·최신성 검증만 한다(Relay 동기화 불필요). */
  checkEligibility(docId: string) {
    return this.documents.checkS2LocalEligibility(docId)
  }

  async findBatchForDoc(docId: string): Promise<SendBatch | undefined> {
    const doc = await this.database.generatedDocs.get(docId)
    return doc ? this.database.sendBatches.where('batchKey').equals(batchKeyOf(doc)).first() : undefined
  }

  // ---- 시뮬레이션 (F5-4~F5-6, R-27~R-29) ------------------------------------

  /**
   * 선택한 가상 보호자에게 S2 Mock 발송을 시뮬레이션한다.
   * 같은 S2 버전은 배치 하나만 허용한다(batchKey = 연월:doc-v{docVersion}:템플릿, 유일 인덱스).
   */
  async simulate(docId: string, guardianIds: string[], options: MockSendOptions = {}): Promise<MockBatchView> {
    if (this.running.has(docId)) throw new MockSendError('이 S2의 Mock 발송이 이미 진행 중입니다.')
    this.running.add(docId)
    try {
      const check = await this.checkEligibility(docId)
      if (!check.eligible || !check.doc) throw new MockSendError(`Mock 발송을 시작할 수 없습니다: ${check.reason}`)
      const doc = check.doc
      const ids = [...new Set(guardianIds)]
      if (ids.length === 0) throw new MockSendError('Mock 발송 대상 보호자를 선택해 주세요.')
      if (ids.length > MAX_MOCK_RECIPIENTS) throw new MockSendError(`Mock 발송 대상은 최대 ${MAX_MOCK_RECIPIENTS}명입니다.`)
      const guardians = await this.database.guardians.bulkGet(ids)
      if (guardians.some((item) => !item)) throw new MockSendError('삭제되었거나 없는 보호자가 포함되어 있습니다.')

      const now = new Date().toISOString()
      const batch: SendBatch = {
        id: crypto.randomUUID(), batchKey: batchKeyOf(doc), docId: doc.id, docVersion: doc.docVersion,
        templateCode: MOCK_TEMPLATE_CODE, status: 'requesting', createdAt: now, updatedAt: now, simulated: true,
      }
      const recipients: SendRecipient[] = ids.map((guardianId) => ({
        id: crypto.randomUUID(), batchId: batch.id, guardianId, requestStatus: 'pending', deliveryStatus: 'unknown', retryCount: 0, attempts: [], updatedAt: now,
      }))
      await this.database.transaction('rw', this.database.sendBatches, this.database.sendRecipients, async () => {
        if (await this.database.sendBatches.where('batchKey').equals(batch.batchKey).count() > 0) {
          throw new MockSendError('이 S2 버전으로 이미 Mock 발송한 기록이 있습니다. 실패한 수신자는 재시도를 사용하고, 정정은 새 S2를 승인해 보내 주세요.')
        }
        await this.database.sendBatches.add(batch)
        await this.database.sendRecipients.bulkAdd(recipients)
      })
      options.onProgress?.()
      await this.process(batch.id, recipients.map((item) => item.id), options)
      return this.view(batch.id)
    } finally { this.running.delete(docId) }
  }

  /** 가상 실패(request_failed)인 수신자만 같은 배치에서 최대 3회 재시도한다. 발송 조건도 다시 검증한다. */
  async retry(batchId: string, recipientIds: string[], options: MockSendOptions = {}): Promise<MockBatchView> {
    const batch = await this.database.sendBatches.get(batchId)
    if (!batch?.simulated) throw new MockSendError('Mock 발송 기록을 찾을 수 없습니다.')
    if (this.running.has(batch.docId)) throw new MockSendError('이 S2의 Mock 발송이 이미 진행 중입니다.')
    this.running.add(batch.docId)
    try {
      const check = await this.checkEligibility(batch.docId)
      if (!check.eligible) throw new MockSendError(`재시도할 수 없습니다: ${check.reason}`)
      const targets = await this.database.sendRecipients.bulkGet(recipientIds)
      for (const recipient of targets) {
        if (!recipient || recipient.batchId !== batchId) throw new MockSendError('이 배치의 수신자가 아닙니다.')
        if (recipient.requestStatus !== 'request_failed') throw new MockSendError('실패한 수신자만 재시도할 수 있습니다.')
        if (recipient.retryCount >= MAX_MOCK_RETRIES) throw new MockSendError(`재시도는 수신자당 최대 ${MAX_MOCK_RETRIES}회입니다.`)
        if (!await this.database.guardians.get(recipient.guardianId)) throw new MockSendError('삭제된 보호자는 재시도할 수 없습니다.')
      }
      await this.database.transaction('rw', this.database.sendBatches, this.database.sendRecipients, async () => {
        const now = new Date().toISOString()
        for (const recipient of targets as SendRecipient[]) {
          await this.database.sendRecipients.put({ ...recipient, requestStatus: 'pending', retryCount: recipient.retryCount + 1, errorCode: undefined, updatedAt: now })
        }
        await this.database.sendBatches.update(batchId, { status: 'requesting', updatedAt: now })
      })
      options.onProgress?.()
      await this.process(batchId, recipientIds, options)
      return this.view(batchId)
    } finally { this.running.delete(batch.docId) }
  }

  /** 가상 도착 확인. Mock 요청 성공은 도착을 뜻하지 않으므로 영양사가 직접 표시한다(R-28). */
  async markDelivery(recipientId: string, status: 'delivered' | 'failed'): Promise<void> {
    const recipient = await this.database.sendRecipients.get(recipientId)
    const batch = recipient && await this.database.sendBatches.get(recipient.batchId)
    if (!recipient || !batch?.simulated) throw new MockSendError('Mock 발송 수신자를 찾을 수 없습니다.')
    if (recipient.requestStatus !== 'requested') throw new MockSendError('Mock 요청이 성공한 수신자만 도착 여부를 표시할 수 있습니다.')
    await this.database.sendRecipients.put({ ...recipient, deliveryStatus: status, deliveryCheckedBy: 'manual', updatedAt: new Date().toISOString() })
  }

  /** 발송 이력(최신순). 진행 중이 아닌데 대기로 남은 수신자(새로고침 등으로 중단)는 가상 실패로 정리한다. */
  async listHistory(): Promise<MockBatchView[]> {
    const batches = (await this.database.sendBatches.toArray()).filter((batch) => batch.simulated)
    for (const batch of batches) if (batch.status === 'requesting' && !this.running.has(batch.docId)) await this.recoverInterrupted(batch.id)
    const views: MockBatchView[] = []
    for (const batch of batches.sort((a, b) => b.createdAt.localeCompare(a.createdAt))) views.push(await this.view(batch.id))
    return views
  }

  private async process(batchId: string, recipientIds: string[], options: MockSendOptions) {
    const fail = new Set(options.failGuardianIds ?? [])
    for (const id of recipientIds) {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs))
      const recipient = await this.database.sendRecipients.get(id)
      if (!recipient) continue
      const at = new Date().toISOString()
      const failed = fail.has(recipient.guardianId)
      const attempt: SendAttempt = { at, result: failed ? 'request_failed' : 'requested', ...(failed ? { errorCode: MOCK_FAILURE_CODE } : {}) }
      await this.database.sendRecipients.put({
        ...recipient, requestStatus: attempt.result, errorCode: attempt.errorCode,
        attempts: [...(recipient.attempts ?? []), attempt], updatedAt: at,
      })
      options.onProgress?.()
    }
    await this.refreshBatchStatus(batchId)
  }

  private async recoverInterrupted(batchId: string) {
    const at = new Date().toISOString()
    const pending = (await this.database.sendRecipients.where('batchId').equals(batchId).toArray()).filter((item) => item.requestStatus === 'pending')
    await this.database.sendRecipients.bulkPut(pending.map((item) => ({
      ...item, requestStatus: 'request_failed' as const, errorCode: MOCK_INTERRUPTED_CODE,
      attempts: [...(item.attempts ?? []), { at, result: 'request_failed' as const, errorCode: MOCK_INTERRUPTED_CODE }], updatedAt: at,
    })))
    await this.refreshBatchStatus(batchId)
  }

  private async refreshBatchStatus(batchId: string) {
    const recipients = await this.database.sendRecipients.where('batchId').equals(batchId).toArray()
    const status: SendBatch['status'] = recipients.some((item) => item.requestStatus === 'pending') ? 'requesting'
      : recipients.every((item) => item.requestStatus === 'requested') ? 'requested' : 'partial'
    await this.database.sendBatches.update(batchId, { status, updatedAt: new Date().toISOString() })
  }

  private async view(batchId: string): Promise<MockBatchView> {
    const batch = await this.database.sendBatches.get(batchId)
    if (!batch) throw new MockSendError('Mock 발송 기록을 찾을 수 없습니다.')
    const recipients = await this.database.sendRecipients.where('batchId').equals(batchId).toArray()
    const guardians = new Map((await this.database.guardians.bulkGet(recipients.map((item) => item.guardianId)))
      .filter((item): item is Guardian => Boolean(item)).map((item) => [item.id, item]))
    const check = await this.checkEligibility(batch.docId)
    const views = recipients.map((recipient): MockRecipientView => {
      const guardian = guardians.get(recipient.guardianId)
      return {
        recipient, guardianLabel: guardian?.label ?? '(삭제된 보호자)', maskedPhone: guardian ? maskPhone(guardian.phone) : '—',
        retryable: recipient.requestStatus === 'request_failed' && recipient.retryCount < MAX_MOCK_RETRIES && Boolean(guardian) && check.eligible,
      }
    }).sort((a, b) => a.guardianLabel.localeCompare(b.guardianLabel, 'ko'))
    const count = (status: SendRecipient['requestStatus']) => recipients.filter((item) => item.requestStatus === status).length
    return {
      batch, month: batch.batchKey.slice(0, 7), recipients: views,
      totals: { count: recipients.length, pending: count('pending'), requested: count('requested'), failed: count('request_failed'), delivered: recipients.filter((item) => item.deliveryStatus === 'delivered').length },
      correctionNeeded: !check.eligible, correctionReason: check.eligible ? undefined : check.reason,
    }
  }
}

/** R-27: 연월 + S2 docVersion + 템플릿 코드. */
export function batchKeyOf(doc: Pick<GeneratedDoc, 'yearMonth' | 'docVersion'>): string {
  return `${doc.yearMonth}:doc-v${doc.docVersion}:${MOCK_TEMPLATE_CODE}`
}

export function normalizePhone(value: string): string {
  const match = PHONE_PATTERN.exec(value.trim())
  if (!match) throw new MockSendError('전화번호는 010-0000-0000 형식으로 입력해 주세요.')
  return `010-${match[1]}-${match[2]}`
}

/** 이력·화면에는 끝 4자리만 보인다(E6). */
export function maskPhone(phone: string): string {
  return `010-****-${phone.slice(-4)}`
}

/** 알림톡 미리보기(F5-1 형식). 본문 고정 + 월 변수 1개, 학교명은 템플릿 고정값. */
export function mockAlimtalkText(month: string, schoolName?: string): string {
  return `[${schoolName?.trim() || '데모학교'}] ${Number(month.slice(5))}월 급식 안내입니다. 이달 식단과 알레르기 표시는 아래 버튼에서 확인해 주세요.`
}

export const mockSendService = new MockSendService(db)
