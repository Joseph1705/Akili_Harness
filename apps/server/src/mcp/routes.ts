/** MCP servers and tools of an organization (DIRECTIVES §3 C). Administrators only, every change audited. */
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { audit } from '../audit.js'
import { CAN, orgOf } from '../auth/context.js'
import { HttpError, notFound } from '../errors.js'
import { sealSecret } from '../security/secrets.js'
import { callTool, discoverTools } from './service.js'

export async function mcpRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.deps
  const Id = z.object({ id: z.string().uuid() })

  app.get('/', async (request) => {
    const org = orgOf(request, CAN.configure)
    return {
      servers: await db.all(`SELECT id, name, url, status, last_error, last_discovered_at, created_at, auth_secret IS NOT NULL AS has_token
        FROM mcp_servers WHERE org_id = ? ORDER BY name`, org.id),
      tools: await db.all(`SELECT t.id, t.server_id, t.name, t.description, t.input_schema, t.enabled, t.permission, t.requires_approval, t.updated_at
        FROM mcp_tools t WHERE t.org_id = ? ORDER BY t.name`, org.id),
    }
  })

  app.post('/', async (request) => {
    const org = orgOf(request, CAN.configure)
    const body = z.object({
      name: z.string().trim().min(2).max(60),
      url: z.string().trim().url('Adresse invalide.').max(500),
      token: z.string().trim().max(2000).optional(),
    }).strict().parse(request.body)
    const id = randomUUID()
    try {
      await db.run('INSERT INTO mcp_servers (id, org_id, name, url, auth_secret, created_by) VALUES (?, ?, ?, ?, ?, ?)',
        id, org.id, body.name, body.url, body.token ? sealSecret(config, org.id, `mcp:${id}`, body.token) : null, request.user!.id)
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new HttpError(409, 'duplicate', 'Un serveur porte déjà ce nom.')
      throw error
    }
    await audit(db, { orgId: org.id, userId: request.user!.id }, 'mcp.server_added', 'mcp_server', id, { name: body.name, host: new URL(body.url).host })
    // Discovery right away; a failure leaves the server listed with its error so it can be fixed.
    let tools = 0
    let error: string | null = null
    try { tools = await discoverTools(app, org.id, id) } catch (e) { error = e instanceof Error ? e.message : String(e) }
    return { server: await db.get('SELECT id, name, url, status, last_error FROM mcp_servers WHERE id = ?', id), tools, error }
  })

  app.post('/:id/discover', async (request) => {
    const org = orgOf(request, CAN.configure)
    const { id } = Id.parse(request.params)
    return { tools: await discoverTools(app, org.id, id) }
  })

  app.delete('/:id', async (request) => {
    const org = orgOf(request, CAN.configure)
    const { id } = Id.parse(request.params)
    const changed = await db.run('DELETE FROM mcp_servers WHERE id = ? AND org_id = ?', id, org.id)
    if (changed === 0) throw notFound('Serveur MCP')
    await audit(db, { orgId: org.id, userId: request.user!.id }, 'mcp.server_removed', 'mcp_server', id)
    return { ok: true }
  })

  /** Turn a tool on or off, and set who may use it and whether a person must approve each call. */
  app.patch('/tools/:id', async (request) => {
    const org = orgOf(request, CAN.configure)
    const { id } = Id.parse(request.params)
    const body = z.object({
      enabled: z.boolean(), permission: z.enum(['read', 'operate', 'validate', 'configure']), requires_approval: z.boolean(),
    }).strict().parse(request.body)
    const changed = await db.run('UPDATE mcp_tools SET enabled = ?, permission = ?, requires_approval = ?, updated_at = now() WHERE id = ? AND org_id = ?',
      body.enabled, body.permission, body.requires_approval, id, org.id)
    if (changed === 0) throw notFound('Outil')
    await audit(db, { orgId: org.id, userId: request.user!.id }, 'mcp.tool_updated', 'mcp_tool', id, body)
    return { ok: true }
  })

  /** An administrator tries a tool by hand (a human action: no approval queue). */
  app.post('/tools/:id/call', async (request) => {
    const org = orgOf(request, CAN.configure)
    const { id } = Id.parse(request.params)
    const { arguments: args } = z.object({ arguments: z.record(z.unknown()).default({}) }).strict().parse(request.body ?? {})
    const result = await callTool(app, org.id, id, args)
    await audit(db, { orgId: org.id, userId: request.user!.id }, 'mcp.tool_called', 'mcp_tool', id, { isError: result.isError })
    return result
  })
}
