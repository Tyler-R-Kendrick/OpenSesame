-- Host policy is an explicit authorization ceiling, not an Identity-role cache.
CREATE TABLE config_authorization_roles (
  organization_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  role TEXT CHECK(role IN ('owner','admin','member') OR role IS NULL),
  revision INTEGER NOT NULL CHECK(revision > 0),
  evidence_after INTEGER NOT NULL CHECK(evidence_after >= 0),
  PRIMARY KEY(organization_id,principal_id)
);
CREATE TABLE config_project_access (
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  metadata_read INTEGER NOT NULL CHECK(metadata_read IN (0,1)),
  keys_read INTEGER NOT NULL CHECK(keys_read IN (0,1) AND keys_read <= metadata_read),
  PRIMARY KEY(organization_id,project_id,principal_id),
  FOREIGN KEY(organization_id,principal_id)
    REFERENCES config_authorization_roles(organization_id,principal_id)
);
