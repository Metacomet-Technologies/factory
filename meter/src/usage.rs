use serde_json::Value;
use shared::RequestRecord;

/// Inspect a copy of bytes without waiting for later frames or changing their contents.
#[derive(Default)]
pub struct UsageParser {
    pending: Vec<u8>,
    pub lines: bool,
}

impl UsageParser {
    pub fn feed(&mut self, bytes: &[u8], record: &mut RequestRecord) {
        self.pending.extend_from_slice(bytes);
        if self.lines {
            while let Some(end) = self.pending.iter().position(|b| *b == b'\n') {
                parse(&self.pending[..end], record);
                self.pending.drain(..=end);
            }
        }
    }

    pub fn finish(&mut self, record: &mut RequestRecord) {
        parse(&self.pending, record);
        if record.status >= 400 && record.error.is_none() && !self.pending.is_empty() {
            record.error = Some(String::from_utf8_lossy(&self.pending).into_owned());
        }
        self.pending.clear();
    }
}

fn parse(bytes: &[u8], record: &mut RequestRecord) {
    let bytes = bytes.strip_prefix(b"data:").unwrap_or(bytes);
    let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
        return;
    };
    if let Some(model) = value["model"].as_str() {
        record.model = Some(model.to_owned());
    }
    if let Some(error) = value.get("error") {
        record.error = Some(
            error
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| error.to_string()),
        );
    }
    macro_rules! capture {
        ($($field:ident),*) => { $(if let Some(n) = value[stringify!($field)].as_u64() {
            record.$field = Some(n);
        })* };
    }
    capture!(
        prompt_eval_count,
        eval_count,
        load_duration,
        prompt_eval_duration,
        eval_duration,
        total_duration
    );
    if let Some(usage) = value.get("usage").filter(|v| v.is_object()) {
        record.usage = Some(usage.clone());
        record.prompt_eval_count = usage["prompt_tokens"].as_u64();
        record.eval_count = usage["completion_tokens"].as_u64();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ollama_generate_and_chat_stream_and_json() {
        for endpoint in ["/api/generate", "/api/chat"] {
            for lines in [false, true] {
                let mut record = RequestRecord {
                    endpoint: endpoint.into(),
                    ..Default::default()
                };
                let mut parser = UsageParser {
                    lines,
                    ..Default::default()
                };
                let final_chunk = br#"{"model":"factory-assist","done":true,"prompt_eval_count":17,"eval_count":3,"load_duration":11,"prompt_eval_duration":120,"eval_duration":240,"total_duration":400}"#;
                if lines {
                    parser.feed(b"{\"response\":\"hi\",\"done\":false}\n", &mut record);
                }
                for part in final_chunk.chunks(7) {
                    parser.feed(part, &mut record);
                }
                parser.finish(&mut record);
                assert_eq!(record.model.as_deref(), Some("factory-assist"));
                assert_eq!(
                    (record.prompt_eval_count, record.eval_count),
                    (Some(17), Some(3))
                );
                assert_eq!(
                    (
                        record.load_duration,
                        record.prompt_eval_duration,
                        record.eval_duration,
                        record.total_duration
                    ),
                    (Some(11), Some(120), Some(240), Some(400))
                );
            }
        }
    }

    #[test]
    fn openai_json_sse_missing_usage_and_errors() {
        for lines in [false, true] {
            let mut record = RequestRecord::default();
            let mut parser = UsageParser {
                lines,
                ..Default::default()
            };
            let json =
                br#"{"model":"factory-code","usage":{"prompt_tokens":19,"completion_tokens":5}}"#;
            if lines {
                parser.feed(b"data: {\"usage\":null}\n\n data: ignored\n", &mut record);
                parser.feed(b"data: ", &mut record);
            }
            for part in json.chunks(3) {
                parser.feed(part, &mut record);
            }
            if lines {
                parser.feed(b"\n\ndata: [DONE]\n\n", &mut record);
            }
            parser.finish(&mut record);
            assert_eq!(
                (record.prompt_eval_count, record.eval_count),
                (Some(19), Some(5))
            );
            assert_eq!(record.usage.as_ref().unwrap()["prompt_tokens"], 19);
            let mut missing = RequestRecord::default();
            let bytes = if lines {
                b"data: {\"choices\":[],\"usage\":null}\n\ndata: [DONE]\n".as_slice()
            } else {
                b"{\"choices\":[]}".as_slice()
            };
            parser.feed(bytes, &mut missing);
            parser.finish(&mut missing);
            assert_eq!(
                (missing.prompt_eval_count, missing.eval_count, missing.usage),
                (None, None, None)
            );
        }
        let mut parser = UsageParser::default();
        let mut record = RequestRecord::default();
        parser.feed(
            br#"{"choices":[],"error":{"message":"missing model"}}"#,
            &mut record,
        );
        parser.finish(&mut record);
        assert_eq!(record.prompt_eval_count, None);
        assert!(record.error.unwrap().contains("missing model"));
        let mut record = RequestRecord::default();
        parser.feed(b"{\"error\":\"failed\"}\n", &mut record);
        parser.finish(&mut record);
        assert_eq!(record.error.as_deref(), Some("failed"));
    }
}
