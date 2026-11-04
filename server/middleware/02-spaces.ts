import { recordingUploadProblem } from '../utils/recording-keys'
import { enforceRoutePolicy } from '../utils/route-gate'

export default defineEventHandler(async (event) => {
  try {
    await enforceRoutePolicy(event)
  }
  catch (error) {
    const problem = recordingUploadProblem(event, error)
    if (problem) return problem
    throw error
  }
})
