use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{OriginalUri, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::{Value, json};
use std::{io, time::Duration};

pub fn router(seed: u64) -> Router {
    Router::new()
        .route(
            "/api/version",
            get(|| async { Json(json!({"version":"0.0.0-sandbox"})) }),
        )
        .route("/api/ps", get(models))
        .route("/api/tags", get(models))
        .route("/api/show", post(show))
        .route("/api/chat", post(completion))
        .route("/api/generate", post(completion))
        .route("/v1/chat/completions", post(completion))
        .route("/feeds/openrouter", get(|| async { Json(openrouter()) }))
        .route("/feeds/litellm", get(|| async { Json(litellm()) }))
        .with_state(seed)
}

async fn models() -> Json<Value> {
    Json(json!({"models":crate::MODELS.map(|name| json!({
        "name":name,"model":name,"size":1_000_000,"size_vram":1_000_000,
        "digest":"synthetic","modified_at":"2026-01-01T00:00:00Z",
        "expires_at":"2099-01-01T00:00:00Z",
        "details":{"format":"gguf","family":"synthetic","parameter_size":"12B","quantization_level":"Q4_K_M"}
    }))}))
}

/// Per-preset `/api/show` metadata: (parent, family, parameter size, context length, num_ctx, tools).
fn preset(model: &str) -> Option<(&'static str, &'static str, &'static str, u64, u64, bool)> {
    match model.strip_suffix(":latest").unwrap_or(model) {
        "factory-assist" => Some(("gemma4:12b", "gemma4", "11.9B", 262_144, 65_536, true)),
        "factory-assist-max" => Some(("gemma4:12b", "gemma4", "11.9B", 262_144, 262_144, true)),
        // Mirrors production practice: qwen2.5-coder emits tool calls as prose, not natively.
        "factory-code" => Some(("qwen2.5-coder:14b", "qwen2", "14.8B", 32_768, 16_384, false)),
        _ => None,
    }
}

async fn show(Json(request): Json<Value>) -> Response {
    let name = request["model"].as_str().unwrap_or_default();
    let Some((parent, family, size, context, num_ctx, tools)) = preset(name) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error":format!("model '{name}' not found")})),
        )
            .into_response();
    };
    let mut capabilities = vec!["completion"];
    if tools {
        capabilities.push("tools");
    }
    Json(json!({
        "modelfile":format!("# synthetic sandbox Modelfile\nFROM {parent}\nPARAMETER num_ctx {num_ctx}\n"),
        "parameters":format!("num_ctx                        {num_ctx}"),
        "template":"{{ .Prompt }}",
        "details":{"parent_model":parent,"format":"gguf","family":family,"families":[family],
            "parameter_size":size,"quantization_level":"Q4_K_M"},
        "model_info":{"general.architecture":family,format!("{family}.context_length"):context},
        "capabilities":capabilities,
        "modified_at":"2026-01-01T00:00:00Z"
    }))
    .into_response()
}

/// Arguments satisfying a JSON schema's required fields, preferring its first allowed value.
fn arguments(schema: &Value) -> Value {
    let mut values = serde_json::Map::new();
    for key in schema["required"].as_array().into_iter().flatten() {
        let Some(key) = key.as_str() else { continue };
        let rule = &schema["properties"][key];
        let value = if let Some(first) = rule["enum"].get(0) {
            first.clone()
        } else {
            match rule["type"].as_str() {
                Some("integer" | "number") => rule["minimum"].as_i64().unwrap_or(1).into(),
                Some("boolean") => false.into(),
                Some("object") => arguments(rule),
                Some("array") => json!([]),
                _ => "synthetic".into(),
            }
        };
        values.insert(key.into(), value);
    }
    values.into()
}

pub fn openrouter() -> Value {
    json!({"data":[
        {"id":"openai/gpt-6.1-sol","created":1790702882,"pricing":{"prompt":"0.000002","completion":"0.00001"}},
        {"id":"anthropic/claude-sonnet-5.5","created":1790618686,"pricing":{"prompt":"0.000002","completion":"0.00001"}}
    ]})
}

pub fn litellm() -> Value {
    json!({
        "gpt-6.1-sol":{"litellm_provider":"openai","input_cost_per_token":0.000002,"output_cost_per_token":0.00001},
        "claude-sonnet-5-5":{"litellm_provider":"anthropic","input_cost_per_token":0.000002,"output_cost_per_token":0.00001}
    })
}

