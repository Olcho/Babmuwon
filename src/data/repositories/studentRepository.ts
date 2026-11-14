import type { BabmuwonDatabase } from '../database'
import type { AllergenNo, EntityId, Student, StudentAllergy } from '../types'
import { VersionRepository } from './versionRepository'

export class StudentRepository {
  private readonly db: BabmuwonDatabase
  private readonly versions: VersionRepository
  constructor(db: BabmuwonDatabase) {
    this.db = db
    this.versions = new VersionRepository(db)
  }

  get(id: EntityId) { return this.db.students.get(id) }
  getAll() { return this.db.students.toArray() }
  getAllergies(studentId: EntityId) { return this.db.studentAllergies.where('studentId').equals(studentId).toArray() }

  async save(student: Student, allergenNos: AllergenNo[]): Promise<void> {
    await this.db.transaction('rw', this.db.students, this.db.studentAllergies, this.db.dataVersions, async (transaction) => {
      await this.db.students.put(student)
      await this.db.studentAllergies.where('studentId').equals(student.id).delete()
      const allergies: StudentAllergy[] = allergenNos.map((allergenNo) => ({
        id: `${student.id}:${allergenNo}`, studentId: student.id, allergenNo,
      }))
      await this.db.studentAllergies.bulkPut(allergies)
      await this.versions.bump('studentVersion', transaction)
    })
  }

  async delete(id: EntityId): Promise<void> {
    await this.db.transaction('rw', this.db.students, this.db.studentAllergies, this.db.dataVersions, async (transaction) => {
      await this.db.studentAllergies.where('studentId').equals(id).delete()
      await this.db.students.delete(id)
      await this.versions.bump('studentVersion', transaction)
    })
  }
}
