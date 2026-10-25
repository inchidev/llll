/** Exact human-approved publication; tool execution approvals are separate. */
export type RunPublication = {
  id: string; digest: string; status: 'pending' | 'rejected' | 'expired' | 'executing' | 'completed' | 'uncertain'
  content: string; channelId: string; channelName: string; audience: string
  expiresAt: string; decidedAt: string | null; decidedBy: string | null; messageId: string
}
