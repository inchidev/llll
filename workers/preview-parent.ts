/** The staging parent has no public app; only its native PR Previews are routable. */
export default {
  fetch() { return new Response('Not found', { status: 404 }) },
}
