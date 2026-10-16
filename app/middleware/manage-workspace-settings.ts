import { Permission } from '~~/shared/permissions'

export default defineNuxtRouteMiddleware(() => guardMemberPermission([
  Permission.manageWorkspace,
  Permission.manageChannels,
  Permission.manageRoles,
  Permission.invite,
  Permission.kick,
]))
