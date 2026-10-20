ALTER TABLE tasks ADD COLUMN embedding_model text;
ALTER TABLE tasks ADD CONSTRAINT embedding_model_pair CHECK ((embedding IS NULL) = (embedding_model IS NULL));
CREATE FUNCTION invalidate_task_embedding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.title IS DISTINCT FROM OLD.title OR NEW.description IS DISTINCT FROM OLD.description THEN
  NEW.embedding=NULL;
  NEW.embedding_model=NULL;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER invalidate_embedding BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION invalidate_task_embedding();
