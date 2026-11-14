import type { BabmuwonDatabase } from '../database'
import type { DocumentPeriod, DocumentType, EntityId, GeneratedDoc, TextDraft } from '../types'

export class DocumentRepository {
  private readonly db: BabmuwonDatabase

  constructor(db: BabmuwonDatabase) { this.db = db }

  get(id: EntityId) { return this.db.generatedDocs.get(id) }
  getByTypeAndMonth(docType: DocumentType, yearMonth: DocumentPeriod) {
    return this.db.generatedDocs.where('[docType+yearMonth]').equals([docType, yearMonth]).toArray()
  }
  save(doc: GeneratedDoc) { return this.db.generatedDocs.put(doc) }
  getAll() { return this.db.generatedDocs.toArray() }
  delete(id: EntityId) { return this.db.generatedDocs.delete(id) }
  getDrafts(generatedDocId: EntityId) { return this.db.textDrafts.where('generatedDocId').equals(generatedDocId).toArray() }
  saveDraft(draft: TextDraft) { return this.db.textDrafts.put(draft) }

  async markDocumentsStale(ids: EntityId[], reason: string): Promise<number> {
    if (ids.length === 0) return 0
    return this.db.transaction('rw', this.db.generatedDocs, async () => {
      const documents = await this.db.generatedDocs.bulkGet(ids)
      const stale = documents.filter((doc): doc is GeneratedDoc => Boolean(doc && (doc.status === 'approved' || doc.status === 'sent')))
      await this.db.generatedDocs.bulkPut(stale.map((doc) => ({
        ...doc, status: 'stale' as const, approvedAt: undefined, staleReason: reason,
        correctionNeeded: doc.status === 'sent', updatedAt: new Date().toISOString(),
      })))
      return stale.length
    })
  }
}
