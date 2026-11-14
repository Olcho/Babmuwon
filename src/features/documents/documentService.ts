import {
  DocumentRepository, VersionRepository, db,
  type BabmuwonDatabase, type DocumentPeriod, type GeneratedDoc, type YearMonth,
} from '../../data'
import { buildS1Document, buildS3Document, buildS5Document } from './documentBuilders'
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
  async generateS3(period: YearMonth) { return this.persist(await this.buildS3(period)) }
  async generateS5(year: `${number}`) { return this.persist(await this.buildS5(year)) }

  async list(): Promise<GeneratedDoc[]> {
    const docs = await this.documents.getAll()
    return docs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async approve(id: string): Promise<GeneratedDoc> {
    const doc = await this.requireDocument(id)
    if (doc.status === 'stale') throw new DocumentGenerationError('재검토 문서는 최신 데이터로 다시 생성해야 합니다.')
    if (!doc.sourceFingerprint || doc.sourceFingerprint !== await this.currentFingerprint(doc)) {
      await this.markStale(doc, '기준 데이터가 변경되어 재검토가 필요합니다.')
      throw new DocumentGenerationError('기준 데이터가 변경되었습니다. 문서를 다시 생성해 주세요.')
    }
    const at = new Date().toISOString()
    const approved: GeneratedDoc = { ...doc, status: 'approved', approvedAt: at, staleReason: undefined, updatedAt: at }
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

  private async buildS5(year: `${number}`) {
    const [students, allergies, conflicts, substitutions, version] = await Promise.all([
      this.database.students.toArray(), this.database.studentAllergies.toArray(),
      this.database.conflicts.where('date').between(`${year}-01-01`, `${year}-12-31`, true, true).toArray(),
      this.database.substitutions.toArray(), this.versions.get(),
    ])
    return buildS5Document(year, students, allergies, conflicts, substitutions, version, new Date().toISOString())
  }

  private async persist(artifact: LocalDocumentArtifact): Promise<GeneratedDoc> {
    const existing = await this.documents.getByTypeAndMonth(artifact.type, artifact.period)
    const at = artifact.generatedAt
    const doc: GeneratedDoc = {
      id: crypto.randomUUID(), docType: artifact.type, yearMonth: artifact.period,
      docVersion: Math.max(0, ...existing.map((item) => item.docVersion)) + 1,
      basedOn: artifact.basedOn, status: 'draft', correctionNeeded: false,
      createdAt: at, updatedAt: at, generatedAt: at, content: artifact,
      sourceFingerprint: fingerprint(artifact),
    }
    await this.documents.save(doc)
    return doc
  }

  private async currentFingerprint(doc: GeneratedDoc): Promise<string> {
    const artifact = doc.docType === 'S1' ? await this.buildS1(doc.yearMonth as YearMonth)
      : doc.docType === 'S3' ? await this.buildS3(doc.yearMonth as YearMonth)
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

  private async markStale(doc: GeneratedDoc, reason: string) {
    await this.documents.save({ ...doc, status: 'stale', approvedAt: undefined, staleReason: reason, updatedAt: new Date().toISOString() })
  }
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
