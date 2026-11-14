import { db, type BabmuwonDatabase, type DocumentType, type MealPlan, type YearMonth } from '../../data'
import { MockSendService } from '../sending/mockSendService'

/** SC-01 홈 상태 요약. 저장된 데이터를 읽기만 하며 상태를 바꾸지 않는다. */
export interface HomeSummary {
  month?: YearMonth
  plan?: Pick<MealPlan, 'status' | 'unknownCount' | 'yearMonth'>
  studentCount: number
  documents: { generated: number; total: 5; stale: number; s2Approved: boolean }
  substitutions: { open: number; needsReview: number; unknownMenu: number; total: number }
  sending: { batches: number; requested: number; failed: number; correctionNeeded: boolean }
}

const DOC_TYPES: DocumentType[] = ['S1', 'S2', 'S3', 'S4', 'S5']

export async function loadHomeSummary(database: BabmuwonDatabase = db): Promise<HomeSummary> {
  const plans = (await database.mealPlans.toArray()).sort((a, b) => b.yearMonth.localeCompare(a.yearMonth))
  const plan = plans[0]
  const month = plan?.yearMonth
  const studentCount = await database.students.count()
  const empty: HomeSummary = {
    month, plan, studentCount, documents: { generated: 0, total: 5, stale: 0, s2Approved: false },
    substitutions: { open: 0, needsReview: 0, unknownMenu: 0, total: 0 }, sending: { batches: 0, requested: 0, failed: 0, correctionNeeded: false },
  }
  if (!month) return empty

  const [docs, conflicts, substitutions] = await Promise.all([
    database.generatedDocs.toArray(),
    database.conflicts.where('date').startsWith(month).filter((conflict) => conflict.active !== false).toArray(),
    database.substitutions.toArray(),
  ])
  const monthDocs = docs.filter((doc) => doc.yearMonth === month || (doc.docType === 'S5' && doc.yearMonth === month.slice(0, 4)))
  const latest = DOC_TYPES.flatMap((type) => {
    const versions = monthDocs.filter((doc) => doc.docType === type)
    return versions.length ? [versions.reduce((a, b) => (b.docVersion > a.docVersion ? b : a))] : []
  })
  const substitutionByConflict = new Map(substitutions.map((item) => [item.conflictId, item]))
  const statuses = conflicts.map((conflict) => ({ kind: conflict.kind, status: substitutionByConflict.get(conflict.id)?.status }))

  const history = (await new MockSendService(database).listHistory()).filter((view) => view.month === month)
  return {
    ...empty,
    documents: {
      generated: latest.length, total: 5, stale: latest.filter((doc) => doc.status === 'stale').length,
      s2Approved: latest.some((doc) => doc.docType === 'S2' && doc.status === 'approved'),
    },
    substitutions: {
      total: statuses.length,
      open: statuses.filter((item) => item.kind === 'allergen' && (item.status === 'pending' || item.status === 'needs_review')).length,
      needsReview: statuses.filter((item) => item.status === 'needs_review').length,
      unknownMenu: statuses.filter((item) => item.kind === 'unknown_menu').length,
    },
    sending: {
      batches: history.length,
      requested: history.reduce((sum, view) => sum + view.totals.requested, 0),
      failed: history.reduce((sum, view) => sum + view.totals.failed, 0),
      correctionNeeded: history.some((view) => view.correctionNeeded),
    },
  }
}
