import type { BabmuwonDatabase } from '../database'
import type { EntityId, SubstituteMenu, Substitution } from '../types'
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

  async save(substitution: Substitution): Promise<void> {
    if (substitution.status === 'confirmed' && !substitution.checkedProcessed) {
      throw new Error('확인 체크 없이 대체식을 확정할 수 없습니다.')
    }
    await this.db.transaction('rw', this.db.substitutions, this.db.dataVersions, async (transaction) => {
      const previous = await this.db.substitutions.get(substitution.id)
      await this.db.substitutions.put(substitution)
      if (previous?.status !== substitution.status && (previous?.status === 'confirmed' || substitution.status === 'confirmed')) {
        await this.versions.bump('substitutionVersion', transaction)
      }
    })
  }

  async delete(id: EntityId): Promise<void> {
    await this.db.transaction('rw', this.db.substitutions, this.db.dataVersions, async (transaction) => {
      const previous = await this.db.substitutions.get(id)
      await this.db.substitutions.delete(id)
      if (previous?.status === 'confirmed') await this.versions.bump('substitutionVersion', transaction)
    })
  }
}
