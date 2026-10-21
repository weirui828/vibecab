use super::*;
use sqlx::{Postgres, Transaction};
use std::collections::{BTreeMap, BTreeSet};

// Every topology edit and claim takes the same project lock BEFORE reading eligibility.
// A later statement then sees committed edges, even if lock acquisition waited.
pub async fn lock_project(
    tx: &mut Transaction<'_, Postgres>,
    project: Uuid,
) -> Result<i64, (StatusCode, Json<Value>)> {
    sqlx::query_scalar("SELECT graph_revision FROM projects WHERE id=$1 FOR UPDATE")
        .bind(project)
        .fetch_optional(&mut **tx)
        .await
        .map_err(db_error)?
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "project not found"))
}
pub async fn lock_task(
    tx: &mut Transaction<'_, Postgres>,
    task: Uuid,
) -> Result<Uuid, (StatusCode, Json<Value>)> {
    let project = sqlx::query_scalar::<_, Uuid>("SELECT project_id FROM tasks WHERE id=$1")
        .bind(task)
        .fetch_optional(&mut **tx)
        .await
        .map_err(db_error)?
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "task not found"))?;
    lock_project(tx, project).await?;
    Ok(project)
}
pub async fn bump(
    tx: &mut Transaction<'_, Postgres>,
    project: Uuid,
) -> Result<(), (StatusCode, Json<Value>)> {
    sqlx::query("UPDATE projects SET graph_revision=graph_revision+1 WHERE id=$1")
        .bind(project)
        .execute(&mut **tx)
        .await
        .map_err(db_error)?;
    Ok(())
}
async fn snapshot(
    tx: &mut Transaction<'_, Postgres>,
    project: Uuid,
) -> Result<Value, (StatusCode, Json<Value>)> {
    sqlx::query_scalar::<_,Value>("SELECT jsonb_build_object('project_id',p.id,'revision',p.graph_revision,'tasks',COALESCE((SELECT jsonb_agg(to_jsonb(t)-'claim_token'-'embedding' ORDER BY t.priority,t.created_at,t.id) FROM tasks t WHERE t.project_id=p.id),'[]'::jsonb),'edges',COALESCE((SELECT jsonb_agg(jsonb_build_object('task_id',d.task_id,'depends_on',d.depends_on,'rationale',d.rationale) ORDER BY d.task_id,d.depends_on) FROM task_dependencies d WHERE d.project_id=p.id),'[]'::jsonb),'server_time',clock_timestamp()) FROM projects p WHERE p.id=$1")
        .bind(project).fetch_optional(&mut **tx).await.map_err(db_error)?.ok_or_else(||error(StatusCode::NOT_FOUND,"project not found"))
}
fn closure(start: &str, edges: &BTreeMap<String, BTreeSet<String>>) -> BTreeSet<String> {
    let mut visited = BTreeSet::new();
    let mut pending = vec![start.to_string()];
    while let Some(id) = pending.pop() {
        for next in edges.get(&id).into_iter().flatten() {
            if visited.insert(next.clone()) {
                pending.push(next.clone());
            }
        }
    }
    visited.remove(start);
    visited
}
fn analyze(mut graph: Value) -> Result<Value, (StatusCode, Json<Value>)> {
    let mut deps: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut reverse = deps.clone();
    let tasks = graph["tasks"].as_array().expect("database tasks array");
    let statuses: BTreeMap<String, String> = tasks
        .iter()
        .map(|t| {
            (
                t["id"].as_str().unwrap().into(),
                t["status"].as_str().unwrap().into(),
            )
        })
        .collect();
    for id in statuses.keys() {
        deps.insert(id.clone(), BTreeSet::new());
    }
    for edge in graph["edges"].as_array().unwrap() {
        let id = edge["task_id"].as_str().unwrap().to_string();
        let dep = edge["depends_on"].as_str().unwrap().to_string();
        deps.entry(id.clone()).or_default().insert(dep.clone());
        reverse.entry(dep).or_default().insert(id);
    }
    let mut remaining = deps.clone();
    let mut layers = vec![];
    while !remaining.is_empty() {
        let layer: Vec<String> = remaining
            .iter()
            .filter(|(_, d)| d.is_empty())
            .map(|(id, _)| id.clone())
            .collect();
        if layer.is_empty() {
            return Err((
                StatusCode::CONFLICT,
                Json(
                    json!({"error":"dependency cycle detected","cycle_candidates":remaining.keys().collect::<Vec<_>>()}),
                ),
            ));
        }
        for id in &layer {
            remaining.remove(id);
        }
        for d in remaining.values_mut() {
            for id in &layer {
                d.remove(id);
            }
        }
        layers.push(layer);
    }
    let mut analysis = BTreeMap::new();
    for id in statuses.keys() {
        let ancestors = closure(id, &deps);
        let descendants = closure(id, &reverse);
        let blockers: Vec<_> = deps[id]
            .iter()
            .filter(|d| statuses[*d] != "DONE")
            .cloned()
            .collect();
        let unfinished: Vec<_> = ancestors
            .iter()
            .filter(|d| statuses[*d] != "DONE")
            .cloned()
            .collect();
        analysis.insert(id.clone(),json!({"dependencies":deps[id],"dependents":reverse.get(id).cloned().unwrap_or_default(),"ancestors":ancestors,"descendants":descendants,"unfinished_ancestors":unfinished,"blockers":blockers,"unblocks_count":descendants.len()}));
    }
    graph["analysis"] = json!(analysis);
    graph["execution_layers"] = json!(layers);
    graph["edge_direction"] =
        json!("task_id depends on depends_on; layers place prerequisites first");
    Ok(graph)
}
pub async fn graph(State(pool): State<PgPool>, Path(project): Path<Uuid>) -> ApiResult {
    let mut tx = pool.begin().await.map_err(db_error)?;
    let value = analyze(snapshot(&mut tx, project).await?)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(value))
}
#[derive(Deserialize)]
pub struct DependencyChange {
    task_id: Uuid,
    dependencies: Vec<Uuid>,
    #[serde(default)]
    rationale: String,
}
#[derive(Deserialize)]
pub struct DependencyPlan {
    expected_revision: i64,
    changes: Vec<DependencyChange>,
    #[serde(default)]
    dry_run: bool,
}
pub async fn dependencies(
    State(pool): State<PgPool>,
    Path(project): Path<Uuid>,
    Json(plan): Json<DependencyPlan>,
) -> ApiResult {
    if plan.changes.is_empty() || plan.changes.len() > 200 {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "provide 1..200 task changes",
        ));
    }
    let mut tx = pool.begin().await.map_err(db_error)?;
    let revision = lock_project(&mut tx, project).await?;
    if revision != plan.expected_revision {
        return Err(error(
            StatusCode::CONFLICT,
            "graph changed; fetch it again before applying the plan",
        ));
    }
    let mut seen = BTreeSet::new();
    for change in &plan.changes {
        if !seen.insert(change.task_id) {
            return Err(error(StatusCode::BAD_REQUEST, "duplicate task in changes"));
        }
        let status = sqlx::query_scalar::<_, String>(
            "SELECT status FROM tasks WHERE id=$1 AND project_id=$2",
        )
        .bind(change.task_id)
        .bind(project)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db_error)?;
        match status.as_deref() {
            Some("TODO" | "BACKLOG" | "CANCELED") => {}
            _ => {
                return Err(error(
                    StatusCode::CONFLICT,
                    "dependency target must be an unclaimed, unfinished task in this project",
                ));
            }
        }
        sqlx::query("DELETE FROM task_dependencies WHERE task_id=$1")
            .bind(change.task_id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
        for dep in change.dependencies.iter().collect::<BTreeSet<_>>() {
            sqlx::query("INSERT INTO task_dependencies(task_id,depends_on,project_id,rationale) VALUES($1,$2,$3,$4)").bind(change.task_id).bind(dep).bind(project).bind(&change.rationale).execute(&mut *tx).await.map_err(db_error)?;
        }
        sqlx::query("UPDATE tasks SET version=version+1,updated_at=clock_timestamp() WHERE id=$1")
            .bind(change.task_id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
        sqlx::query("INSERT INTO task_events(task_id,project_id,kind,details) VALUES($1,$2,'dependencies_changed',$3)").bind(change.task_id).bind(project).bind(json!({"dependencies":change.dependencies,"rationale":change.rationale})).execute(&mut *tx).await.map_err(db_error)?;
    }
    let mut result = analyze(snapshot(&mut tx, project).await?)?;
    result["dry_run"] = json!(plan.dry_run);
    if plan.dry_run {
        tx.rollback().await.map_err(db_error)?;
    } else {
        bump(&mut tx, project).await?;
        result["revision"] = json!(revision + 1);
        tx.commit().await.map_err(db_error)?;
    }
    Ok(Json(result))
}
#[derive(Deserialize)]
struct BatchTask {
    key: String,
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    dependencies: Vec<String>,
    #[serde(default)]
    backlog: bool,
    #[serde(default = "normal_priority")]
    priority: i32,
}
#[derive(Deserialize)]
struct Batch {
    request_id: String,
    tasks: Vec<BatchTask>,
}
pub fn normal_priority() -> i32 {
    2
}
pub async fn capture(
    State(pool): State<PgPool>,
    Path(project): Path<Uuid>,
    Json(payload): Json<Value>,
) -> ApiResult {
    let batch: Batch = serde_json::from_value(payload.clone())
        .map_err(|_| error(StatusCode::BAD_REQUEST, "invalid batch body"))?;
    if batch.request_id.is_empty()
        || batch.request_id.len() > 200
        || batch.tasks.is_empty()
        || batch.tasks.len() > 200
    {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "request_id and 1..200 tasks required",
        ));
    }
    let mut tx = pool.begin().await.map_err(db_error)?;
    lock_project(&mut tx, project).await?;
    let previous = sqlx::query_as::<_, (Value, Value)>(
        "SELECT payload,result FROM capture_requests WHERE project_id=$1 AND request_id=$2",
    )
    .bind(project)
    .bind(&batch.request_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db_error)?;
    if let Some((old, result)) = previous {
        if old != payload {
            return Err(error(
                StatusCode::CONFLICT,
                "request_id already used with different content",
            ));
        }
        return Ok(Json(result));
    }
    let mut ids = BTreeMap::new();
    for task in &batch.tasks {
        if task.key.is_empty()
            || Uuid::parse_str(&task.key).is_ok()
            || ids.insert(task.key.clone(), Uuid::new_v4()).is_some()
        {
            return Err(error(
                StatusCode::BAD_REQUEST,
                "task keys must be unique nonempty aliases, not UUIDs",
            ));
        }
    }
    for task in &batch.tasks {
        sqlx::query("INSERT INTO tasks(id,project_id,title,description,status,priority) VALUES($1,$2,$3,$4,$5,$6)").bind(ids[&task.key]).bind(project).bind(&task.title).bind(&task.description).bind(if task.backlog{"BACKLOG"}else{"TODO"}).bind(task.priority).execute(&mut *tx).await.map_err(db_error)?;
    }
    for task in &batch.tasks {
        for reference in task.dependencies.iter().collect::<BTreeSet<_>>() {
            let dep = ids
                .get(reference)
                .copied()
                .or_else(|| Uuid::parse_str(reference).ok())
                .ok_or_else(|| error(StatusCode::BAD_REQUEST, "unknown dependency alias"))?;
            sqlx::query(
                "INSERT INTO task_dependencies(task_id,depends_on,project_id) VALUES($1,$2,$3)",
            )
            .bind(ids[&task.key])
            .bind(dep)
            .bind(project)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
        }
    }
    analyze(snapshot(&mut tx, project).await?)?;
    bump(&mut tx, project).await?;
    let result = json!({"tasks":ids});
    sqlx::query(
        "INSERT INTO capture_requests(project_id,request_id,payload,result) VALUES($1,$2,$3,$4)",
    )
    .bind(project)
    .bind(batch.request_id)
    .bind(payload)
    .bind(&result)
    .execute(&mut *tx)
    .await
    .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(result))
}
pub async fn history(State(pool): State<PgPool>, Path(id): Path<Uuid>) -> ApiResult {
    let rows = sqlx::query_scalar::<_, Value>(
        "SELECT to_jsonb(e) FROM task_events e WHERE task_id=$1 ORDER BY id DESC LIMIT 100",
    )
    .bind(id)
    .fetch_all(&pool)
    .await
    .map_err(db_error)?;
    Ok(Json(json!(rows)))
}

