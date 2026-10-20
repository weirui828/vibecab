CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE projects (
 id uuid PRIMARY KEY, name text NOT NULL CHECK (length(trim(name)) > 0),
 repo_path text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE tasks (
 id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id),
 title text NOT NULL CHECK (length(trim(title)) > 0), description text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'TODO' CHECK (status IN ('BACKLOG','TODO','IN_PROGRESS','DONE','CANCELED')),
 claim_token uuid, claimed_by text, lease_until timestamptz,
 result text, embedding vector, created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (id, project_id),
 CHECK ((status = 'IN_PROGRESS') = (claim_token IS NOT NULL AND claimed_by IS NOT NULL AND lease_until IS NOT NULL)),
 CHECK (status = 'IN_PROGRESS' OR (claim_token IS NULL AND claimed_by IS NULL AND lease_until IS NULL))
);
CREATE TABLE task_dependencies (
 task_id uuid NOT NULL, depends_on uuid NOT NULL, project_id uuid NOT NULL,
 PRIMARY KEY (task_id, depends_on), CHECK (task_id <> depends_on),
 FOREIGN KEY (task_id, project_id) REFERENCES tasks(id, project_id),
 FOREIGN KEY (depends_on, project_id) REFERENCES tasks(id, project_id)
);
CREATE INDEX ON tasks(project_id, status);
CREATE INDEX ON task_dependencies(depends_on);
