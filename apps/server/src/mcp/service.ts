/**
 * MCP servers of an organization (DIRECTIVES §3 C): connection, discovery of tools (new tools start disabled),
 * argument validation against each tool's schema, and calls. Tool results are data, never instructions.
 */
import type { FastifyInstance } from 'fastify'
import { Ajv, type ValidateFunction } from 'ajv'
import { randomUUID } from 'node:crypto'
import type { Db } from '../db.js'
import { HttpError, notFound } from '../errors.js'
import { openSecret } from '../security/secrets.js'
import { McpClient, McpError } from './client.js'

const ajv = new Ajv({ allErrors: false, strict: false, validateFormats: false })
const validators = new Map<string, ValidateFunction>()

/** Validate arguments against the tool's JSON Schema (compiled once per schema). */
export function validateArguments(schema: Record<string, unknown>, args: unknown): string | null {
  const key = JSON.stringify(schema)
  let validate = validators.get(key)
  if (!validate) {
    try { validate = ajv.compile(schema) } catch { return 'Schéma de l\'outil invalide.' }
    if (validators.size > 500) validators.clear()
    validators.set(key, validate)
  }
  if (validate(args)) return null
  const e = validate.errors?.[0]
  return `Paramètres invalides${e ? ` : ${e.instancePath || 'objet'} ${e.message ?? ''}` : ''}.`.slice(0, 300)
}

interface ServerRow { id: string; org_id: string; name: string; url: string; auth_secret: Buffer | null; status: string }

function client(app: FastifyInstance, server: ServerRow): McpClient {
  const token = server.auth_secret ? openSecret<string>(app.deps.config, server.org_id, `mcp:${server.id}`, server.auth_secret) : null
  return new McpClient({ url: server.url, token, allowPrivate: app.deps.config.mcpAllowPrivate })
}

async function server(db: Db, orgId: string, id: string): Promise<ServerRow> {
  const row = await db.get<ServerRow>('SELECT * FROM mcp_servers WHERE id = ? AND org_id = ?', id, orgId)
  if (!row) throw notFound('Serveur MCP')
  return row
}

/** Connect, list tools, store them. A tool seen for the first time is disabled and requires approval. */
export async function discoverTools(app: FastifyInstance, orgId: string, serverId: string): Promise<number> {
  const { db } = app.deps
  const row = await server(db, orgId, serverId)
  try {
    const mcp = client(app, row)
    await mcp.initialize()
    const tools = await mcp.listTools()
    await db.tx(async tx => {
      const names = tools.map(t => t.name)
      await tx.run('DELETE FROM mcp_tools WHERE server_id = ? AND org_id = ? AND NOT (name = ANY (?::text[]))', serverId, orgId, names)
      for (const t of tools) {
        await tx.run(`INSERT INTO mcp_tools (id, org_id, server_id, name, description, input_schema) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (server_id, name) DO UPDATE SET description = excluded.description, input_schema = excluded.input_schema, updated_at = now()`,
        randomUUID(), orgId, serverId, t.name, t.description ?? null, JSON.stringify(t.inputSchema))
      }
      await tx.run("UPDATE mcp_servers SET status = 'ok', last_error = NULL, last_discovered_at = now() WHERE id = ?", serverId)
    })
    return tools.length
  } catch (error) {
    const message = error instanceof McpError || error instanceof Error ? error.message : String(error)
    await db.run("UPDATE mcp_servers SET status = 'error', last_error = ? WHERE id = ?", message.slice(0, 300), serverId)
    throw new HttpError(502, 'mcp_error', `Connexion au serveur MCP impossible : ${message}`.slice(0, 300))
  }
}

export interface McpToolRow { id: string; server_id: string; server_name: string; name: string; description: string | null; input_schema: Record<string, unknown>; enabled: boolean; permission: 'read' | 'operate' | 'validate' | 'configure'; requires_approval: boolean }

export async function enabledTools(db: Db, orgId: string): Promise<McpToolRow[]> {
  return db.all<McpToolRow>(`SELECT t.id, t.server_id, s.name AS server_name, t.name, t.description, t.input_schema, t.enabled, t.permission, t.requires_approval
    FROM mcp_tools t JOIN mcp_servers s ON s.id = t.server_id AND s.org_id = t.org_id
    WHERE t.org_id = ? AND t.enabled AND s.status = 'ok' ORDER BY s.name, t.name`, orgId)
}

export async function callTool(app: FastifyInstance, orgId: string, toolId: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const { db } = app.deps
  const tool = await db.get<McpToolRow & { server_id: string }>('SELECT * FROM mcp_tools WHERE id = ? AND org_id = ? AND enabled', toolId, orgId)
  if (!tool) throw new HttpError(409, 'tool_disabled', 'Cet outil est désactivé.')
  const invalid = validateArguments(tool.input_schema, args)
  if (invalid) throw new HttpError(400, 'invalid_arguments', invalid)
  const row = await server(db, orgId, tool.server_id)
  if (row.status === 'disabled') throw new HttpError(409, 'server_disabled', 'Ce serveur MCP est désactivé.')
  const mcp = client(app, row)
  try {
    await mcp.initialize()
    return await mcp.callTool(tool.name, args)
  } catch (error) {
    throw new HttpError(502, 'mcp_error', `L'outil n'a pas pu être exécuté : ${error instanceof Error ? error.message : String(error)}`.slice(0, 300))
  }
}
