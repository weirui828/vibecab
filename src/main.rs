mod planning;
mod search;
use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{AssertSqlSafe, PgPool, postgres::PgPoolOptions};
use uuid::Uuid;

type ApiResult = Result<Json<Value>, (StatusCode, Json<Value>)>;
fn error(code: StatusCode, message: &str) -> (StatusCode, Json<Value>) {
    (code, Json(json!({"error":message})))
}
fn db_error(e: sqlx::Error) -> (StatusCode, Json<Value>) {
    if let sqlx::Error::Database(ref d) = e
        && (d.is_foreign_key_violation() || d.is_check_violation() || d.is_unique_violation())
    {
        return error(
            StatusCode::CONFLICT,
            "constraint violation; check project, dependencies, and task state",
        );
    }
    eprintln!("database error: {e}");
    error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "database operation failed",
    )
}
#[derive(Deserialize)]
struct Project {
    name: String,
    repo_path: Option<String>,
}
async fn create_project(State(pool): State<PgPool>, Json(p): Json<Project>) -> ApiResult {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO projects(id,name,repo_path) VALUES ($1,$2,$3)")
        .bind(id)
        .bind(p.name)
        .bind(p.repo_path)
        .execute(&pool)
        .await
        .map_err(db_error)?;
    Ok(Json(json!({"id":id})))
}
async fn projects(State(pool): State<PgPool>) -> ApiResult {
    let rows =
        sqlx::query_scalar::<_, Value>("SELECT to_jsonb(p) FROM projects p ORDER BY created_at,id")
            .fetch_all(&pool)
            .await
            .map_err(db_error)?;
    Ok(Json(json!(rows)))
}
#[derive(Deserialize)]
struct NewTask {
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    dependencies: Vec<Uuid>,
    #[serde(default)]
    backlog: bool,
    #[serde(default = "planning::normal_priority")]
    priority: i32,
}
async fn create_task(
    State(pool): State<PgPool>,
    Path(project): Path<Uuid>,
    Json(t): Json<NewTask>,
) -> ApiResult {
    let id = Uuid::new_v4();
    let mut tx = pool.begin().await.map_err(db_error)?;
    planning::lock_project(&mut tx, project).await?;
    sqlx::query(
        "INSERT INTO tasks(id,project_id,title,description,status,priority) VALUES ($1,$2,$3,$4,$5,$6)",
    )
    .bind(id)
    .bind(project)
    .bind(t.title)
    .bind(t.description)
    .bind(if t.backlog { "BACKLOG" } else { "TODO" }).bind(t.priority)
    .execute(&mut *tx)
    .await
    .map_err(db_error)?;
    for dep in t.dependencies {
        sqlx::query(
            "INSERT INTO task_dependencies(task_id,depends_on,project_id) VALUES ($1,$2,$3)",
        )
        .bind(id)
        .bind(dep)
        .bind(project)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    }
    planning::bump(&mut tx, project).await?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({"id":id})))
}
// Claim tokens are capabilities: never include them in general task listings.
// AssertSqlSafe queries only interpolate TASK_JSON and ELIGIBLE, both constants.
const TASK_JSON: &str = "to_jsonb(t) - 'claim_token' - 'embedding'";
async fn tasks(State(pool): State<PgPool>, Path(project): Path<Uuid>) -> ApiResult {
    let rows = sqlx::query_scalar::<_, Value>(AssertSqlSafe(format!("SELECT {TASK_JSON} || jsonb_build_object('dependencies',COALESCE((SELECT jsonb_agg(d.depends_on) FROM task_dependencies d WHERE d.task_id=t.id),'[]'::jsonb)) FROM tasks t WHERE project_id=$1 ORDER BY created_at,id"))).bind(project).fetch_all(&pool).await.map_err(db_error)?;
    Ok(Json(json!(rows)))
}
async fn task(State(pool): State<PgPool>, Path(id): Path<Uuid>) -> ApiResult {
    sqlx::query_scalar::<_, Value>(AssertSqlSafe(format!(
        "SELECT {TASK_JSON} FROM tasks t WHERE id=$1"
    )))
    .bind(id)
    .fetch_optional(&pool)
    .await
    .map_err(db_error)?
    .map(Json)
    .ok_or_else(|| error(StatusCode::NOT_FOUND, "task not found"))
}
#[derive(Deserialize)]
struct EditTask {
    title: Option<String>,
    description: Option<String>,
    status: Option<String>,
    priority: Option<i32>,
    expected_version: Option<i64>,
}
async fn edit_task(
    State(pool): State<PgPool>,
    Path(id): Path<Uuid>,
    Json(t): Json<EditTask>,
) -> ApiResult {
    if t.status
        .as_deref()
        .is_some_and(|s| !["BACKLOG", "TODO", "CANCELED"].contains(&s))
    {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "edits support BACKLOG, TODO, or CANCELED; complete work using a claim",
        ));
    }
    let mut tx = pool.begin().await.map_err(db_error)?;
    planning::lock_task(&mut tx, id).await?;
    let n=sqlx::query("UPDATE tasks SET title=COALESCE($2,title),description=COALESCE($3,description),status=COALESCE($4,status),priority=COALESCE($5,priority),version=version+1,updated_at=clock_timestamp() WHERE id=$1 AND ($6::bigint IS NULL OR version=$6) AND status NOT IN ('IN_PROGRESS','DONE')")
        .bind(id).bind(t.title).bind(t.description).bind(t.status).bind(t.priority).bind(t.expected_version).execute(&mut *tx).await.map_err(db_error)?.rows_affected();
    if n == 0 {
        return Err(error(
            StatusCode::CONFLICT,
            "task missing or cannot be edited in its current state",
        ));
    }
    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({"ok":true})))
}
async fn delete_task(State(pool): State<PgPool>, Path(id): Path<Uuid>) -> ApiResult {
    let mut tx = pool.begin().await.map_err(db_error)?;
    let project = planning::lock_task(&mut tx, id).await?;
    let status = sqlx::query_scalar::<_, String>("SELECT status FROM tasks WHERE id=$1 FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db_error)?;
    match status.as_deref() {
        None => return Err(error(StatusCode::NOT_FOUND, "task not found")),
        Some("IN_PROGRESS" | "DONE") => {
            return Err(error(
                StatusCode::CONFLICT,
                "claimed and completed tasks cannot be deleted",
            ));
        }
        _ => {}
    }
    sqlx::query("DELETE FROM task_dependencies WHERE task_id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    sqlx::query("DELETE FROM tasks WHERE id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    planning::bump(&mut tx, project).await?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({"ok":true})))
}
const ELIGIBLE: &str = "(t.status='TODO' OR (t.status='IN_PROGRESS' AND t.lease_until<=clock_timestamp())) AND NOT EXISTS (SELECT 1 FROM task_dependencies d JOIN tasks prerequisite ON prerequisite.id=d.depends_on WHERE d.task_id=t.id AND prerequisite.status<>'DONE')";
async fn ready(State(pool): State<PgPool>, Path(project): Path<Uuid>) -> ApiResult {
    let rows = sqlx::query_scalar::<_, Value>(AssertSqlSafe(format!(
        "SELECT {TASK_JSON} FROM tasks t WHERE project_id=$1 AND {ELIGIBLE} ORDER BY priority,created_at,id"
    )))
    .bind(project)
    .fetch_all(&pool)
    .await
    .map_err(db_error)?;
    Ok(Json(json!(rows)))
}
#[derive(Deserialize)]
struct Claim {
    agent_id: String,
    #[serde(default = "default_lease")]
    lease_seconds: i32,
}
fn default_lease() -> i32 {
    300
}
fn validate_lease(seconds: i32) -> Result<(), (StatusCode, Json<Value>)> {
    if !(1..=3600).contains(&seconds) {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "lease_seconds must be 1..3600",
        ));
    }
    Ok(())
}
async fn claim(
    State(pool): State<PgPool>,
    Path(id): Path<Uuid>,
    Json(c): Json<Claim>,
) -> ApiResult {
    validate_lease(c.lease_seconds)?;
    if c.agent_id.trim().is_empty() {
        return Err(error(StatusCode::BAD_REQUEST, "agent_id must not be empty"));
    }
    let mut tx = pool.begin().await.map_err(db_error)?;
    planning::lock_task(&mut tx, id).await?;
    let token = Uuid::new_v4();
    let row = sqlx::query_scalar::<_, Value>(AssertSqlSafe(format!("UPDATE tasks t SET status='IN_PROGRESS',version=version+1,claim_token=$2,claimed_by=$3,lease_until=clock_timestamp()+make_interval(secs=>$4),updated_at=clock_timestamp() WHERE id=$1 AND {ELIGIBLE} RETURNING to_jsonb(t)-'embedding'")))
        .bind(id).bind(token).bind(c.agent_id).bind(c.lease_seconds as f64).fetch_optional(&mut *tx).await.map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    row.map(Json).ok_or_else(|| {
        error(
            StatusCode::CONFLICT,
            "task missing, blocked, or already claimed",
        )
    })
}
#[derive(Deserialize)]
struct Ownership {
    claim_token: Uuid,
    #[serde(default = "default_lease")]
    lease_seconds: i32,
    result: Option<String>,
}
async fn heartbeat(
    State(pool): State<PgPool>,
    Path(id): Path<Uuid>,
    Json(o): Json<Ownership>,
) -> ApiResult {
    validate_lease(o.lease_seconds)?;
    let n=sqlx::query("UPDATE tasks SET lease_until=clock_timestamp()+make_interval(secs=>$3),updated_at=clock_timestamp() WHERE id=$1 AND claim_token=$2 AND status='IN_PROGRESS' AND lease_until>clock_timestamp()")
        .bind(id).bind(o.claim_token).bind(o.lease_seconds as f64).execute(&pool).await.map_err(db_error)?.rows_affected();
    owned(n)
}
fn owned(n: u64) -> ApiResult {
    if n == 1 {
        Ok(Json(json!({"ok":true})))
    } else {
        Err(error(
            StatusCode::CONFLICT,
            "claim expired or token does not own this task",
        ))
    }
}
async fn finish(pool: PgPool, id: Uuid, o: Ownership, status: &str) -> ApiResult {
    let n=sqlx::query("UPDATE tasks SET status=$3,version=version+1,result=COALESCE($4,result),claim_token=NULL,claimed_by=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1 AND claim_token=$2 AND status='IN_PROGRESS' AND lease_until>clock_timestamp()")
        .bind(id).bind(o.claim_token).bind(status).bind(o.result).execute(&pool).await.map_err(db_error)?.rows_affected();
    owned(n)
}
async fn complete(
    State(pool): State<PgPool>,
    Path(id): Path<Uuid>,
    Json(o): Json<Ownership>,
) -> ApiResult {
    finish(pool, id, o, "DONE").await
}
async fn release(
    State(pool): State<PgPool>,
    Path(id): Path<Uuid>,
    Json(o): Json<Ownership>,
) -> ApiResult {
    finish(pool, id, o, "TODO").await
}
async fn health(State(pool): State<PgPool>) -> ApiResult {
    sqlx::query("SELECT 1")
        .execute(&pool)
        .await
        .map_err(db_error)?;
    Ok(Json(json!({"ok":true})))
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(&std::env::var("DATABASE_URL")?)
        .await?;
    sqlx::migrate!().run(&pool).await?;
    let app = Router::new()
        .route(
            "/",
            get(|| async { axum::response::Html(include_str!("../web/index.html")) }),
        )
        .route(
            "/assets/style.css",
            get(|| async {
                (
                    [(axum::http::header::CONTENT_TYPE, "text/css; charset=utf-8")],
                    include_str!("../web/style.css"),
                )
            }),
        )
        .route(
            "/assets/app.js",
            get(|| async {
                (
                    [(
                        axum::http::header::CONTENT_TYPE,
                        "text/javascript; charset=utf-8",
                    )],
                    include_str!("../web/app.js"),
                )
            }),
        )
        .route(
            "/api",
            get(|| async {
                (
                    [(axum::http::header::CONTENT_TYPE, "application/json")],
                    include_str!("../docs/api.json"),
                )
            }),
        )
        .route("/projects/{id}/claim-next", post(planning::claim_next))
        .route("/tasks/{id}/dependencies", get(planning::task_dependencies))
        .route("/tasks/{id}/embedding", axum::routing::put(search::embed))
        .route("/projects/{id}/search", post(search::search))
        .route("/health", get(health))
        .route("/projects/{id}/graph", get(planning::graph))
        .route(
            "/projects/{id}/dependencies",
            axum::routing::put(planning::dependencies),
        )
        .route("/projects/{id}/capture", post(planning::capture))
        .route("/tasks/{id}/history", get(planning::history))
        .route(
            "/tasks/{id}",
            get(task).patch(edit_task).delete(delete_task),
        )
        .route("/projects", get(projects).post(create_project))
        .route("/projects/{id}/tasks", get(tasks).post(create_task))
        .route("/projects/{id}/ready", get(ready))
        .route("/tasks/{id}/claim", post(claim))
        .route("/tasks/{id}/heartbeat", post(heartbeat))
        .route("/tasks/{id}/complete", post(complete))
        .route("/tasks/{id}/release", post(release))
        .with_state(pool);
    let port: u16 = std::env::var("VCAB_PORT")
        .unwrap_or_else(|_| "7432".into())
        .parse()?;
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    eprintln!("VibeCab listening on 127.0.0.1:{port}");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
