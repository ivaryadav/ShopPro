-- Rollback for 002_example.
DROP INDEX idx_framework_example_label ON _framework_example;
ALTER TABLE _framework_example DROP COLUMN note;
