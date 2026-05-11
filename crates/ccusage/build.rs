use std::{env, fs, path::PathBuf, process::Command};

use serde_json::{Map, Value};

const LITELLM_PRICING_URL: &str =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is required"));
    let pricing_path = out_dir.join("claude_pricing.json");
    let json = fetch_pricing()
        .and_then(|raw| filter_claude_pricing(&raw))
        .unwrap_or_else(|| "{}".to_string());
    fs::write(pricing_path, json).expect("failed to write bundled pricing");
}

fn fetch_pricing() -> Option<String> {
    let output = Command::new("curl")
        .args(["-fsSL", LITELLM_PRICING_URL])
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8(output.stdout).ok())
        .flatten()
}

fn filter_claude_pricing(raw: &str) -> Option<String> {
    let Value::Object(dataset) = serde_json::from_str::<Value>(raw).ok()? else {
        return None;
    };
    let filtered = dataset
        .into_iter()
        .filter(|(model, _)| {
            model.starts_with("claude-")
                || model.starts_with("anthropic.claude-")
                || model.starts_with("anthropic/claude-")
        })
        .collect::<Map<_, _>>();
    serde_json::to_string(&filtered).ok()
}
