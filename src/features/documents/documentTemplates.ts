import type { S2Document, S4Document } from './documentModels'

export function renderS4PrintableHtml(document: S4Document): string {
  return `<article class="pdf-sheet"><h1>${escapeHtml(document.title)}</h1><p>${escapeHtml(document.recipient)}</p><p>대상 알레르기: ${document.allergens.map((item) => `${item.no}. ${item.name}`).map(escapeHtml).join(', ')}</p><p>${escapeHtml(document.confirmationText)}</p><table><thead><tr><th>날짜</th><th>기존 메뉴</th><th>확정 대체 메뉴</th><th>충돌 번호</th></tr></thead><tbody>${document.rows.map((row) => `<tr><td>${escapeHtml(row.date)}</td><td>${escapeHtml(row.originalMenu)}</td><td>${escapeHtml(row.substituteMenu)}</td><td>${escapeHtml(row.allergenNos.join('.'))}</td></tr>`).join('')}</tbody></table><footer>생성 ${escapeHtml(document.generatedAt)} · 기준 버전 ${document.basedOn.planVersion}/${document.basedOn.studentVersion}/${document.basedOn.substitutionVersion}</footer></article>`
}

export function renderS2NarrativeState(document: S2Document): string {
  return document.narrativeSlots.map((slot) => `${slot.label}: ${slot.state === 'not_generated' ? 'AI 문구 미생성' : slot.text}`).join('\n')
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}
