-- 002_example — demonstrates an incremental migration on top of 001, and
-- its rollback. Still framework proof-of-concept, not real schema (see
-- 001_initial.sql's header).

ALTER TABLE _framework_example ADD COLUMN note VARCHAR(500) NULL;
CREATE INDEX idx_framework_example_label ON _framework_example (label);
