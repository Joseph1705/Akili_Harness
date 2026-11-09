/** Session transcript: what the user asked and what the agent did, step by step (design screen A). */
import { randomUUID } from 'node:crypto'
import { now, type Db } from '../db.js'

export type EventRole = 'user' | 'agent' | 'tool' | 'system'

export function addEvent(db: Db, orgId: string, sessionId: string, role: EventRole, content: Record<string, unknown>): void {
  db.prepare('INSERT INTO chat_events (org_id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(orgId, sessionId, role, JSON.stringify(content), now())
  db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ? AND org_id = ?').run(now(), sessionId, orgId)
}

export function createSession(db: Db, orgId: string, userId: string, title: string, agentId: string | null): string {
  const id = randomUUID()
  db.prepare('INSERT INTO chat_sessions (id, org_id, user_id, agent_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, orgId, userId, agentId, title.slice(0, 120), now(), now())
  return id
}
