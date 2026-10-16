import dayjs from 'dayjs'
import { customAlphabet } from 'nanoid'
import { uuidv7 } from 'uuidv7'

const inviteCode = customAlphabet('abcdefghjkmnpqrstuvwxyz23456789', 8)

/** The only workspace in a L4 installation. */
export const WORKSPACE_ID = 'main'

export function newId(): string {
  return uuidv7()
}

export function newInviteCode(): string {
  return inviteCode()
}

export function nowIso(): string {
  return dayjs().toISOString()
}
