import {
  DocumentRepository, VersionRepository, db,
  type BabmuwonDatabase, type DocumentPeriod, type GeneratedDoc, type YearMonth,
} from '../../data'
import { buildS1Document, buildS2Document, buildS3Document, buildS4Documents, buildS5Document } from './documentBuilders'
import type { LocalDocumentArtifact, SupportedDocumentType } from './documentModels'

export class DocumentGenerationError extends Error {}

export class DocumentService {
  private readonly database: BabmuwonDatabase
  private readonly documents: DocumentRepository
  private readonly versions: VersionRepository

  constructor(database: BabmuwonDatabase) {
    this.database = database
    this.documents = new DocumentRepository(database)
    this.versions = new VersionRepository(database)
  }

  async generateS1(period: YearMonth) { return this.persist(await this.buildS1(period)) }
  async generateS2(period: YearMonth) { return this.persist(await this.buildS2(period)) }
  async generateS3(period: YearMonth) { return this.persist(await this.buildS3(period)) }
  async generateS4(period: YearMonth) {
    const result = await this.buildS4(period)
    const documents = []
    for (const artifact of result.documents) documents.push(await this.persist(artifact))
    return { documents, blockedStudentIds: result.blockedStudentIds }
  }
  async generateS5(year: `${number}`) { return this.persist(await this.buildS5(year)) }

