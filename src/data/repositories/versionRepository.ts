import type { Transaction } from 'dexie'
import type { BabmuwonDatabase } from '../database'
import type { DataVersion, ISODateTime } from '../types'

export type VersionKey = 'planVersion' | 'studentVersion' | 'substitutionVersion'

const initialVersion = (): DataVersion => ({
  id: 'current', planVersion: 0, studentVersion: 0, substitutionVersion: 0,
  updatedAt: new Date().toISOString() as ISODateTime,
})

export class VersionRepository {
  private readonly db: BabmuwonDatabase

  constructor(db: BabmuwonDatabase) { this.db = db }

  async get(): Promise<DataVersion> {
    const current = await this.db.dataVersions.get('current')
    if (current) return current
    const value = initialVersion()
    await this.db.dataVersions.add(value)
    return value
  }

  async bump(key: VersionKey, transaction?: Transaction): Promise<DataVersion> {
    const work = async () => {
      const current = (await this.db.dataVersions.get('current')) ?? initialVersion()
      const next = {
        ...current,
        [key]: current[key] + 1,
        updatedAt: new Date().toISOString() as ISODateTime,
      }
      await this.db.dataVersions.put(next)
      return next
    }
    return transaction ? work() : this.db.transaction('rw', this.db.dataVersions, work)
  }
}
