ALTER TABLE projects ADD COLUMN graph_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN version bigint NOT NULL DEFAULT 1;
ALTER TABLE tasks ADD COLUMN priority integer NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3);
ALTER TABLE task_dependencies ADD COLUMN rationale text NOT NULL DEFAULT '';
CREATE TABLE task_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 task_id uuid NOT NULL, project_id uuid NOT NULL REFERENCES projects(id),
 kind text NOT NULL, details jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ON task_events(task_id, id);
CREATE TABLE capture_requests (
 project_id uuid NOT NULL REFERENCES projects(id), request_id text NOT NULL,
 payload jsonb NOT NULL, result jsonb NOT NULL, PRIMARY KEY(project_id,request_id)
);
CREATE FUNCTION record_task_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  INSERT INTO task_events(task_id,project_id,kind,details) VALUES(NEW.id,NEW.project_id,'created',jsonb_build_object('title',NEW.title,'status',NEW.status));
 ELSIF TG_OP='DELETE' THEN
  INSERT INTO task_events(task_id,project_id,kind,details) VALUES(OLD.id,OLD.project_id,'deleted',jsonb_build_object('title',OLD.title));
 ELSIF (to_jsonb(NEW)-ARRAY['lease_until','updated_at','version']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['lease_until','updated_at','version']) THEN
  INSERT INTO task_events(task_id,project_id,kind,details) VALUES(NEW.id,NEW.project_id,'updated',jsonb_build_object('from',OLD.status,'to',NEW.status,'agent',NEW.claimed_by));
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER task_history AFTER INSERT OR UPDATE OR DELETE ON tasks FOR EACH ROW EXECUTE FUNCTION record_task_event();
