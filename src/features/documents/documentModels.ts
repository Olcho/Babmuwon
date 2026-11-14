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

export type LocalDocumentArtifact = S1Document | S3Document | S5Document
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
