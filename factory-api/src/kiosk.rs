use axum::{
    body::Body,
    extract::{FromRequestParts, Path},
    http::{Method, Request, StatusCode, header},
    response::{IntoResponse, Response},
};
use std::{io, path::Path as FsPath};

const PLACEHOLDER: &str = r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30"><title>factory · kiosk not deployed yet</title>
<style>html{background:#111018;color:oklch(0.72 0.15 300);font-family:system-ui,sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center}h1{font-size:clamp(1rem,3vw,2rem);font-weight:500;text-align:center;padding:1rem}</style>
</head><body><h1>factory · kiosk not deployed yet</h1>
<script>
setInterval(() => location.reload(), 30000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") location.reload();
});
</script></body></html>"#;

pub(crate) fn reserved(path: &str) -> bool {
    path == "/v1" || path.starts_with("/v1/") || path == "/openapi.json"
}

pub(crate) async fn serve(root: &FsPath, request: Request<Body>) -> Response {
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return (
            StatusCode::METHOD_NOT_ALLOWED,
            [(header::ALLOW, "GET, HEAD")],
        )
            .into_response();
    }
    let head = request.method() == Method::HEAD;
    let html = request
        .headers()
        .get_all(header::ACCEPT)
        .iter()
        .any(|value| {
            value.to_str().is_ok_and(|value| {
                value.split(',').any(|entry| {
                    let mut parts = entry.trim().split(';');
                    parts
                        .next()
                        .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("text/html"))
                        && !parts.any(|parameter| {
                            parameter
                                .trim()
                                .strip_prefix("q=")
                                .is_some_and(|q| q.parse::<f32>() == Ok(0.0))
                        })
                })
            })
        });
    let path = if request.uri().path() == "/" {
        String::new()
    } else {
        let (mut parts, _) = request.into_parts();
        match Path::<String>::from_request_parts(&mut parts, &()).await {
            Ok(Path(path)) => path,
            Err(_) => return StatusCode::BAD_REQUEST.into_response(),
        }
    };
    // Reject decoded traversal rather than normalizing it, including Windows separators.
    if path.starts_with('/')
        || path.contains(['\\', '\0'])
        || path.split('/').any(|part| part == ".." || part == ".")
    {
        return StatusCode::BAD_REQUEST.into_response();
    }
    if reserved(&format!("/{path}")) {
        return crate::api::error(StatusCode::NOT_FOUND, "not_found", "unknown endpoint");
    }
    let file = if path.is_empty() { "index.html" } else { &path };
    match read(root, file).await {
        Ok(Some(bytes)) => return file_response(file, bytes, head),
        Ok(None) => (),
        Err(status) => return status.into_response(),
    }
    if path.is_empty() || html {
        match read(root, "index.html").await {
            Ok(Some(bytes)) => return file_response("index.html", bytes, head),
            Ok(None) => return file_response("index.html", PLACEHOLDER.as_bytes().to_vec(), head),
            Err(status) => return status.into_response(),
        }
    }
    crate::api::error(StatusCode::NOT_FOUND, "not_found", "unknown endpoint")
}

async fn read(root: &FsPath, file: &str) -> Result<Option<Vec<u8>>, StatusCode> {
    let result = async {
        let root = tokio::fs::canonicalize(root).await?;
        let path = tokio::fs::canonicalize(root.join(file)).await?;
        if !path.starts_with(&root) {
            return Ok(Err(StatusCode::FORBIDDEN));
        }
        if !tokio::fs::metadata(&path).await?.is_file() {
            return Ok(Ok(None));
        }
        tokio::fs::read(path).await.map(|bytes| Ok(Some(bytes)))
    }
    .await;
    match result {
        Ok(value) => value,
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
            ) =>
        {
            Ok(None)
        }
        Err(error) => {
            tracing::error!(%error, file, "kiosk file read failed");
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

fn file_response(file: &str, bytes: Vec<u8>, head: bool) -> Response {
    let mime = match FsPath::new(file).extension().and_then(|ext| ext.to_str()) {
        Some("html" | "htm") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json" | "map") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("txt") => "text/plain; charset=utf-8",
        Some("wasm") => "application/wasm",
        Some("webmanifest") => "application/manifest+json",
        _ => "application/octet-stream",
    };
    let cache = if file == "index.html" {
        "no-cache"
    } else if file.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    let length = bytes.len();
    let mut response = (
        [(header::CONTENT_TYPE, mime), (header::CACHE_CONTROL, cache)],
        if head {
            Body::empty()
        } else {
            Body::from(bytes)
        },
    )
        .into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_LENGTH, length.into());
    response
}
