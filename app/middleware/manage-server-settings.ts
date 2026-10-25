import { Permission } from '~~/shared/permissions'

export default defineNuxtRouteMiddleware(() => guardMemberPermission([
  Permission.manageServer,
  Permission.manageAgents,
  Permission.useAgents,
  Permission.useExternalTools,
  Permission.manageChannels,
  Permission.manageRoles,
  Permission.invite,
  Permission.kick,
]))
