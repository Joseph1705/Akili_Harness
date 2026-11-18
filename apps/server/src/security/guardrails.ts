/**
 * Guardrails shared by every module that handles untrusted content (documents, e-mails, WhatsApp
 * messages, retrieved knowledge, tool results). Rule 9: content is data, never instructions.
 *
 * Detection is a signal for humans, not a filter we rely on: whatever a document says, amounts come
 * from code, outbound actions need a human, and tools are limited by permissions (DIRECTIVES §3 F).
 */

/** Sentences that try to steer an AI agent: addressed to it, or overriding its rules. */
const STRONG: RegExp[] = [
  /\b(?:agent|ia|ai|assistant|chatgpt|gpt|claude|deepseek|llm|mod[eè]le|robot|bot)\b.{0,40}\b(?:ignore|oublie|ne\s+tiens?\s+pas\s+compte|disregard|forget|override)/i,
  /\bignore[rz]?\b.{0,40}\b(?:tarifs?|contrats?|r[eè]gles?|instructions?|consignes?|montants?|prix|ci-dessus|pr[ée]c[ée]dente?s?)/i,
  /\b(?:ignore|disregard|forget)\b.{0,20}\b(?:all|any|previous|prior|above|the|earlier)\b.{0,20}\b(?:instructions?|rules|prompts?|messages?|context)/i,
  /\b(?:system|syst[eè]me)\s*(?:prompt|message|instructions?)\b/i,
  /\b(?:you\s+are\s+now|from\s+now\s+on\s+you|tu\s+es\s+maintenant|vous\s+[eê]tes\s+maintenant|act\s+as|agis\s+comme|joue\s+le\s+r[oô]le)\b/i,
  /<\/?(?:system|assistant|instructions?|tool_call)>|\[\/?INST\]|<\|im_(?:start|end)\|>/i,
  /\b(?:r[ée]v[eè]le|affiche|donne|communique|reveal|print|show|leak)\b.{0,30}\b(?:cl[ée]s?\s+api|mots?\s+de\s+passe|secrets?|tokens?|api[ _-]?keys?|passwords?|ton\s+prompt|your\s+prompt|instructions?\s+syst[eè]me)\b/i,
  /\b(?:note|message|consigne|instruction)s?\s+(?:pour|[àa]|to|for)\s+(?:l['’]\s*)?(?:agent|ia|ai|assistant|robot|bot)\b/i,
]

/** Pressure to skip controls: suspicious, but also found in honest documents, so only flagged. */
const WEAK: RegExp[] = [
  /\bsans\s+(?:validation|contr[oô]le|v[ée]rification|approbation)\b/i,
  /\b(?:envoie|envoyez|transf[eè]re[zr]?|paie|payez|vire[zr]?|d[ée]bloque[zr]?)\b.{0,40}\b(?:imm[ée]diatement|tout\s+de\s+suite|sans\s+attendre|directement)\b/i,
  /\b(?:without|skip)\s+(?:approval|validation|review|checks?)\b/i,
]

/** True when the text contains instructions aimed at an AI agent, or pressure to skip controls. */
export function suspiciousInstructions(text: string): boolean {
  return STRONG.some(p => p.test(text)) || WEAK.some(p => p.test(text))
}

/** A line that is itself an instruction to the agent: kept out of every extracted field. */
export function isInstructionLine(line: string): boolean {
  return STRONG.some(p => p.test(line))
}

/** Every match, for the reviewer and the logs (short excerpts only). */
export function injectionFindings(text: string): string[] {
  const found: string[] = []
  for (const p of [...STRONG, ...WEAK]) {
    const m = p.exec(text)
    if (m) found.push(m[0].slice(0, 120))
  }
  return found
}
