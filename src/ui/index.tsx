import type { ButtonHTMLAttributes, ReactNode } from 'react'

/** 공통 UI 컴포넌트 — 스타일은 App.css의 ds-* 클래스와 index.css 토큰을 쓴다. 비즈니스 로직을 두지 않는다. */

type ButtonVariant = 'primary' | 'secondary' | 'muted' | 'hero' | 'danger'

export function Button({ variant = 'secondary', size = 'md', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md' | 'lg' }) {
  return <button type="button" className={`ds-button ds-button--${variant} ds-button--${size} ${className}`.trim()} {...props} />
}

export function PageHeader({ title, actions, description }: { title: string; actions?: ReactNode; description?: ReactNode }) {
  return <header className="ds-page-header">
    <div><h1>{title}</h1>{description && <p className="ds-page-header__desc">{description}</p>}</div>
    {actions && <div className="ds-page-header__actions">{actions}</div>}
  </header>
}

export function SectionTitle({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return <div className="ds-section-title"><h2>{children}</h2>{actions && <div className="ds-section-title__actions">{actions}</div>}</div>
}

export function Notice({ tone = 'info', children, role }: { tone?: 'info' | 'warning' | 'danger' | 'success'; children: ReactNode; role?: 'status' | 'alert' | 'note' }) {
  return <div className={`ds-notice ds-notice--${tone}`} role={role ?? (tone === 'danger' ? 'alert' : 'status')}>{children}</div>
}

export function Field({ label, hint, children, className = '' }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return <label className={`ds-field ${className}`.trim()}><span className="ds-field__label">{label}</span>{children}{hint && <span className="ds-field__hint">{hint}</span>}</label>
}

export function ToggleChip({ selected, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { selected: boolean }) {
  return <button type="button" aria-pressed={selected} className={`ds-chip${selected ? ' is-selected' : ''}`} {...props}>{children}</button>
}

export function Badge({ tone = 'primary', children }: { tone?: 'primary' | 'danger' | 'neutral' | 'warning' | 'success'; children: ReactNode }) {
  return <span className={`ds-badge ds-badge--${tone}`}>{children}</span>
}

/** Mock 결과·실제 결과를 구분해 보여주는 배지. */
export function MockBadge({ simulated }: { simulated: boolean }) {
  return simulated ? <Badge tone="warning">모의(Mock) 결과</Badge> : <Badge tone="success">실제 AI 응답</Badge>
}
