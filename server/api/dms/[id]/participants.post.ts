import { fail } from '../../../utils/cf'

export default defineEventHandler(async () => {
  fail(410, 'private_channels', 'Direct messages stay between two participants. Create a private channel to include more people.')
})
