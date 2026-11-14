import type { BabmuwonDatabase } from '../database'
import type { DocumentType, EntityId, GeneratedDoc, TextDraft, YearMonth } from '../types'

export class DocumentRepository {
  private readonly db: BabmuwonDatabase

  constructor(db: BabmuwonDatabase) { this.db = db }

  get(id: EntityId) { return this.db.generatedDocs.get(id) }
  getByTypeAndMonth(docType: DocumentType, yearMonth: YearMonth) {
    return this.db.generatedDocs.where('[docType+yearMonth]').equals([docType, yearMonth]).toArray()
  }
  save(doc: GeneratedDoc) { return this.db.generatedDocs.put(doc) }
  delete(id: EntityId) { return this.db.generatedDocs.delete(id) }
  getDrafts(generatedDocId: EntityId) { return this.db.textDrafts.where('generatedDocId').equals(generatedDocId).toArray() }
  saveDraft(draft: TextDraft) { return this.db.textDrafts.put(draft) }

  async markOutdatedDocumentsStale(reason: string): Promise<number> {
    const current = await this.db.dataVersions.get('current')
    if (!current) return 0
    return this.db.transaction('rw', this.db.generatedDocs, async () => {
      const approved = await this.db.generatedDocs.where('status').anyOf('approved', 'sent').toArray()
      const stale = approved.filter((doc) => {
        if (doc.basedOn.planVersion !== current.planVersion) return true
        return doc.docType !== 'S1' && doc.docType !== 'S2' && (
          doc.basedOn.studentVersion !== current.studentVersion ||
          doc.basedOn.substitutionVersion !== current.substitutionVersion
        )
      })
      await this.db.generatedDocs.bulkPut(stale.map((doc) => ({
        ...doc, status: 'stale' as const, approvedAt: undefined, staleReason: reason,
        correctionNeeded: doc.status === 'sent', updatedAt: new Date().toISOString(),
      })))
      return stale.length
    })
  }
}
