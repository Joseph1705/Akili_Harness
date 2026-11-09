/** User-facing texts. French first, English ready (section 9: no hard-coded strings). */
export type Locale = 'fr' | 'en'

export type MessageKey =
  | 'PLAN_ROUTE_FORBIDDEN'
  | 'EXTERNAL_MODEL_CONSENT_REQUIRED'
  | 'PRICE_UNKNOWN'
  | 'CREDITS_EXHAUSTED'
  | 'LEDGER_UNAVAILABLE'

const MESSAGES: Record<Locale, Record<MessageKey, (p: Record<string, string>) => string>> = {
  fr: {
    PLAN_ROUTE_FORBIDDEN: p => `Le modèle ${p.route} n'est pas inclus dans l'offre ${p.plan}.`,
    EXTERNAL_MODEL_CONSENT_REQUIRED: () =>
      "L'organisation n'a pas encore autorisé l'envoi de données à un fournisseur de modèle externe. Un administrateur doit donner ce consentement dans les paramètres.",
    PRICE_UNKNOWN: p => `Aucun tarif n'est configuré pour ${p.route} : l'appel est bloqué pour ne pas consommer sans facturer.`,
    CREDITS_EXHAUSTED: p => `Crédits épuisés (solde : ${p.balance} crédits). Rechargez votre compte pour continuer.`,
    LEDGER_UNAVAILABLE: () => 'Le registre des crédits est indisponible. Réessayez plus tard ou contactez le support.',
  },
  en: {
    PLAN_ROUTE_FORBIDDEN: p => `The model ${p.route} is not included in the ${p.plan} plan.`,
    EXTERNAL_MODEL_CONSENT_REQUIRED: () =>
      'Your organization has not yet allowed data to be sent to an external model provider. An administrator must give this consent in the settings.',
    PRICE_UNKNOWN: p => `No price is configured for ${p.route}; the call is blocked so nothing is used without being billed.`,
    CREDITS_EXHAUSTED: p => `Credits used up (balance: ${p.balance} credits). Top up your account to continue.`,
    LEDGER_UNAVAILABLE: () => 'The credit ledger is unavailable. Try again later or contact support.',
  },
}

export function message(locale: Locale, key: MessageKey, params: Record<string, string> = {}): string {
  return MESSAGES[locale][key](params)
}
