/** Sign-in, claim and recovery responses must never be cached, including errors. */
export default defineEventHandler((event) => {
  if (getRequestURL(event).pathname.startsWith('/api/')) setHeader(event, 'Cache-Control', 'no-store')
})
