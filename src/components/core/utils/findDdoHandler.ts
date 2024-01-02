import { OceanP2P, CACHE_TTL, P2P_CONSOLE_LOGGER } from '../../P2P/index.js'
import { FindDDOCommand } from '../../../utils/constants.js'
import { LOG_LEVELS_STR } from '../../../utils/logging/Logger.js'
import { FindDDOResponse } from '../../../@types/index.js'
import { Service } from '../../../@types/DDO/Service.js'

/**
 * Check if the specified ddo is cached and if the cached version is recent enough
 * @param task FindDDO
 * @returns boolean
 */
export function hasCachedDDO(task: FindDDOCommand, node: OceanP2P): boolean {
  if (node.getDDOCache().dht.has(task.id)) {
    // check cache age
    const now: number = new Date().getTime()
    const cacheTime: number = node.getDDOCache().updated
    if (now - cacheTime <= CACHE_TTL) {
      return true
    }
    P2P_CONSOLE_LOGGER.log(
      LOG_LEVELS_STR.LEVEL_INFO,
      `DDO cache for ${task.id} has expired, cache age(secs): ${
        (now - cacheTime) / 1000
      }`,
      true
    )
  }
  return false
}

// 1st result is allways the most recent
export function sortFindDDOResults(resultList: FindDDOResponse[]): FindDDOResponse[] {
  if (resultList.length > 0) {
    return resultList.sort((a: FindDDOResponse, b: FindDDOResponse) => {
      const dateA = new Date(a.lastUpdateTime)
      const dateB = new Date(b.lastUpdateTime)
      if (dateB > dateA) {
        return 1
      } else if (dateB < dateA) {
        return -1
      }
      return 0
    })
  }
  return resultList
}

/**
 * Finds a given DDO on local DB and updates cache if needed
 * @param node this node
 * @param id ddo id
 * @returns ddo info
 */
export async function findDDOLocally(
  node: OceanP2P,
  id: string
): Promise<FindDDOResponse> | undefined {
  const ddo = await node.getDatabase().ddo.retrieve(id)
  if (ddo) {
    // node has ddo

    const ddoInfo: FindDDOResponse = {
      id: ddo.id,
      lastUpdateTx: ddo.event.tx,
      lastUpdateTime: ddo.metadata.updated,
      provider: node.getPeerId()
    }
    // not in the cache yet
    if (!node.getDDOCache().dht.has(ddo.id)) {
      node.getDDOCache().dht.set(ddo.id, ddoInfo)
    } else {
      // it has, just check wich one is newer
      const localCachedData: FindDDOResponse = node.getDDOCache().dht.get(ddo.id)
      // update localCachedData if newer
      if (new Date(ddoInfo.lastUpdateTime) > new Date(localCachedData.lastUpdateTime)) {
        node.getDDOCache().dht.set(ddo.id, ddoInfo)
      }
    }
    return ddoInfo
  }
  return undefined
}

// Function to map and format each service
export function formatService(serviceData: any): Service {
  return {
    id: serviceData.id,
    type: serviceData.type,
    files: serviceData.files,
    datatokenAddress: serviceData.datatokenAddress,
    serviceEndpoint: serviceData.serviceEndpoint,
    timeout: serviceData.timeout,
    name: serviceData.name,
    description: serviceData.description,
    compute: serviceData.compute, // Ensure this matches the ServiceComputeOptions interface
    consumerParameters: serviceData.consumerParameters, // Ensure this matches the ConsumerParameter[] interface
    additionalInformation: serviceData.additionalInformation
  }
}