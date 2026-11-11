import { portalSocket } from '../../../utils/portal-routes'

/** The host Mac's socket to a Portal. Its first frame carries the host key and the relay protocol version. */
export default defineEventHandler(event => portalSocket(event))
