use super::*;
#[derive(Deserialize)]
pub struct Embedding {
    model: String,
    embedding: Vec<f32>,
    expected_version: i64,
}
#[derive(Deserialize)]
pub struct Search {
    model: String,
    embedding: Vec<f32>,
    #[serde(default = "default_limit")]
    limit: i64,
}
fn default_limit() -> i64 {
    10
}
fn vector(model: &str, values: &[f32]) -> Result<String, (StatusCode, Json<Value>)> {
    if model.trim().is_empty()
        || model.len() > 200
        || values.is_empty()
        || values.len() > 4096
        || values.iter().any(|v| !v.is_finite())
        || values.iter().all(|v| *v == 0.0)
    {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "provide a model name and 1..4096 finite, nonzero embedding values",
        ));
    }
    Ok(format!(
        "[{}]",
        values
            .iter()
            .map(|v| v.to_string())
            .collect::<Vec<_>>()
            .join(",")
    ))
}
pub async fn embed(
    State(pool): State<PgPool>,
    Path(id): Path<Uuid>,
    Json(e): Json<Embedding>,
) -> ApiResult {
    let value = vector(&e.model, &e.embedding)?;
    let n = sqlx::query(
        "UPDATE tasks SET embedding=$2::vector,embedding_model=$3 WHERE id=$1 AND version=$4",
    )
    .bind(id)
    .bind(value)
    .bind(e.model)
    .bind(e.expected_version)
    .execute(&pool)
    .await
    .map_err(db_error)?
    .rows_affected();
    if n != 1 {
        return Err(error(
            StatusCode::CONFLICT,
            "task missing or changed; fetch current task before embedding",
        ));
    }
    Ok(Json(json!({"ok":true})))
}
pub async fn search(
    State(pool): State<PgPool>,
    Path(project): Path<Uuid>,
    Json(s): Json<Search>,
) -> ApiResult {
    let value = vector(&s.model, &s.embedding)?;
    if !(1..=100).contains(&s.limit) {
        return Err(error(StatusCode::BAD_REQUEST, "limit must be 1..100"));
    }
    let results=sqlx::query_scalar::<_,Value>(AssertSqlSafe(format!("SELECT jsonb_build_object('task',{TASK_JSON},'cosine_distance',embedding <=> $2::vector) FROM tasks t WHERE project_id=$1 AND embedding_model=$3 AND vector_dims(embedding)=$4 ORDER BY embedding <=> $2::vector,id LIMIT $5")))
        .bind(project).bind(value).bind(s.model).bind(s.embedding.len() as i32).bind(s.limit).fetch_all(&pool).await.map_err(db_error)?;
    Ok(Json(json!({"results":results})))
}
