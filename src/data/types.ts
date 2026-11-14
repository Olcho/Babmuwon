export type EntityId = string
export type YearMonth = `${number}-${number}`
export type DocumentPeriod = YearMonth | `${number}`
export type ISODate = string
export type ISODateTime = string
export type AllergenNo = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19

export interface School {
  id: 'school'
  name: string
  principal: string
  manager: string
  phone: string
  headcount: number
  motto?: string
  address?: string
  homepage?: string
}

export interface AllergenItem {
  no: AllergenNo
  name: string
  includes: string[]
}

export interface DataVersion {
  id: 'current'
  planVersion: number
  studentVersion: number
  substitutionVersion: number
  updatedAt: ISODateTime
}

export interface MealPlan {
  id: EntityId
  yearMonth: YearMonth
  status: 'draft' | 'confirmed'
  confirmedAt?: ISODateTime
  sourceFile: string
  unknownCount: number
  createdAt: ISODateTime
  updatedAt: ISODateTime
}

export type AllergenStatus = 'listed' | 'none_confirmed' | 'unknown'

export interface MealEntry {
  id: EntityId
  mealPlanId: EntityId
  date: ISODate
  slot: string
  menuName: string
  allergenStatus: AllergenStatus
  allergenNos: AllergenNo[]
  statusSource: 'excel' | 'manual'
  statusSetAt: ISODateTime
  energy?: number
  protein?: number
}

export interface SubstituteMenu {
  id: EntityId
  name: string
  slot: string
  allergenStatus: AllergenStatus
  allergenNos: AllergenNo[]
  energy?: number
  protein?: number
}

export interface Student {
  id: EntityId
  grade: number
  class: number
  number: number
  alias: string
  realName?: string
  needsSubstitute: boolean
  memo: string
  createdAt: ISODateTime
  updatedAt: ISODateTime
}

export interface StudentAllergy {
  id: EntityId
  studentId: EntityId
  allergenNo: AllergenNo
}

export interface AliasHistory {
  alias: string
  createdAt: ISODateTime
}

export interface Conflict {
  id: EntityId
  date: ISODate
  studentId: EntityId
  mealEntryId: EntityId
  slot?: string
  menuName: string
  kind: 'allergen' | 'unknown_menu'
  allergenNos: AllergenNo[]
  active?: boolean
}

export interface Substitution {
  id: EntityId
  conflictId: EntityId
  substituteName?: string
  substituteAllergenStatus?: Exclude<AllergenStatus, 'unknown'>
  substituteAllergenNos?: AllergenNo[]
  selectionSource?: 'recommended' | 'manual'
  checkedProcessed: boolean
  checkedAt?: ISODateTime
  status: 'pending' | 'confirmed' | 'excludeOnly' | 'needs_review' | 'obsolete'
  basedOn: Pick<DataVersion, 'planVersion' | 'studentVersion'>
  createdAt: ISODateTime
  updatedAt: ISODateTime
}

export interface SubstitutionMemory {
  id: EntityId
  originalMenu: string
  allergenKey: string
  substituteName: string
  count: number
}

export interface Guardian {
  id: EntityId
  label: string
  phone: string
  channelMemberId: string
}

export interface Citation {
  title: string
  url: string
}

export interface ReviewChecklist {
  sourceChecked: boolean
  noMedicalClaim: boolean
  factsChecked: boolean
}

/** Relay AI 응답에서 가져온 상태. 검토 화면에 그대로 표시하며 자동 승인에는 쓰지 않는다. */
export interface AiDraftMeta {
  simulated: boolean
  sourceMissing: boolean
  reviewRequired: boolean
  cached: boolean
  upstream: 'mock' | 'router' | 'search'
}

export interface TextDraft {
  id: EntityId
  generatedDocId?: EntityId
  docType: DocumentType
  field: string
  source: 'router' | 'liner' | 'manual' | 'template'
  text: string
  citations: Citation[]
  edited: boolean
  reviewChecklist: ReviewChecklist
  approved: boolean
  meta?: AiDraftMeta
}

export type DocumentType = 'S1' | 'S2' | 'S3' | 'S4' | 'S5'

export interface GeneratedDoc {
  id: EntityId
  docType: DocumentType
  yearMonth: DocumentPeriod
  docVersion: number
  basedOn: Pick<DataVersion, 'planVersion' | 'studentVersion' | 'substitutionVersion'>
  status: 'draft' | 'approved' | 'stale' | 'sent'
  approvedAt?: ISODateTime
  staleReason?: string
  correctionNeeded: boolean
  createdAt: ISODateTime
  updatedAt: ISODateTime
  generatedAt?: ISODateTime
  sourceFingerprint?: string
  subjectId?: EntityId
  s2DeliveryState?: 'not_connected' | 'sync_required' | 'synced' | 'sync_failed'
  content?: unknown
}

export interface SendBatch {
  id: EntityId
  batchKey: string
  docId: EntityId
  docVersion: number
  templateCode: string
  status: 'requesting' | 'requested' | 'partial' | 'closed' | 'manual'
  createdAt: ISODateTime
  /** true면 로컬 Mock 시연 기록. 실제 채널톡·알림톡으로 보내지 않았다. */
  simulated?: boolean
  updatedAt?: ISODateTime
}

export interface SendAttempt {
  at: ISODateTime
  result: 'requested' | 'request_failed'
  errorCode?: string
}

export interface SendRecipient {
  id: EntityId
  batchId: EntityId
  guardianId: EntityId
  requestStatus: 'pending' | 'requested' | 'request_failed'
  deliveryStatus: 'unknown' | 'delivered' | 'failed'
  deliveryCheckedBy?: 'manual' | 'api'
  errorCode?: string
  retryCount: number
  /** 모든 시도 이력(F5-6). */
  attempts?: SendAttempt[]
  updatedAt?: ISODateTime
}

export interface ApiCallLog {
  id: EntityId
  at: ISODateTime
  endpoint: string
  allowedFields: Record<string, unknown>
  status: 'ok' | 'blocked' | 'error' | 'cached'
}

export interface ApiCache {
  queryHash: string
  response: unknown
  createdAt: ISODateTime
}
