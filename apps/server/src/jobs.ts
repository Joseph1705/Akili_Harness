/** Background job runner (filled in Task 7). */
import type { FastifyInstance } from 'fastify'

export function startWorker(_app: FastifyInstance): { stop(): void } {
  return { stop() {} }
}