async fn completion(
    State(seed): State<u64>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    Json(request): Json<Value>,
) -> Response {
    let number = |name: &str| -> Result<Option<u64>, ()> {
        headers
            .get(name)
            .map(|v| v.to_str().ok().and_then(|v| v.parse().ok()).ok_or(()))
            .transpose()
    };
    let delay = match number("x-fake-delay-ms") {
        Ok(value) if value.unwrap_or(0) <= 60_000 => value.unwrap_or(0),
        _ => return (StatusCode::BAD_REQUEST, "delay must be 0..60000 ms").into_response(),
    };
    tokio::time::sleep(Duration::from_millis(delay)).await;
    match number("x-fake-error") {
        Ok(Some(code)) if (400..=599).contains(&code) => {
            return (
                StatusCode::from_u16(code as u16).unwrap(),
                Json(json!({"error":"synthetic failure"})),
            )
                .into_response();
        }
        Ok(None) => {}
        _ => return (StatusCode::BAD_REQUEST, "error must be 400..599").into_response(),
    }
    let Some(model) = request["model"]
        .as_str()
        .filter(|name| crate::MODELS.contains(&name.trim_end_matches(":latest")))
    else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error":"unknown sandbox model"})),
        )
            .into_response();
    };
    let openai = uri.path().starts_with("/v1/");
    let streaming = request["stream"].as_bool().unwrap_or(!openai);
    let hash = crate::fingerprint(seed, format!("{}:{request}", uri.path()).as_bytes());
    let prompt = 20 + hash % 181;
    let output = 8 + (hash >> 8) % 25;
    let text = format!("Synthetic response {hash:016x}.");
    let first_tool = request["tools"].as_array().and_then(|tools| tools.first());
    let tool = first_tool.and_then(|tool| tool["function"]["name"].as_str());
    let mut message = json!({"role":"assistant","content":text});
    if openai {
        if let Some(name) = tool {
            message["content"] = Value::Null;
            message["tool_calls"] = json!([{"index":0,"id":format!("call_{hash:016x}"),"type":"function","function":{"name":name,"arguments":"{}"}}]);
        }
    } else if let Some(name) = tool.filter(|_| preset(model).is_some_and(|p| p.5)) {
        message["content"] = "".into();
        message["tool_calls"] = json!([{"function":{"index":0,"name":name,
            "arguments":arguments(&first_tool.unwrap()["function"]["parameters"])}}]);
    }
    let usage =
        json!({"prompt_tokens":prompt,"completion_tokens":output,"total_tokens":prompt+output});
    let mut final_frame = if openai {
        json!({"id":format!("chatcmpl-{hash:016x}"),"object":"chat.completion","created":1791676800,
            "model":model,"choices":[{"index":0,"message":message,"finish_reason":if tool.is_some(){"tool_calls"}else{"stop"}}],"usage":usage})
    } else {
        json!({"model":model,"created_at":"2026-10-11T00:00:00Z","done":true,"done_reason":"stop",
            "prompt_eval_count":prompt,"eval_count":output,"load_duration":10_000_000,
            "prompt_eval_duration":prompt*1_000_000,"eval_duration":output*20_000_000,
            "total_duration":10_000_000+prompt*1_000_000+output*20_000_000})
    };
    if !openai {
        if uri.path() == "/api/chat" {
            final_frame["message"] = message.clone();
        } else {
            final_frame["response"] = text.clone().into();
        }
    }
    if !streaming {
        return Json(final_frame).into_response();
    }
    let frames = if openai {
        let first = json!({"id":final_frame["id"],"object":"chat.completion.chunk","created":1791676800,
            "model":model,"choices":[{"index":0,"delta":message,"finish_reason":null}]});
        final_frame["object"] = "chat.completion.chunk".into();
        final_frame["choices"][0]
            .as_object_mut()
            .unwrap()
            .remove("message");
        final_frame["choices"][0]["delta"] = json!({});
        vec![
            format!("data: {first}\n\n"),
            format!("data: {final_frame}\n\ndata: [DONE]\n\n"),
        ]
    } else {
        let mut first = json!({"model":model,"created_at":"2026-10-11T00:00:00Z","done":false});
        if uri.path() == "/api/chat" {
            first["message"] = message;
            final_frame["message"] = json!({"role":"assistant","content":""});
        } else {
            first["response"] = text.into();
            final_frame["response"] = "".into();
        }
        vec![format!("{first}\n"), format!("{final_frame}\n")]
    };
    let disconnect = headers.get("x-fake-disconnect").is_some_and(|v| v == "1");
    let stream = futures_util::stream::unfold(
        (frames.into_iter(), 0),
        move |(mut frames, index)| async move {
            let frame = frames.next()?;
            // Yield the first frame to the socket before deliberately breaking the body.
            tokio::time::sleep(Duration::from_millis(10)).await;
            let result = if disconnect && index == 1 {
                Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "synthetic disconnect",
                ))
            } else {
                Ok(Bytes::from(frame))
            };
            Some((result, (frames, index + 1)))
        },
    );
    (
        [(
            "content-type",
            if openai {
                "text/event-stream"
            } else {
                "application/x-ndjson"
            },
        )],
        Body::from_stream(stream),
    )
        .into_response()
}
