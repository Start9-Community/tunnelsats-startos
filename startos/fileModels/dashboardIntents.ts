import { FileHelper, z } from '@start9labs/start-sdk'
import { sdk } from '../sdk'

const targetNodeShape = z.enum(['lnd', 'cln', 'eclair'])
/**
 * The wire format bridge.py writes (INTENT_DURATIONS there). Converted to
 * whole months with intentDurationMonths() before reaching the action core.
 */
const durationShape = z.enum(['1m', '3m', '6m', '12m'])
export type IntentDuration = z.infer<typeof durationShape>

export function intentDurationMonths(duration: IntentDuration): number {
  return Number.parseInt(duration, 10)
}

export const dashboardBuyIntentShape = z.looseObject({
  id: z.string(),
  kind: z.literal('buy'),
  createdAt: z.string(),
  /** Set by bridge.py from config.json; the runner falls back to the same. */
  targetNode: targetNodeShape.optional().catch(undefined),
  serverId: z.string(),
  duration: durationShape,
})

export const dashboardRenewIntentShape = z.looseObject({
  id: z.string(),
  kind: z.literal('renew'),
  createdAt: z.string(),
  targetNode: targetNodeShape.optional().catch(undefined),
  duration: durationShape,
})

export const dashboardResetIntentShape = z.looseObject({
  id: z.string(),
  kind: z.literal('reset'),
  createdAt: z.string(),
  targetNode: targetNodeShape.optional().catch(undefined),
})

/**
 * Single-slot per intent kind. Written only by bridge.py (POST /api/intents);
 * read and watched only by the TypeScript intent runner.
 */
export const dashboardIntentsShape = z.looseObject({
  buy: dashboardBuyIntentShape.optional().nullable().catch(null),
  renew: dashboardRenewIntentShape.optional().nullable().catch(null),
  reset: dashboardResetIntentShape.optional().nullable().catch(null),
  /** Recent submissions maintained by bridge.py for its rate limits. */
  history: z
    .array(
      z.looseObject({
        id: z.string(),
        kind: z.enum(['buy', 'renew', 'reset']),
        createdAt: z.string(),
      }),
    )
    .optional()
    .catch(undefined),
})

export const dashboardIntentResultShape = z.looseObject({
  id: z.string(),
  kind: z.enum(['buy', 'renew', 'reset']),
  status: z.enum(['processing', 'succeeded', 'failed']),
  createdAt: z.string(),
  updatedAt: z.string(),
  targetNode: targetNodeShape.optional().catch(undefined),
  paymentHash: z.string().optional().catch(undefined),
  reused: z.boolean().optional().catch(undefined),
  error: z.string().optional().catch(undefined),
})

/**
 * Written only by the TypeScript intent runner (startos/intentRunner.ts);
 * read only by bridge.py (get_dashboard and POST /api/intents).
 */
export const dashboardIntentResultsShape = z.looseObject({
  buy: dashboardIntentResultShape.optional().nullable().catch(null),
  renew: dashboardIntentResultShape.optional().nullable().catch(null),
  reset: dashboardIntentResultShape.optional().nullable().catch(null),
})

export type DashboardIntentKind = 'buy' | 'renew' | 'reset'
export type DashboardBuyIntent = z.infer<typeof dashboardBuyIntentShape>
export type DashboardRenewIntent = z.infer<typeof dashboardRenewIntentShape>
export type DashboardResetIntent = z.infer<typeof dashboardResetIntentShape>
export type DashboardIntentsFile = z.infer<typeof dashboardIntentsShape>
export type DashboardIntentResult = z.infer<typeof dashboardIntentResultShape>
export type DashboardIntentResultsFile = z.infer<
  typeof dashboardIntentResultsShape
>

export const dashboardIntents = FileHelper.json(
  { base: sdk.volumes.main, subpath: './dashboard-intents.json' },
  dashboardIntentsShape,
)

export const dashboardIntentResults = FileHelper.json(
  { base: sdk.volumes.main, subpath: './dashboard-intent-results.json' },
  dashboardIntentResultsShape,
)
