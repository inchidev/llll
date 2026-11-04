/** What stands for a Server without a picture, the same in the Client and the apps' rail. */
export function serverInitials(name: string): string {
  return name.trim().split(/\s+/u).map(word => word[0]).slice(0, 2).join('').toUpperCase() || 'L'
}
