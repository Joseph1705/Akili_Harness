/** Errors with a stable code and an HTTP status; messages are safe to show (French). */
export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly detail?: Record<string, unknown>) {
    super(message)
  }
}

export const notFound = (what = 'Ressource') => new HttpError(404, 'not_found', `${what} introuvable.`)
export const forbidden = (message = "Vous n'avez pas les droits pour cette action.") => new HttpError(403, 'forbidden', message)
export const badRequest = (message: string, detail?: Record<string, unknown>) => new HttpError(400, 'bad_request', message, detail)
