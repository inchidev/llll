-- A new opt-in policy avoids silently widening existing Coordinator assignments.
INSERT INTO project_policies(id,name,description,permissions_bitmask) VALUES
 ('project-policy-task-coordinator','Task coordinator','Organize project tasks and delegate work to agents. Does not grant computer access or code publication.',337190912);
--> statement-breakpoint
CREATE INDEX agent_runs_root ON agent_runs(COALESCE(json_extract(mandate_json,'$.rootRunId'),id));
