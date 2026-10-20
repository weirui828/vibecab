use reqwest::{Client, StatusCode};
use serde_json::{Value, json};
use std::process::{Child, Command};
use uuid::Uuid;

struct Server {
    child: Child,
    url: String,
    client: Client,
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Server {
    async fn start() -> Self {
        let db = std::env::var("DATABASE_URL").expect(
            "DATABASE_URL must point to a disposable PostgreSQL database with pgvector installed",
        );
        let socket = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = socket.local_addr().unwrap().port();
        drop(socket);
        let child = Command::new(env!("CARGO_BIN_EXE_vcab"))
            .env("DATABASE_URL", db)
            .env("VCAB_PORT", port.to_string())
            .spawn()
            .unwrap();
        let s = Self {
            child,
            url: format!("http://127.0.0.1:{port}"),
            client: Client::new(),
        };
        for _ in 0..100 {
            if s.client
                .get(format!("{}/health", s.url))
                .send()
                .await
                .is_ok_and(|r| r.status().is_success())
            {
                return s;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        panic!("server failed to become healthy");
    }
    async fn post(&self, path: &str, body: Value) -> reqwest::Response {
        self.client
            .post(format!("{}{path}", self.url))
            .json(&body)
            .send()
            .await
            .unwrap()
    }
    async fn get(&self, path: &str) -> Value {
        self.client
            .get(format!("{}{path}", self.url))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap()
    }
    async fn project(&self) -> String {
        self.post("/projects", json!({"name":"integration"}))
            .await
            .error_for_status()
            .unwrap()
            .json::<Value>()
            .await
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .into()
    }
    async fn task(&self, p: &str, deps: Value) -> String {
        self.post(
            &format!("/projects/{p}/tasks"),
            json!({"title":"Build it 🚕","dependencies":deps}),
        )
        .await
        .error_for_status()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap()["id"]
            .as_str()
            .unwrap()
            .into()
    }
}
#[tokio::test]
async fn dependency_gating_and_atomic_claims() {
    let s = Server::start().await;
    let p = s.project().await;
    let a = s.task(&p, json!([])).await;
    let b = s.task(&p, json!([a])).await;
    assert_eq!(
        s.get(&format!("/projects/{p}/ready"))
            .await
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        s.post(&format!("/tasks/{b}/claim"), json!({"agent_id":"blocked"}))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let url = format!("/tasks/{a}/claim");
    let (one, two) = tokio::join!(
        s.post(&url, json!({"agent_id":"one"})),
        s.post(&url, json!({"agent_id":"two"}))
    );
    assert!(one.status().is_success() ^ two.status().is_success());
    let (winner, loser) = if one.status().is_success() {
        (one, two)
    } else {
        (two, one)
    };
    assert_eq!(loser.status(), StatusCode::CONFLICT);
    let claim: Value = winner.json().await.unwrap();
    assert!(
        s.get(&format!("/tasks/{a}"))
            .await
            .get("claim_token")
            .is_none()
    );
    assert_eq!(
        s.post(
            &format!("/tasks/{a}/complete"),
            json!({"claim_token":Uuid::new_v4()})
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    s.post(
        &format!("/tasks/{a}/complete"),
        json!({"claim_token":claim["claim_token"],"result":"done"}),
    )
    .await
    .error_for_status()
    .unwrap();
    let ready = s.get(&format!("/projects/{p}/ready")).await;
    assert_eq!(ready[0]["id"], b);
}
#[tokio::test]
async fn lease_recovery_fences_stale_agents_and_renews() {
    let s = Server::start().await;
    let p = s.project().await;
    let a = s.task(&p, json!([])).await;
    let first: Value = s
        .post(&format!("/tasks/{a}/claim"), json!({"agent_id":"old"}))
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let pool = sqlx::PgPool::connect(&std::env::var("DATABASE_URL").unwrap())
        .await
        .unwrap();
    sqlx::query("UPDATE tasks SET lease_until=now()-interval '1 second' WHERE id=$1")
        .bind(Uuid::parse_str(&a).unwrap())
        .execute(&pool)
        .await
        .unwrap();
    let second: Value = s
        .post(&format!("/tasks/{a}/claim"), json!({"agent_id":"new"}))
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_ne!(first["claim_token"], second["claim_token"]);
    for op in ["heartbeat", "release", "complete"] {
        assert_eq!(
            s.post(
                &format!("/tasks/{a}/{op}"),
                json!({"claim_token":first["claim_token"]})
            )
            .await
            .status(),
            StatusCode::CONFLICT
        );
    }
    s.post(
        &format!("/tasks/{a}/heartbeat"),
        json!({"claim_token":second["claim_token"],"lease_seconds":600}),
    )
    .await
    .error_for_status()
    .unwrap();
    s.post(
        &format!("/tasks/{a}/release"),
        json!({"claim_token":second["claim_token"]}),
    )
    .await
    .error_for_status()
    .unwrap();
    assert_eq!(s.get(&format!("/projects/{p}/ready")).await[0]["id"], a);
    let distance: f64 = sqlx::query_scalar("SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(distance, 1.0);
}
#[tokio::test]
async fn crud_and_dependency_integrity() {
    let s = Server::start().await;
    let p = s.project().await;
    let other = s.project().await;
    let a = s.task(&p, json!([])).await;
    assert_eq!(
        s.post(
            &format!("/projects/{other}/tasks"),
            json!({"title":"bad","dependencies":[a]})
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    assert!(
        s.get(&format!("/projects/{other}/tasks"))
            .await
            .as_array()
            .unwrap()
            .is_empty()
    );
    let b = s.task(&p, json!([a])).await;
    let patch = s
        .client
        .patch(format!("{}/tasks/{b}", s.url))
        .json(&json!({"title":"updated","status":"BACKLOG"}))
        .send()
        .await
        .unwrap();
    patch.error_for_status().unwrap();
    assert_eq!(s.get(&format!("/tasks/{b}")).await["title"], "updated");
    assert_eq!(
        s.client
            .delete(format!("{}/tasks/{a}", s.url))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    for id in [&b, &a] {
        s.client
            .delete(format!("{}/tasks/{id}", s.url))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
    }
    assert!(
        s.get(&format!("/projects/{p}/tasks"))
            .await
            .as_array()
            .unwrap()
            .is_empty()
    );
}

impl Server {
    async fn plan(&self, p: &str, body: Value) -> reqwest::Response {
        self.client
            .put(format!("{}/projects/{p}/dependencies", self.url))
            .json(&body)
            .send()
            .await
            .unwrap()
    }
}
#[tokio::test]
async fn graph_analysis_preview_cycles_and_revision_conflicts() {
    let s = Server::start().await;
    let p = s.project().await;
    let a = s.task(&p, json!([])).await;
    let b = s.task(&p, json!([a])).await;
    let c = s.task(&p, json!([b])).await;
    let g = s.get(&format!("/projects/{p}/graph")).await;
    assert_eq!(g["analysis"][&c]["ancestors"].as_array().unwrap().len(), 2);
    assert_eq!(g["analysis"][&a]["unblocks_count"], 2);
    assert_eq!(g["execution_layers"], json!([[a], [b], [c]]));
    assert!(
        g["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .all(|t| t.get("claim_token").is_none())
    );
    let revision = g["revision"].clone();
    let preview=s.plan(&p,json!({"expected_revision":revision,"dry_run":true,"changes":[{"task_id":c,"dependencies":[a],"rationale":"independent of B"}]})).await.error_for_status().unwrap().json::<Value>().await.unwrap();
    assert_eq!(preview["analysis"][&c]["dependencies"], json!([a]));
    assert_eq!(
        s.get(&format!("/projects/{p}/graph")).await["analysis"][&c]["dependencies"],
        json!([b])
    );
    let cyclic = s
        .plan(
            &p,
            json!({"expected_revision":revision,"changes":[{"task_id":a,"dependencies":[c]}]}),
        )
        .await;
    assert_eq!(cyclic.status(), StatusCode::CONFLICT);
    assert_eq!(
        s.get(&format!("/projects/{p}/graph")).await["revision"],
        revision
    );
    let applied=s.plan(&p,json!({"expected_revision":revision,"changes":[{"task_id":c,"dependencies":[a],"rationale":"independent of B"}]})).await.error_for_status().unwrap().json::<Value>().await.unwrap();
    assert_eq!(
        applied["revision"].as_i64().unwrap(),
        revision.as_i64().unwrap() + 1
    );
    assert_eq!(
        s.plan(
            &p,
            json!({"expected_revision":revision,"changes":[{"task_id":b,"dependencies":[]}]})
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    let history = s.get(&format!("/tasks/{c}/history")).await;
    assert_eq!(history[0]["kind"], "dependencies_changed");
    assert_eq!(history[0]["details"]["rationale"], "independent of B");
}
#[tokio::test]
async fn concurrent_graph_plans_cannot_form_cycle_or_invalidate_claim() {
    let s = Server::start().await;
    let p = s.project().await;
    let a = s.task(&p, json!([])).await;
    let b = s.task(&p, json!([])).await;
    let rev = s.get(&format!("/projects/{p}/graph")).await["revision"].clone();
    let (one, two) = tokio::join!(
        s.plan(
            &p,
            json!({"expected_revision":rev,"changes":[{"task_id":a,"dependencies":[b]}]})
        ),
        s.plan(
            &p,
            json!({"expected_revision":rev,"changes":[{"task_id":b,"dependencies":[a]}]})
        )
    );
    assert!(one.status().is_success() ^ two.status().is_success());
    let g = s.get(&format!("/projects/{p}/graph")).await;
    assert_eq!(g["edges"].as_array().unwrap().len(), 1);
    let free = s.task(&p, json!([])).await;
    let rev = s.get(&format!("/projects/{p}/graph")).await["revision"].clone();
    let claim_path = format!("/tasks/{free}/claim");
    let (edit, claim) = tokio::join!(
        s.plan(
            &p,
            json!({"expected_revision":rev,"changes":[{"task_id":free,"dependencies":[a]}]})
        ),
        s.post(&claim_path, json!({"agent_id":"racer"}))
    );
    assert!(edit.status().is_success() ^ claim.status().is_success());
}
#[tokio::test]
async fn batch_capture_is_atomic_idempotent_and_prioritized() {
    let s = Server::start().await;
    let p = s.project().await;
    let body = json!({"request_id":"capture-1","tasks":[{"key":"api","title":"API","priority":0},{"key":"ui","title":"UI","dependencies":["api"]}]});
    let first = s
        .post(&format!("/projects/{p}/capture"), body.clone())
        .await
        .error_for_status()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    let repeat = s
        .post(&format!("/projects/{p}/capture"), body)
        .await
        .error_for_status()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(first, repeat);
    assert_eq!(
        s.get(&format!("/projects/{p}/tasks"))
            .await
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        s.get(&format!("/projects/{p}/ready")).await[0]["id"],
        first["tasks"]["api"]
    );
    let cycle = json!({"request_id":"capture-2","tasks":[{"key":"a","title":"a","dependencies":["b"]},{"key":"b","title":"b","dependencies":["a"]}]});
    assert_eq!(
        s.post(&format!("/projects/{p}/capture"), cycle)
            .await
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        s.get(&format!("/projects/{p}/tasks"))
            .await
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        s.post(
            &format!("/projects/{p}/capture"),
            json!({"request_id":"capture-1","tasks":[{"key":"other","title":"other"}]})
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
}
#[tokio::test]
async fn optimistic_edits_reject_stale_versions() {
    let s = Server::start().await;
    let p = s.project().await;
    let a = s.task(&p, json!([])).await;
    let version = s.get(&format!("/tasks/{a}")).await["version"].clone();
    for (title, expected) in [("new", StatusCode::OK), ("stale", StatusCode::CONFLICT)] {
        let r = s
            .client
            .patch(format!("{}/tasks/{a}", s.url))
            .json(&json!({"title":title,"expected_version":version}))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), expected);
    }
    assert_eq!(s.get(&format!("/tasks/{a}")).await["title"], "new");
}

#[tokio::test]
async fn claim_next_is_atomic_priority_ordered_and_excludes_backlog() {
    let s = Server::start().await;
    let p = s.project().await;
    let batch=s.post(&format!("/projects/{p}/capture"),json!({"request_id":"claim-next","tasks":[{"key":"low","title":"low","priority":3},{"key":"urgent","title":"urgent","priority":0},{"key":"idea","title":"idea","backlog":true,"priority":0}]})).await.error_for_status().unwrap().json::<Value>().await.unwrap();
    let path = format!("/projects/{p}/claim-next");
    let first = s
        .post(&path, json!({"agent_id":"one"}))
        .await
        .error_for_status()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(first["task"]["id"], batch["tasks"]["urgent"]);
    let (a, b) = tokio::join!(
        s.post(&path, json!({"agent_id":"two"})),
        s.post(&path, json!({"agent_id":"three"}))
    );
    let a: Value = a.error_for_status().unwrap().json().await.unwrap();
    let b: Value = b.error_for_status().unwrap().json().await.unwrap();
    assert!(a["task"].is_null() ^ b["task"].is_null());
    let history = s
        .get(&format!(
            "/tasks/{}/history",
            batch["tasks"]["urgent"].as_str().unwrap()
        ))
        .await;
    assert!(
        !history
            .to_string()
            .contains(first["task"]["claim_token"].as_str().unwrap())
    );
}
#[tokio::test]
async fn vector_search_scopes_models_and_invalidates_stale_content() {
    let s = Server::start().await;
    let p = s.project().await;
    let a = s.task(&p, json!([])).await;
    let b = s.task(&p, json!([])).await;
    for (id, vector) in [(&a, json!([1.0, 0.0, 0.0])), (&b, json!([0.0, 1.0, 0.0]))] {
        s.client
            .put(format!("{}/tasks/{id}/embedding", s.url))
            .json(&json!({"model":"local-v1","embedding":vector,"expected_version":1}))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
    }
    let path = format!("/projects/{p}/search");
    let results = s
        .post(&path, json!({"model":"local-v1","embedding":[1,0,0]}))
        .await
        .error_for_status()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(results["results"][0]["task"]["id"], a);
    assert_eq!(results["results"][0]["cosine_distance"], 0.0);
    for body in [
        json!({"model":"other","embedding":[1,0,0]}),
        json!({"model":"local-v1","embedding":[1,0]}),
    ] {
        assert!(
            s.post(&path, body)
                .await
                .error_for_status()
                .unwrap()
                .json::<Value>()
                .await
                .unwrap()["results"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
    assert_eq!(
        s.post(&path, json!({"model":"local-v1","embedding":[0,0,0]}))
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    s.client
        .patch(format!("{}/tasks/{a}", s.url))
        .json(&json!({"title":"new meaning","expected_version":1}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    let stale = s
        .client
        .put(format!("{}/tasks/{a}/embedding", s.url))
        .json(&json!({"model":"local-v1","embedding":[1,0,0],"expected_version":1}))
        .send()
        .await
        .unwrap();
    assert_eq!(stale.status(), StatusCode::CONFLICT);
    let after = s
        .post(&path, json!({"model":"local-v1","embedding":[1,0,0]}))
        .await
        .error_for_status()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(after["results"].as_array().unwrap().len(), 1);
    assert_eq!(after["results"][0]["task"]["id"], b);
}
