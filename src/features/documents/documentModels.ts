import type { AllergenNo, DataVersion, DocumentPeriod, ISODateTime, YearMonth } from '../../data'

export interface DocumentHeader {
  generatedAt: ISODateTime
  basedOn: Pick<DataVersion, 'planVersion' | 'studentVersion' | 'substitutionVersion'>
}

export interface S1Row {
  date: string
  weekday: string
  menus: { slot: string; label: string }[]
}

export interface S1Document extends DocumentHeader {
  type: 'S1'
  period: YearMonth
  title: string
  slots: string[]
  rows: S1Row[]
  weeks: { label: string; rows: S1Row[] }[]
  legend: { no: AllergenNo; name: string }[]
}

export interface NarrativeSlot {
  key: 'monthlyNews' | 'nutritionEducation'
  label: string
  state: 'not_generated' | 'draft' | 'approved'
  source: 'router' | 'liner' | 'manual' | 'template'
  text: string
  citations: { title: string; url: string }[]
  simulated?: boolean
  sourceMissing?: boolean
}

export interface S2Document extends DocumentHeader {
  type: 'S2'
  period: YearMonth
  title: string
  issueNo: string
  school: { name: string; motto: string; address: string; phone: string; homepage: string; manager: string }
  greeting: string
  mealTable: Pick<S1Document, 'slots' | 'rows' | 'legend'>
  allergenNotice: string
  contact: string
  narrativeSlots: NarrativeSlot[]
  sendState: 'awaiting_local_s2_state'
}

export interface S3Row {
  date: string
  weekLabel: string
  studentDisplay: string
  originalMenu: string
  substituteMenu: string
  allergenNos: AllergenNo[]
  caution: string
}

export interface S3Document extends DocumentHeader {
  type: 'S3'
  period: YearMonth
  title: string
  rows: S3Row[]
  dailyTotals: { date: string; count: number }[]
}

export interface S4Row {
  date: string
  originalMenu: string
  substituteMenu: string
  allergenNos: AllergenNo[]
}

export interface S4Document extends DocumentHeader {
  type: 'S4'
  period: YearMonth
  title: string
  studentId: string
  recipient: string
  studentAlias: string
  allergens: { no: AllergenNo; name: string }[]
  rows: S4Row[]
  confirmationText: string
}

export interface S5Document extends DocumentHeader {
  type: 'S5'
  period: `${number}`
  title: string
  byAllergen: { allergenNo: AllergenNo; name: string; students: number }[]
  byGrade: { grade: number; students: number }[]
  providedCount: number
  excludedCount: number
  totalStudents: number
  reportText: string
}

export type LocalDocumentArtifact = S1Document | S2Document | S3Document | S4Document | S5Document
export type SupportedDocumentType = LocalDocumentArtifact['type']

export interface StoredDocumentSummary {
  id: string
  type: SupportedDocumentType
  period: DocumentPeriod
  docVersion: number
  status: 'draft' | 'approved' | 'stale' | 'sent'
  generatedAt: string
  current: boolean
  staleReason?: string
}
