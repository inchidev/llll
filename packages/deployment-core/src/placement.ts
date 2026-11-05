import { cloudflareApi } from './cloudflare-client.js'

export type WorkerPlacement = { region: string } | { mode: 'smart' }

/** APAC spans thousands of kilometres, so its data centers are told apart. */
const REGION_BY_COLO: Record<string, string> = {
  SIN: 'aws:ap-southeast-1',
  HKG: 'aws:ap-east-1',
  NRT: 'aws:ap-northeast-1',
  KIX: 'aws:ap-northeast-3',
  ICN: 'aws:ap-northeast-2',
  BOM: 'aws:ap-south-1',
}

const REGION_BY_D1_REGION: Record<string, string> = {
  APAC: 'aws:ap-southeast-1',
  OC: 'aws:ap-southeast-2',
  WEUR: 'aws:eu-west-3',
  EEUR: 'aws:eu-central-1',
  ENAM: 'aws:us-east-1',
  WNAM: 'aws:us-west-1',
}

export function placementBeside(database: { served_by_colo?: string, served_by_region?: string } = {}): WorkerPlacement {
  const region = REGION_BY_COLO[database.served_by_colo ?? ''] ?? REGION_BY_D1_REGION[database.served_by_region ?? '']
  return region ? { region } : { mode: 'smart' }
}

/**
 * A request makes several trips to its database and one trip to the browser, so a Worker runs beside
 * its database wherever a request enters Cloudflare. D1 says where it is only in a query's result.
 * Not knowing is no reason to stop an install or an update: Smart Placement then decides.
 */
export async function databasePlacement(accessToken: string, accountId: string, databaseId: string): Promise<WorkerPlacement> {
  try {
    const [result] = await cloudflareApi<Array<{ meta?: { served_by_colo?: string, served_by_region?: string } }>>(
      accessToken,
      `/accounts/${accountId}/d1/database/${databaseId}/query`,
      { method: 'POST', body: JSON.stringify({ sql: 'SELECT 1' }) },
    )
    return placementBeside(result?.meta)
  }
  catch {
    return { mode: 'smart' }
  }
}