  async list(): Promise<GeneratedDoc[]> {
    const docs = await this.documents.getAll()
    return docs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async approve(id: string): Promise<GeneratedDoc> {
    const doc = await this.requireDocument(id)
    if (doc.status === 'stale') throw new DocumentGenerationError('재검토 문서는 최신 데이터로 다시 생성해야 합니다.')
    if (doc.docType === 'S2') {
      const artifact = doc.content as LocalDocumentArtifact | undefined
      if (!artifact || artifact.type !== 'S2' || artifact.narrativeSlots.some((slot) => slot.state !== 'approved')) {
        throw new DocumentGenerationError('AI 문구가 아직 생성·검토되지 않아 S2를 승인할 수 없습니다.')
      }
    }
    if (!doc.sourceFingerprint || doc.sourceFingerprint !== await this.currentFingerprint(doc)) {
      await this.markStale(doc, '기준 데이터가 변경되어 재검토가 필요합니다.')
      throw new DocumentGenerationError('기준 데이터가 변경되었습니다. 문서를 다시 생성해 주세요.')
    }
    const at = new Date().toISOString()
    const approved: GeneratedDoc = { ...doc, status: 'approved', approvedAt: at, staleReason: undefined, updatedAt: at,
      s2DeliveryState: doc.docType === 'S2' ? 'sync_required' : doc.s2DeliveryState }
    await this.documents.save(approved)
    return approved
  }

  async getArtifact(id: string): Promise<LocalDocumentArtifact> {
    const doc = await this.requireDocument(id)
    if (!doc.content) throw new DocumentGenerationError('이전 형식 문서에는 미리보기 데이터가 없습니다.')
    return doc.content as LocalDocumentArtifact
  }

  private async buildS1(period: YearMonth) {
    const plan = await this.database.mealPlans.where('yearMonth').equals(period).first()
    if (!plan || plan.status !== 'confirmed') throw new DocumentGenerationError('확정된 월간 식단이 필요합니다.')
    const [entries, version] = await Promise.all([
      this.database.mealEntries.where('mealPlanId').equals(plan.id).toArray(), this.versions.get(),
    ])
    return buildS1Document(period, entries, version, new Date().toISOString())
  }

  private async buildS2(period: YearMonth) {
    const plan = await this.database.mealPlans.where('yearMonth').equals(period).first()
    if (!plan || plan.status !== 'confirmed') throw new DocumentGenerationError('확정된 월간 식단이 필요합니다.')
    const [entries, school, version] = await Promise.all([
      this.database.mealEntries.where('mealPlanId').equals(plan.id).toArray(), this.database.schools.get('school'), this.versions.get(),
    ])
    return buildS2Document(period, entries, school, version, new Date().toISOString())
  }

  private async buildS3(period: YearMonth) {
    const plan = await this.database.mealPlans.where('yearMonth').equals(period).first()
    if (!plan || plan.status !== 'confirmed') throw new DocumentGenerationError('확정된 월간 식단이 필요합니다.')
    const [conflicts, substitutions, students, version] = await Promise.all([
      this.database.conflicts.where('date').between(`${period}-01`, `${period}-31`, true, true).toArray(),
      this.database.substitutions.toArray(), this.database.students.toArray(), this.versions.get(),
    ])
    try { return buildS3Document(period, conflicts, substitutions, students, version, new Date().toISOString()) }
    catch (error) { throw new DocumentGenerationError(error instanceof Error ? error.message : '작업표를 생성하지 못했습니다.') }
  }

  private async buildS4(period: YearMonth) {
    const plan = await this.database.mealPlans.where('yearMonth').equals(period).first()
    if (!plan || plan.status !== 'confirmed') throw new DocumentGenerationError('확정된 월간 식단이 필요합니다.')
    const [conflicts, substitutions, students, allergies, version] = await Promise.all([
      this.database.conflicts.where('date').between(`${period}-01`, `${period}-31`, true, true).toArray(),
      this.database.substitutions.toArray(), this.database.students.toArray(), this.database.studentAllergies.toArray(), this.versions.get(),
    ])
    return buildS4Documents(period, conflicts, substitutions, students, allergies, version, new Date().toISOString())
  }

  private async buildS5(year: `${number}`) {
    const [students, allergies, conflicts, substitutions, version] = await Promise.all([
      this.database.students.toArray(), this.database.studentAllergies.toArray(),
      this.database.conflicts.where('date').between(`${year}-01-01`, `${year}-12-31`, true, true).toArray(),
      this.database.substitutions.toArray(), this.versions.get(),
    ])
    return buildS5Document(year, students, allergies, conflicts, substitutions, version, new Date().toISOString())
  }

  private async persist(artifact: LocalDocumentArtifact): Promise<GeneratedDoc> {
    const subjectId = artifact.type === 'S4' ? artifact.studentId : undefined
    const existing = (await this.documents.getByTypeAndMonth(artifact.type, artifact.period)).filter((item) => item.subjectId === subjectId)
    const at = artifact.generatedAt
    const doc: GeneratedDoc = {
      id: crypto.randomUUID(), docType: artifact.type, yearMonth: artifact.period,
      docVersion: Math.max(0, ...existing.map((item) => item.docVersion)) + 1,
      basedOn: artifact.basedOn, status: 'draft', correctionNeeded: false,
      createdAt: at, updatedAt: at, generatedAt: at, content: artifact,
      sourceFingerprint: fingerprint(artifact),
      subjectId,
      s2DeliveryState: artifact.type === 'S2' ? 'not_connected' : undefined,
    }
    await this.documents.save(doc)
    return doc
  }

  /** 저장된 문서가 현재 로컬 데이터(확정 식단·학교 정보 등)로 다시 만든 결과와 같은지 확인한다. */
  async isCurrent(doc: GeneratedDoc): Promise<boolean> {
    if (!doc.sourceFingerprint) return false
    try { return doc.sourceFingerprint === await this.currentFingerprint(doc) }
    catch { return false }
  }

  /** 승인본이 더는 최신이 아니면 stale 처리한다. S2는 Relay에 무효화를 다시 보고해야 하므로 sync_required로 둔다. */
  async invalidate(id: string, reason: string): Promise<GeneratedDoc> {
    const doc = await this.requireDocument(id)
    return this.markStale(doc, reason)
  }

  private async currentFingerprint(doc: GeneratedDoc): Promise<string> {
    const artifact = doc.docType === 'S1' ? await this.buildS1(doc.yearMonth as YearMonth)
      : doc.docType === 'S2' ? await this.buildS2(doc.yearMonth as YearMonth)
      : doc.docType === 'S3' ? await this.buildS3(doc.yearMonth as YearMonth)
        : doc.docType === 'S4' ? (await this.buildS4(doc.yearMonth as YearMonth)).documents.find((item) => item.studentId === doc.subjectId)
        : doc.docType === 'S5' ? await this.buildS5(doc.yearMonth as `${number}`)
          : undefined
    if (!artifact) return ''
    return fingerprint({ ...artifact, generatedAt: doc.generatedAt ?? doc.createdAt })
  }

  private async requireDocument(id: string) {
    const doc = await this.documents.get(id)
    if (!doc) throw new DocumentGenerationError('문서를 찾을 수 없습니다.')
    return doc
  }

  private async markStale(doc: GeneratedDoc, reason: string): Promise<GeneratedDoc> {
    const stale: GeneratedDoc = {
      ...doc, status: 'stale', approvedAt: undefined, staleReason: reason, updatedAt: new Date().toISOString(),
      s2DeliveryState: doc.docType === 'S2' && doc.s2DeliveryState !== 'not_connected' ? 'sync_required' : doc.s2DeliveryState,
    }
    await this.documents.save(stale)
    return stale
  }
}

export function isS2SendEligible(doc: GeneratedDoc): boolean {
  return doc.docType === 'S2' && doc.status === 'approved' && doc.s2DeliveryState === 'synced'
}

function fingerprint(value: object): string {
  const text = JSON.stringify(value, (key, item) => ['generatedAt', 'basedOn'].includes(key) ? undefined : item && typeof item === 'object' && !Array.isArray(item)
    ? Object.keys(item).sort().reduce<Record<string, unknown>>((result, key) => { result[key] = item[key]; return result }, {}) : item)
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619)
  return (hash >>> 0).toString(16)
}

export const documentService = new DocumentService(db)
export type { DocumentPeriod, SupportedDocumentType }
