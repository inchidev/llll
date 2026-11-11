import { portalSocket } from '../../../utils/portal-routes'

/** A guest's socket to a Portal. Its first frame carries the guest key from the page's fragment. */
export default defineEventHandler(event => portalSocket(event))
