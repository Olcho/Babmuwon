import type { BabmuwonDatabase } from '../database'
import type { School } from '../types'

export class SchoolRepository {
  private readonly db: BabmuwonDatabase

  constructor(db: BabmuwonDatabase) { this.db = db }

  get(): Promise<School | undefined> {
    return this.db.schools.get('school')
  }

  async save(school: Omit<School, 'id'>): Promise<void> {
    await this.db.schools.put({ id: 'school', ...school })
  }

  async delete(): Promise<void> {
    await this.db.schools.delete('school')
  }
}
