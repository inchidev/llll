import { fail } from './cf'

/** Keep database constraint details out of clients; ordinary failures still propagate. */
export async function dataNameWrite<T>(write: () => Promise<T>): Promise<T> {
  try { return await write() }
  catch (error) {
    const message = error instanceof Error ? `${error.message} ${error.cause instanceof Error ? error.cause.message : ''}` : ''
    if (/UNIQUE constraint failed.*(?:documents_title_unique|database_definitions_name_unique|documents\.title|database_definitions\.name)/iu.test(message)) {
      fail(409, 'duplicate_name', 'This name is already in use, including in Trash')
    }
    throw error
  }
}
