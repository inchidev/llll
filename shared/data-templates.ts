import type { DatabaseFieldType } from './database'

type TemplateField = { name: string; type: DatabaseFieldType; options?: string[] }
export const dataTemplates: Array<{ value: string; label: string; description: string; fields: TemplateField[] }> = [
  { value: 'empty', label: 'Empty database', description: 'Start with a title and add your own fields.', fields: [] },
  { value: 'research', label: 'Research', description: 'Collect sources, findings and review status.', fields: [
    { name: 'Source', type: 'url' }, { name: 'Finding', type: 'text' }, { name: 'Status', type: 'select', options: ['To review', 'Reviewed', 'Useful'] }, { name: 'Tags', type: 'multi_select', options: ['Product', 'Engineering', 'Community'] },
  ] },
  { value: 'contacts', label: 'Contacts', description: 'Keep community contacts and follow-up dates.', fields: [
    { name: 'Email', type: 'email' }, { name: 'Phone', type: 'phone' }, { name: 'Organization', type: 'text' }, { name: 'Follow up', type: 'date' },
  ] },
  { value: 'decisions', label: 'Decision log', description: 'Record decisions, reasoning and owners.', fields: [
    { name: 'Decision', type: 'text' }, { name: 'Reasoning', type: 'text' }, { name: 'Date', type: 'date' }, { name: 'Owner', type: 'person' }, { name: 'Status', type: 'select', options: ['Proposed', 'Accepted', 'Superseded'] },
  ] },
]
export function dataTemplateFields(id: string): TemplateField[] { return dataTemplates.find(template => template.value === id)?.fields ?? [] }
