export const LAB_SQL = `
CREATE TABLE IF NOT EXISTS lab_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
INSERT OR IGNORE INTO lab_meta VALUES ('schema','1'),('resource_barrier',''),('collection_gate','CLOSED');
CREATE TABLE IF NOT EXISTS lab_admin_tokens(token_hash TEXT PRIMARY KEY,csrf TEXT NOT NULL,expires_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS lab_studies(study_id TEXT PRIMARY KEY,title TEXT NOT NULL,draft TEXT NOT NULL,
 revision INTEGER NOT NULL,admission TEXT NOT NULL CHECK(admission IN ('OPEN','PAUSED')),created_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS lab_versions(version_id TEXT PRIMARY KEY,study_id TEXT NOT NULL REFERENCES lab_studies,
 hash TEXT NOT NULL,protocol TEXT NOT NULL,runner_hash TEXT NOT NULL,runner_version TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS lab_questionnaire_sources(study_id TEXT PRIMARY KEY REFERENCES lab_studies,source TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS lab_archived_studies(study_id TEXT PRIMARY KEY REFERENCES lab_studies,archived_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS lab_packages(study_id TEXT NOT NULL REFERENCES lab_studies,name TEXT NOT NULL,hash TEXT NOT NULL,job_id TEXT NOT NULL,PRIMARY KEY(study_id,name)) STRICT;
CREATE TABLE IF NOT EXISTS lab_package_images(study_id TEXT NOT NULL,name TEXT NOT NULL,path TEXT NOT NULL,asset_id TEXT NOT NULL REFERENCES lab_assets,PRIMARY KEY(study_id,name,path),FOREIGN KEY(study_id,name) REFERENCES lab_packages(study_id,name)) STRICT;
CREATE TABLE IF NOT EXISTS lab_covariates(session_id TEXT NOT NULL REFERENCES lab_sessions,sample_id TEXT NOT NULL,hash TEXT NOT NULL,raw TEXT NOT NULL,source TEXT NOT NULL,received_at INTEGER NOT NULL,PRIMARY KEY(session_id,sample_id)) STRICT;
CREATE TABLE IF NOT EXISTS lab_consents(session_id TEXT PRIMARY KEY REFERENCES lab_sessions,document_hash TEXT NOT NULL,accepted_at INTEGER NOT NULL) STRICT;
CREATE TRIGGER IF NOT EXISTS lab_consents_update BEFORE UPDATE ON lab_consents BEGIN SELECT RAISE(ABORT,'immutable consent'); END;
CREATE TRIGGER IF NOT EXISTS lab_consents_delete BEFORE DELETE ON lab_consents BEGIN SELECT RAISE(ABORT,'immutable consent'); END;
CREATE TRIGGER IF NOT EXISTS lab_covariates_update BEFORE UPDATE ON lab_covariates BEGIN SELECT RAISE(ABORT,'immutable covariates'); END;
CREATE TRIGGER IF NOT EXISTS lab_covariates_delete BEFORE DELETE ON lab_covariates BEGIN SELECT RAISE(ABORT,'immutable covariates'); END;
CREATE TABLE IF NOT EXISTS lab_assets(asset_id TEXT PRIMARY KEY,study_id TEXT NOT NULL REFERENCES lab_studies,name TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('UPLOADING','READY','FAILED','DELETING','PURGED')),hash TEXT,bytes INTEGER,width INTEGER,height INTEGER,format TEXT,
 upload_id TEXT UNIQUE NOT NULL,created_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS lab_asset_refs(asset_id TEXT NOT NULL REFERENCES lab_assets,kind TEXT NOT NULL,owner TEXT NOT NULL,
 PRIMARY KEY(asset_id,kind,owner)) STRICT;
CREATE TABLE IF NOT EXISTS lab_pins(asset_id TEXT NOT NULL REFERENCES lab_assets,job_id TEXT NOT NULL,PRIMARY KEY(asset_id,job_id)) STRICT;
CREATE TABLE IF NOT EXISTS lab_requests(subject TEXT NOT NULL,operation TEXT NOT NULL,request_id TEXT NOT NULL,hash TEXT NOT NULL,response TEXT,
 PRIMARY KEY(subject,operation,request_id)) STRICT;
CREATE TABLE IF NOT EXISTS lab_sessions(session_id TEXT PRIMARY KEY,study_id TEXT NOT NULL REFERENCES lab_studies,
 version_id TEXT NOT NULL REFERENCES lab_versions,admission_id TEXT UNIQUE NOT NULL,credential_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('CREATED','ACTIVE','FINALIZING','COMPLETED','TERMINATED')),writer_id TEXT,writer_epoch INTEGER NOT NULL DEFAULT 0,
 lease_until INTEGER NOT NULL DEFAULT 0,page_index INTEGER NOT NULL DEFAULT 0,group_index INTEGER NOT NULL DEFAULT 0,
 answers TEXT NOT NULL DEFAULT '{}',path TEXT NOT NULL DEFAULT '[]',allocation_id TEXT,completion TEXT,created_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS lab_writers(session_id TEXT NOT NULL REFERENCES lab_sessions,epoch INTEGER NOT NULL,writer_id TEXT NOT NULL,
 PRIMARY KEY(session_id,epoch)) STRICT;
CREATE TABLE IF NOT EXISTS lab_session_queue(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT UNIQUE NOT NULL REFERENCES lab_sessions,
 ticket_id TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('QUEUED','ACTIVE','EXPIRED','LEFT','ENDED')),lease_until INTEGER NOT NULL) STRICT;
CREATE INDEX IF NOT EXISTS lab_session_queue_status ON lab_session_queue(status,ordinal);
CREATE TABLE IF NOT EXISTS lab_slots(slot_id TEXT PRIMARY KEY,version_id TEXT NOT NULL REFERENCES lab_versions,
 block_id TEXT NOT NULL,ordinal INTEGER NOT NULL,variant_id TEXT NOT NULL,seed TEXT NOT NULL,session_id TEXT,reservation_id TEXT,
 reserved_until INTEGER,allocation_id TEXT UNIQUE,UNIQUE(version_id,block_id,ordinal)) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS lab_one_allocation ON lab_slots(session_id) WHERE allocation_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS lab_permits(permit_id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES lab_sessions,scope TEXT NOT NULL,
 group_id TEXT NOT NULL,writer_epoch INTEGER NOT NULL,plan TEXT NOT NULL,plan_hash TEXT NOT NULL,readiness TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('ISSUED','CLOSED_NORMAL','CLOSED_TERMINATED','CLOSED_UNKNOWN')),UNIQUE(session_id,scope)) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS lab_one_permit ON lab_permits(session_id) WHERE state='ISSUED';
CREATE TABLE IF NOT EXISTS lab_raw(session_id TEXT NOT NULL REFERENCES lab_sessions,event_id TEXT NOT NULL,hash TEXT NOT NULL,scope TEXT NOT NULL,
 receipt_id TEXT UNIQUE NOT NULL,raw BLOB NOT NULL,received_at INTEGER NOT NULL,PRIMARY KEY(session_id,event_id,hash)) STRICT;
CREATE TABLE IF NOT EXISTS lab_events(session_id TEXT NOT NULL,event_id TEXT NOT NULL,hash TEXT NOT NULL,scope TEXT NOT NULL,sequence INTEGER NOT NULL,
 writer_epoch INTEGER NOT NULL,kind TEXT NOT NULL,envelope TEXT NOT NULL,disposition TEXT NOT NULL,version INTEGER NOT NULL,reason TEXT NOT NULL,
 PRIMARY KEY(session_id,event_id),FOREIGN KEY(session_id,event_id,hash) REFERENCES lab_raw(session_id,event_id,hash)) STRICT;
CREATE INDEX IF NOT EXISTS lab_events_scope ON lab_events(session_id,scope,sequence);
CREATE TABLE IF NOT EXISTS lab_dispositions(receipt_id TEXT NOT NULL REFERENCES lab_raw(receipt_id),version INTEGER NOT NULL,
 disposition TEXT NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(receipt_id,version)) STRICT;
CREATE TABLE IF NOT EXISTS lab_seals(session_id TEXT NOT NULL REFERENCES lab_sessions,scope TEXT NOT NULL,seal_id TEXT UNIQUE NOT NULL,
 manifest_hash TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(session_id,scope)) STRICT;
CREATE TABLE IF NOT EXISTS lab_diagnostics(diagnostic_id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES lab_sessions,
 scope TEXT,code TEXT NOT NULL,detail TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS lab_marks(mark_id TEXT NOT NULL,revision INTEGER NOT NULL,session_id TEXT NOT NULL REFERENCES lab_sessions,
 type TEXT NOT NULL,note TEXT NOT NULL,status TEXT NOT NULL,actor TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(mark_id,revision)) STRICT;
CREATE TABLE IF NOT EXISTS lab_audit(audit_id TEXT PRIMARY KEY,actor TEXT NOT NULL,operation TEXT NOT NULL,subject TEXT NOT NULL,
 detail TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS lab_jobs(job_id TEXT PRIMARY KEY,kind TEXT NOT NULL,study_id TEXT,state TEXT NOT NULL,
 phase TEXT NOT NULL,config TEXT NOT NULL,result TEXT,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS lab_one_job ON lab_jobs((1)) WHERE state IN ('RUNNING','RECOVERY_REQUIRED');
CREATE TABLE IF NOT EXISTS lab_projections(generation_id TEXT NOT NULL,session_id TEXT NOT NULL REFERENCES lab_sessions,scope TEXT NOT NULL,source_hash TEXT NOT NULL,algorithm TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(generation_id,session_id,scope)) STRICT;
CREATE TABLE IF NOT EXISTS lab_environments(environment_id TEXT PRIMARY KEY,record TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT;
CREATE TRIGGER IF NOT EXISTS lab_versions_update BEFORE UPDATE ON lab_versions BEGIN SELECT RAISE(ABORT,'immutable protocol'); END;
CREATE TRIGGER IF NOT EXISTS lab_versions_delete BEFORE DELETE ON lab_versions BEGIN SELECT RAISE(ABORT,'immutable protocol'); END;
CREATE TRIGGER IF NOT EXISTS lab_raw_update BEFORE UPDATE ON lab_raw BEGIN SELECT RAISE(ABORT,'immutable raw'); END;
CREATE TRIGGER IF NOT EXISTS lab_raw_delete BEFORE DELETE ON lab_raw BEGIN SELECT RAISE(ABORT,'immutable raw'); END;
CREATE TRIGGER IF NOT EXISTS lab_events_update BEFORE UPDATE OF session_id,event_id,hash,scope,sequence,writer_epoch,kind,envelope ON lab_events BEGIN SELECT RAISE(ABORT,'immutable envelope'); END;
CREATE TRIGGER IF NOT EXISTS lab_seals_update BEFORE UPDATE ON lab_seals BEGIN SELECT RAISE(ABORT,'immutable seal'); END;
CREATE TRIGGER IF NOT EXISTS lab_seals_delete BEFORE DELETE ON lab_seals BEGIN SELECT RAISE(ABORT,'immutable seal'); END;
CREATE TRIGGER IF NOT EXISTS lab_disposition_update BEFORE UPDATE ON lab_dispositions BEGIN SELECT RAISE(ABORT,'immutable disposition'); END;
CREATE TRIGGER IF NOT EXISTS lab_disposition_delete BEFORE DELETE ON lab_dispositions BEGIN SELECT RAISE(ABORT,'immutable disposition'); END;
CREATE TRIGGER IF NOT EXISTS lab_terminal BEFORE UPDATE OF state ON lab_sessions WHEN OLD.state IN ('COMPLETED','TERMINATED') AND NEW.state<>OLD.state BEGIN SELECT RAISE(ABORT,'irreversible session'); END;
CREATE TRIGGER IF NOT EXISTS lab_permit_terminal BEFORE UPDATE OF state ON lab_permits WHEN OLD.state<>'ISSUED' AND NEW.state<>OLD.state BEGIN SELECT RAISE(ABORT,'irreversible permit'); END;
CREATE TRIGGER IF NOT EXISTS lab_diagnostics_update BEFORE UPDATE ON lab_diagnostics BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER IF NOT EXISTS lab_diagnostics_delete BEFORE DELETE ON lab_diagnostics BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER IF NOT EXISTS lab_marks_update BEFORE UPDATE ON lab_marks BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER IF NOT EXISTS lab_marks_delete BEFORE DELETE ON lab_marks BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER IF NOT EXISTS lab_audit_update BEFORE UPDATE ON lab_audit BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER IF NOT EXISTS lab_audit_delete BEFORE DELETE ON lab_audit BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER IF NOT EXISTS lab_writers_update BEFORE UPDATE ON lab_writers BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER IF NOT EXISTS lab_writers_delete BEFORE DELETE ON lab_writers BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER IF NOT EXISTS lab_environments_update BEFORE UPDATE ON lab_environments BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER IF NOT EXISTS lab_environments_delete BEFORE DELETE ON lab_environments BEGIN SELECT RAISE(ABORT,'immutable history'); END;
`;
