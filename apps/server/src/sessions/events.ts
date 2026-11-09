/** Session transcript: what the user asked and what the agent did, step by step (design screen A). */
import { randomUUID } from 'node:crypto'
import type { Db } from '../db.js'

export type EventRole = 'user' | 'agent' | 'tool' | 'system'

export async function addEvent(db: Db, orgId: string, sessionId: string, role: EventRole, content: Record<string, unknown>): Promise<void> {
  await db.run('INSERT INTO chat_events (org_id, session_id, role, content) VALUES (?, ?, ?, ?)', orgId, sessionId, role, JSON.stringify(content))
  await db.run('UPDATE chat_sessions SET updated_at = now() WHERE id = ? AND org_id = ?', sessionId, orgId)
}

export async function createSession(db: Db, orgId: string, userId: string, title: string, agentId: string | null): Promise<string> {
  const id = randomUUID()
  await db.run('INSERT INTO chat_sessions (id, org_id, user_id, agent_id, title) VALUES (?, ?, ?, ?, ?)', id, orgId, userId, agentId, title.slice(0, 120))
  return id
}
