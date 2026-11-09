/**
 * Credit administration from the command line (prototype; a web page replaces it in phase 1).
 *
 *   tsx plugins/credits/scripts/credits.ts balance <orgId> [--ledger <path>]
 *   tsx plugins/credits/scripts/credits.ts topup <orgId> <credits> --ref <payment ref> [--ledger <path>]
 *   tsx plugins/credits/scripts/credits.ts history <orgId> [--ledger <path>]
 */
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { FileLedger } from '../src/ledger.js'
import { creditsToMilli, milliToCredits } from '../src/pricing.js'

function option(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

async function main(argv: string[]): Promise<number> {
  const [command, orgId, amount] = argv
  const ledgerPath = option(argv, '--ledger') ?? resolve(homedir(), '.akili/credits.jsonl')
  const ledger = new FileLedger(ledgerPath)
  if (!command || !orgId) {
    console.error('usage: credits.ts <balance|topup|history> <orgId> [credits] [--ref <ref>] [--ledger <path>]')
    return 2
  }
  switch (command) {
    case 'balance':
      console.log(`${orgId}: ${milliToCredits(await ledger.balance(orgId)).toFixed(3)} crédits`)
      return 0
    case 'topup': {
      const ref = option(argv, '--ref')
      const credits = Number(amount)
      if (!ref) { console.error('topup needs --ref <payment reference>'); return 2 }
      if (!(credits > 0)) { console.error('topup needs a positive number of credits'); return 2 }
      await ledger.record({ orgId, kind: 'topup', milliCredits: creditsToMilli(credits), ref })
      console.log(`${orgId}: +${credits} crédits → solde ${milliToCredits(await ledger.balance(orgId)).toFixed(3)}`)
      return 0
    }
    case 'history':
      for (const e of await ledger.entries(orgId)) {
        console.log(`${e.at}  ${e.kind.padEnd(6)}  ${milliToCredits(e.milliCredits).toFixed(3).padStart(12)}  ${e.ref}`)
      }
      return 0
    default:
      console.error(`unknown command: ${command}`)
      return 2
  }
}

process.exitCode = await main(process.argv.slice(2))
