import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { d1ExecSql } from '../../server/utils/db'
import { mailboxGrantPermissions } from '../../shared/mail'
import { Permission } from '../../shared/permissions'

const sql = (name: string) => d1ExecSql(readFileSync(new URL(`../../drizzle/server-migrations/${name}`, import.meta.url), 'utf8'))
const at = '2026-10-30T00:00:00.000Z'

function beforeResourceGrants() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  for (const name of ['0000_server_baseline.sql', '0001_mail_drafts.sql', '0002_agent_webhooks.sql', '0003_telegram_notifications.sql', '0004_grants.sql']) db.exec(sql(name))
  db.exec(`INSERT INTO roles(id,key,name,permissions_bitmask) VALUES ('r1','custom:r1','R1',0),('r2','custom:r2','R2',0);
    INSERT INTO users(id,kind,display_name,status,role_id,joined_at,created_at,updated_at) VALUES
      ('u1','human','U1','active','r1','${at}','${at}','${at}'),('a1','agent','A1','active','r2','${at}','${at}','${at}');
    INSERT INTO server_identity(singleton,id) VALUES (1,'7c9e6679-7425-40de-944b-e07fc1f90ae7');
    INSERT INTO server(id,name,owner_id,created_at,updated_at) VALUES ('7c9e6679-7425-40de-944b-e07fc1f90ae7','S','u1','${at}','${at}');
    INSERT INTO channels(id,name,topic,type,visibility,position,created_at,updated_at) VALUES
      ('c1','c','','text','server',0,'${at}','${at}'),('m1','mb','','text','private',0,'${at}','${at}');
    INSERT INTO channel_role_overrides(channel_id,role_id,allow_mask,deny_mask) VALUES ('c1','r1',16,32),('c1','r2',0,64);
    INSERT INTO email_domains(id,zone_id,domain,app_hostname,created_at,updated_at) VALUES ('d','z','x.test','a.x.test','${at}','${at}');
    INSERT INTO email_mailboxes(channel_id,domain_id,local_part,display_name,enabled,created_at,updated_at) VALUES ('m1','d','hi','Inbox',1,'${at}','${at}');
    INSERT INTO email_mailbox_access(channel_id,user_id,permission) VALUES ('m1','u1','manage'),('m1','a1','send');
    INSERT INTO gadgets(id,name,description,draft_spec_json,draft_revision,position,created_by,created_at,updated_at) VALUES ('g1','G','','{}',1,0,'u1','${at}','${at}');
    INSERT INTO gadget_versions(id,gadget_id,version,name,description,spec_json,created_by,created_at) VALUES ('gv1','g1',1,'G','','{}','u1','${at}');
    INSERT INTO gadget_draft_role_access VALUES ('g1','r1');
    INSERT INTO gadget_version_role_access VALUES ('gv1','r1'),('gv1','r2');
    INSERT INTO projects(id,name,description,version,created_by,created_at,updated_at) VALUES ('p','P','',1,'u1','${at}','${at}');
    INSERT INTO grants(id,member_id,policy_id,project_id,created_by,created_at) VALUES ('kept','u1','project-policy-developer','p','u1','${at}');
    INSERT INTO mcp_outbound_connections(id,server_id,created_by,name,provider_id,grants_json,tool_names_json,created_at,updated_at)
      VALUES ('k','7c9e6679-7425-40de-944b-e07fc1f90ae7','u1','K','deepwiki','{"agentIds":["a1","gone"],"memberIds":["u1"],"roleIds":["r1","nope"]}','[]','${at}','${at}');`)
  return db
}