pub async fn claim_next(
    State(pool): State<PgPool>,
    Path(project): Path<Uuid>,
    Json(c): Json<Claim>,
) -> ApiResult {
    validate_lease(c.lease_seconds)?;
    if c.agent_id.trim().is_empty() {
        return Err(error(StatusCode::BAD_REQUEST, "agent_id must not be empty"));
    }
    let mut tx = pool.begin().await.map_err(db_error)?;
    lock_project(&mut tx, project).await?;
    let id=sqlx::query_scalar::<_,Uuid>(AssertSqlSafe(format!("SELECT id FROM tasks t WHERE project_id=$1 AND {ELIGIBLE} ORDER BY priority,created_at,id LIMIT 1")))
        .bind(project).fetch_optional(&mut *tx).await.map_err(db_error)?;
    let Some(id) = id else {
        return Ok(Json(json!({"task":null})));
    };
    let task=sqlx::query_scalar::<_,Value>("UPDATE tasks t SET status='IN_PROGRESS',version=version+1,claim_token=$2,claimed_by=$3,lease_until=clock_timestamp()+make_interval(secs=>$4),updated_at=clock_timestamp() WHERE id=$1 RETURNING to_jsonb(t)-'embedding'")
        .bind(id).bind(Uuid::new_v4()).bind(c.agent_id).bind(c.lease_seconds as f64).fetch_one(&mut *tx).await.map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({"task":task})))
}
pub async fn task_dependencies(State(pool): State<PgPool>, Path(id): Path<Uuid>) -> ApiResult {
    let mut tx = pool.begin().await.map_err(db_error)?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    let project = sqlx::query_scalar::<_, Uuid>("SELECT project_id FROM tasks WHERE id=$1")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db_error)?
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "task not found"))?;
    let graph = analyze(snapshot(&mut tx, project).await?)?;
    let key = id.to_string();
    let related = graph["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|t| {
            t["id"] == key
                || graph["analysis"][&key]["ancestors"]
                    .as_array()
                    .unwrap()
                    .contains(&t["id"])
                || graph["analysis"][&key]["descendants"]
                    .as_array()
                    .unwrap()
                    .contains(&t["id"])
        })
        .cloned()
        .collect::<Vec<_>>();
    Ok(Json(
        json!({"task_id":id,"project_id":project,"revision":graph["revision"],"analysis":graph["analysis"][&key],"related_tasks":related}),
    ))
}
