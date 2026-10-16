import { Permission } from '~~/shared/permissions'

export default defineNuxtRouteMiddleware(() => guardMemberPermission([Permission.useGadgets, Permission.manageGadgets]))
