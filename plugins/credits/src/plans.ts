/**
 * Offers and the model routes each one may use.
 *
 * - `solo` (entrepreneur individuel): DeepSeek through the official API route.
 * - `entreprise`: Claude Opus 5.5 through the Anthropic API route.
 *
 * A route is `<provider route>/<model id>` exactly as dsh dispatches it
 * (`GenerateOptions.provider` / `GenerateOptions.model`).
 */

export type PlanId = 'solo' | 'entreprise'

export interface RouteRule {
  /** dsh provider route, e.g. `deepseek-official` or `anthropic`. */
  provider: string
  /** Allowed model ids on that route; `*` allows every model of the route. */
  models: string[]
}

export interface PlanPolicy {
  id: PlanId
  label: string
  routes: RouteRule[]
}

export const DEFAULT_PLANS: Record<PlanId, PlanPolicy> = {
  solo: {
    id: 'solo',
    label: 'Entrepreneur individuel',
    routes: [{ provider: 'deepseek-official', models: ['*'] }],
  },
  entreprise: {
    id: 'entreprise',
    label: 'Entreprise',
    routes: [{ provider: 'anthropic', models: ['claude-opus-5-5'] }],
  },
}

export function isRouteAllowed(plan: PlanPolicy, provider: string, model: string): boolean {
  return plan.routes.some(rule => rule.provider === provider
    && (rule.models.includes('*') || rule.models.includes(model)))
}

export function routeKey(provider: string, model: string): string {
  return `${provider}/${model}`
}