describe('resource grants migration', () => {
  it('moves channel, mailbox, App and connection access into grants without changing what the old names read', () => {
    const db = beforeResourceGrants()
    const reads = [
      'SELECT channel_id,role_id,allow_mask,deny_mask FROM channel_role_overrides ORDER BY 1,2',
      'SELECT channel_id,user_id,permission FROM email_mailbox_access ORDER BY 1,2',
      'SELECT gadget_id,role_id FROM gadget_draft_role_access ORDER BY 1,2',
      'SELECT gadget_version_id,role_id FROM gadget_version_role_access ORDER BY 1,2',
      'SELECT id,project_id,policy_id,member_id,role_id FROM project_policy_assignments ORDER BY 1',
    ]
    const before = reads.map(query => db.prepare(query).all())
    db.exec(sql('0005_grants_resources.sql'))
    // The previous release reads the same rows through read-only views during an update.
    expect(reads.map(query => db.prepare(query).all())).toEqual(before)
    expect(() => db.exec("INSERT INTO email_mailbox_access(channel_id,user_id,permission) VALUES ('m1','u1','read')")).toThrow()

    expect(db.prepare('SELECT id,member_id,policy_id,project_id FROM grants WHERE policy_id IS NOT NULL').all())
      .toEqual([{ id: 'kept', member_id: 'u1', policy_id: 'project-policy-developer', project_id: 'p' }])
    expect(db.prepare('SELECT role_id,permissions FROM grants WHERE channel_id=\'c1\'').all()).toEqual([{ role_id: 'r1', permissions: Permission.sendMessages }])
    expect(db.prepare('SELECT role_id,deny_mask FROM channel_role_denies ORDER BY role_id').all())
      .toEqual([{ role_id: 'r1', deny_mask: Permission.attachFiles }, { role_id: 'r2', deny_mask: Permission.startLive }])
    expect(db.prepare('SELECT member_id,permissions FROM grants WHERE mailbox_id=\'m1\' ORDER BY member_id').all())
      .toEqual([{ member_id: 'a1', permissions: mailboxGrantPermissions.send }, { member_id: 'u1', permissions: mailboxGrantPermissions.manage }])
    // Connection grants that named a removed user or Role granted nothing and are dropped.
    expect(db.prepare('SELECT member_id,role_id,permissions,created_by FROM grants WHERE connection_id=\'k\' ORDER BY member_id,role_id').all()).toEqual([
      { member_id: null, role_id: 'r1', permissions: Permission.useExternalTools, created_by: 'u1' },
      { member_id: 'a1', role_id: null, permissions: Permission.useExternalTools, created_by: 'u1' },
      { member_id: 'u1', role_id: null, permissions: Permission.useExternalTools, created_by: 'u1' },
    ])
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    db.close()
  })

  it('keeps each kind of grant to its own shape and removes it with its resource', () => {
    const db = beforeResourceGrants()
    db.exec(sql('0005_grants_resources.sql'))
    const insert = (values: string) => () => db.exec(`INSERT INTO grants(id,member_id,role_id,agent_id,policy_id,permissions,project_id,channel_id,mailbox_id,gadget_id,connection_id,created_at) VALUES ${values}`)
    // A Policy on a resource, two scopes, a permission outside a resource, a Member on a channel.
    expect(insert(`('x',NULL,'r2',NULL,'project-policy-developer',NULL,NULL,'c1',NULL,NULL,NULL,'${at}')`)).toThrow()
    expect(insert(`('x',NULL,'r2',NULL,NULL,16,'p','c1',NULL,NULL,NULL,'${at}')`)).toThrow()
    expect(insert(`('x',NULL,'r2',NULL,NULL,16,'p',NULL,NULL,NULL,NULL,'${at}')`)).toThrow()
    expect(insert(`('x','u1',NULL,NULL,NULL,16,NULL,'c1',NULL,NULL,NULL,'${at}')`)).toThrow()
    // A mailbox level that does not exist, App access beyond Use Apps, a second grant for the same pair.
    expect(insert(`('x','u1',NULL,NULL,NULL,${Permission.sendMail},NULL,NULL,'m1',NULL,NULL,'${at}')`)).toThrow()
    expect(insert(`('x',NULL,'r2',NULL,NULL,${Permission.manageGadgets},NULL,NULL,NULL,'g1',NULL,'${at}')`)).toThrow()
    expect(insert(`('x','u1',NULL,NULL,NULL,${mailboxGrantPermissions.read},NULL,NULL,'m1',NULL,NULL,'${at}')`)).toThrow()
    // Agent access stays on Projects or the whole Server.
    expect(insert(`('x','u1',NULL,'a1',NULL,${Permission.useExternalTools},NULL,NULL,NULL,NULL,'k','${at}')`)).toThrow()

    db.exec("DELETE FROM channels WHERE id='c1'; DELETE FROM email_mailboxes WHERE channel_id='m1'; DELETE FROM gadgets WHERE id='g1'; DELETE FROM mcp_outbound_connections WHERE id='k'")
    expect(db.prepare('SELECT count(*) AS n FROM grants WHERE policy_id IS NULL').get()!.n).toBe(0)
    expect(db.prepare('SELECT count(*) AS n FROM channel_role_denies').get()!.n).toBe(0)
    db.close()
  })
})
