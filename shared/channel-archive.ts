import { Permission } from './permissions'

/**
 * An archived channel keeps its history readable for the people who could already
 * open it, but accepts no new activity: no messages, edits, reactions, pins,
 * Threads, Live rooms or Agent Runs. Its Threads follow it. Only Restore and
 * Delete still change it.
 */
export const CHANNEL_ARCHIVED_CODE = 'channel_archived'
export const CHANNEL_ARCHIVED_MESSAGE = 'This channel is archived. Restore it to post or make changes.'

/** Channel grants an archived channel withholds from everyone, the Server Owner included. */
export const ARCHIVED_CHANNEL_WITHHELD = Permission.sendMessages | Permission.attachFiles | Permission.startLive
