import type { BabmuwonDatabase } from '../database'
import type { EntityId, SubstituteMenu, Substitution, SubstitutionMemory } from '../types'
import { VersionRepository } from './versionRepository'

export class SubstitutionRepository {
  private readonly db: BabmuwonDatabase
  private readonly versions: VersionRepository
  constructor(db: BabmuwonDatabase) {
    this.db = db
    this.versions = new VersionRepository(db)
  }

  get(id: EntityId) { return this.db.substitutions.get(id) }
  getByStatus(status: Substitution['status']) { return this.db.substitutions.where('status').equals(status).toArray() }
  getMenus() { return this.db.substituteMenus.toArray() }
  saveMenu(menu: SubstituteMenu) { return this.db.substituteMenus.put(menu) }
  deleteMenu(id: EntityId) { return this.db.substituteMenus.delete(id) }

  async save(
    substitution: Substitution,
    memory?: Pick<SubstitutionMemory, 'originalMenu' | 'allergenKey' | 'substituteName'>,
  ): Promise<void> {
    if (substitution.status === 'confirmed' && !substitution.checkedProcessed) {
      throw new Error('확인 체크 없이 대체식을 확정할 수 없습니다.')
    }
    await this.db.transaction(
      'rw',
      [
        this.db.substitutions, this.db.dataVersions, this.db.conflicts,
        this.db.substitutionMemories, this.db.generatedDocs,
      ],
      async (transaction) => {
      const previous = await this.db.substitutions.get(substitution.id)
      await this.db.substitutions.put(substitution)
      if (isConfirmedResultChanged(previous, substitution)) {
        const version = await this.versions.bump('substitutionVersion', transaction)
        const conflict = await this.db.conflicts.get(substitution.conflictId)
        if (conflict) await this.markDocumentsStale(conflict.date.slice(0, 7), version.substitutionVersion, substitution.updatedAt)
        if (substitution.status === 'confirmed' && memory) await this.remember(memory)
      }
      },
    )
  }

  async delete(id: EntityId): Promise<void> {
    await this.db.transaction(
      'rw',
      [this.db.substitutions, this.db.dataVersions, this.db.conflicts, this.db.generatedDocs],
      async (transaction) => {
      const previous = await this.db.substitutions.get(id)
      await this.db.substitutions.delete(id)
      if (previous?.status === 'confirmed') {
        const version = await this.versions.bump('substitutionVersion', transaction)
        const conflict = await this.db.conflicts.get(previous.conflictId)
        if (conflict) await this.markDocumentsStale(conflict.date.slice(0, 7), version.substitutionVersion, new Date().toISOString())
      }
      },
    )
  }

  private async remember(memory: Pick<SubstitutionMemory, 'originalMenu' | 'allergenKey' | 'substituteName'>): Promise<void> {
    const id = `${memory.originalMenu}\u0000${memory.allergenKey}\u0000${memory.substituteName}`
    const previous = await this.db.substitutionMemories.get(id)
    await this.db.substitutionMemories.put({ id, ...memory, count: (previous?.count ?? 0) + 1 })
  }

  private async markDocumentsStale(yearMonth: string, substitutionVersion: number, updatedAt: string): Promise<void> {
    const documents = await this.db.generatedDocs.where('status').anyOf('approved', 'sent').toArray()
    const affected = documents.filter((document) =>
      document.yearMonth === yearMonth && ['S3', 'S4', 'S5'].includes(document.docType)
      && document.basedOn.substitutionVersion !== substitutionVersion,
    )
    await this.db.generatedDocs.bulkPut(affected.map((document) => ({
      ...document,
      status: 'stale' as const,
      approvedAt: undefined,
      staleReason: `${yearMonth} 대체식 정보가 변경되어 재검토가 필요합니다.`,
      correctionNeeded: document.status === 'sent',
      updatedAt,
    })))
  }
}

function isConfirmedResultChanged(previous: Substitution | undefined, next: Substitution): boolean {
  if (!previous) return next.status === 'confirmed'
  if (previous.status !== next.status) return previous.status === 'confirmed' || next.status === 'confirmed'
  if (next.status !== 'confirmed') return false
  return previous.substituteName !== next.substituteName
    || previous.substituteAllergenStatus !== next.substituteAllergenStatus
    || JSON.stringify(previous.substituteAllergenNos ?? []) !== JSON.stringify(next.substituteAllergenNos ?? [])
}
