import { Permission } from '~~/shared/permissions'

export default defineNuxtRouteMiddleware(() => guardMemberPermission([
  Permission.manageServer,
  Permission.manageChannels,
  Permission.manageRoles,
  Permission.invite,
  Permission.kick,
]))
