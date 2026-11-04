import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { mailboxGrantPermissions } from '../../shared/mail'
import { Permission } from '../../shared/permissions'

const at = '2026-10-30T00:00:00.000Z'

function withResourceGrants() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  db.exec(INIT_SQL)
  db.exec(`INSERT INTO roles(id,key,name,permissions_bitmask) VALUES ('r1','custom:r1','R1',0),('r2','custom:r2','R2',0);
    INSERT INTO users(id,kind,display_name,status,role_id,joined_at,created_at,updated_at) VALUES
      ('u1','human','U1','active','r1','${at}','${at}','${at}'),('a1','agent','A1','active','r2','${at}','${at}','${at}');
    INSERT INTO server_identity(singleton,id) VALUES (1,'7c9e6679-7425-40de-944b-e07fc1f90ae7');
    INSERT INTO server(id,name,owner_id,created_at,updated_at) VALUES ('7c9e6679-7425-40de-944b-e07fc1f90ae7','S','u1','${at}','${at}');
    INSERT INTO channels(id,name,topic,type,visibility,position,created_at,updated_at) VALUES
      ('c1','c','','text','server',0,'${at}','${at}'),('m1','mb','','text','private',0,'${at}','${at}');
    INSERT INTO grants(id,role_id,permissions,channel_id,created_at) VALUES ('gc','r1',${Permission.sendMessages},'c1','${at}');
    INSERT INTO channel_role_denies(channel_id,role_id,deny_mask,created_at) VALUES ('c1','r1',${Permission.attachFiles},'${at}'),('c1','r2',${Permission.startLive},'${at}');
    INSERT INTO email_domains(id,zone_id,domain,app_hostname,created_at,updated_at) VALUES ('d','z','x.test','a.x.test','${at}','${at}');
    INSERT INTO email_mailboxes(channel_id,domain_id,local_part,display_name,enabled,created_at,updated_at) VALUES ('m1','d','hi','Inbox',1,'${at}','${at}');
    INSERT INTO grants(id,member_id,permissions,mailbox_id,created_at) VALUES
      ('gm1','u1',${mailboxGrantPermissions.manage},'m1','${at}'),('gm2','a1',${mailboxGrantPermissions.send},'m1','${at}');
    INSERT INTO gadgets(id,name,description,draft_spec_json,draft_revision,position,created_by,created_at,updated_at) VALUES ('g1','G','','{}',1,0,'u1','${at}','${at}');
    INSERT INTO gadget_versions(id,gadget_id,version,name,description,spec_json,created_by,created_at) VALUES ('gv1','g1',1,'G','','{}','u1','${at}');
    INSERT INTO grants(id,role_id,permissions,gadget_id,created_at) VALUES ('gg','r1',${Permission.useGadgets},'g1','${at}');
    INSERT INTO grants(id,role_id,permissions,gadget_version_id,created_at) VALUES ('gv','r1',${Permission.useGadgets},'gv1','${at}'),('gv2','r2',${Permission.useGadgets},'gv1','${at}');
    INSERT INTO projects(id,name,description,version,created_by,created_at,updated_at) VALUES ('p','P','',1,'u1','${at}','${at}');
    INSERT INTO grants(id,member_id,policy_id,project_id,created_by,created_at) VALUES ('kept','u1','project-policy-developer','p','u1','${at}');
    INSERT INTO mcp_outbound_connections(id,server_id,created_by,name,provider_id,tool_names_json,created_at,updated_at)
      VALUES ('k','7c9e6679-7425-40de-944b-e07fc1f90ae7','u1','K','deepwiki','[]','${at}','${at}');
    INSERT INTO grants(id,member_id,permissions,connection_id,created_at) VALUES ('gk','u1',${Permission.useExternalTools},'k','${at}');`)
  return db
}

describe('resource grants', () => {
  it('keeps each kind of grant to its own shape and removes it with its resource', () => {
    const db = withResourceGrants()
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
