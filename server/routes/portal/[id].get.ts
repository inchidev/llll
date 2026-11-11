import { portalPage } from '../../utils/portal-routes'

/** The page a guest opens. It holds no key: the key stays in the link's fragment. */
export default defineEventHandler(event => portalPage(event))
