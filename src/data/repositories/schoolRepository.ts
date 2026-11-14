import type { BabmuwonDatabase } from '../database'
import type { School } from '../types'

export class SchoolRepository {
  private readonly db: BabmuwonDatabase

  constructor(db: BabmuwonDatabase) { this.db = db }

  get(): Promise<School | undefined> {
    return this.db.schools.get('school')
  }

  async save(school: Omit<School, 'id'>): Promise<void> {
    await this.db.transaction('rw', this.db.schools, this.db.generatedDocs, async () => {
      await this.db.schools.put({ id: 'school', ...school })
      await this.markS2Stale('학교 정보가 변경되어 재검토가 필요합니다.')
    })
  }

  async delete(): Promise<void> {
    await this.db.transaction('rw', this.db.schools, this.db.generatedDocs, async () => {
      await this.db.schools.delete('school')
      await this.markS2Stale('학교 정보가 삭제되어 재검토가 필요합니다.')
    })
  }

  private async markS2Stale(reason: string): Promise<void> {
    const documents = await this.db.generatedDocs.where('status').anyOf('approved', 'sent').filter((doc) => doc.docType === 'S2').toArray()
    const at = new Date().toISOString()
    await this.db.generatedDocs.bulkPut(documents.map((doc) => ({
      ...doc, status: 'stale' as const, approvedAt: undefined, staleReason: reason,
      correctionNeeded: doc.status === 'sent', s2DeliveryState: 'sync_required' as const, updatedAt: at,
    })))
  }
}
