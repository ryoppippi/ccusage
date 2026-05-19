use std::{env, fs, path::PathBuf};

use serde_json::{Map, Value};

const FALLBACK_PRICING_JSON: &str = "src/litellm-pricing-fallback.json";
const LITELLM_PRICING_URL: &str =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const OUT_PRICING_JSON: &str = "litellm-pricing.json";
const PRICING_JSON_PATH_ENV: &str = "CCUSAGE_PRICING_JSON_PATH";
const PRICING_FETCH_TIMEOUT_SECONDS: u64 = 10;

fn main() {
    println!("cargo:rerun-if-changed={FALLBACK_PRICING_JSON}");
    println!("cargo:rerun-if-env-changed={PRICING_JSON_PATH_ENV}");
    println!("cargo:rerun-if-env-changed=CCUSAGE_SKIP_PRICING_FETCH");

    let out_path = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set by cargo"))
        .join(OUT_PRICING_JSON);
    let pricing_json = if let Some(path) = env::var_os(PRICING_JSON_PATH_ENV) {
        let path = PathBuf::from(path);
        println!("cargo:rerun-if-changed={}", path.display());
        fs::read_to_string(path).expect("read pricing snapshot from CCUSAGE_PRICING_JSON_PATH")
    } else if env::var_os("CCUSAGE_SKIP_PRICING_FETCH").is_some() {
        fallback_pricing_json()
    } else {
        fetch_pricing_json().unwrap_or_else(|error| {
            println!("cargo:warning=failed to fetch LiteLLM pricing for embed: {error}");
            fallback_pricing_json()
        })
    };
    let pricing_json = compact_pricing_json(&pricing_json).unwrap_or(pricing_json);

    fs::write(out_path, pricing_json).expect("write build-time pricing snapshot");
}

fn fetch_pricing_json() -> std::io::Result<String> {
    let response = minreq::get(LITELLM_PRICING_URL)
        .with_timeout(PRICING_FETCH_TIMEOUT_SECONDS)
        .send()
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    if response.status_code != 200 {
        return Err(std::io::Error::other(format!(
            "HTTP {}",
            response.status_code
        )));
    }
    Ok(response
        .as_str()
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error.to_string()))?
        .to_string())
}

fn fallback_pricing_json() -> String {
    fs::read_to_string(FALLBACK_PRICING_JSON).expect("read fallback pricing snapshot")
}

fn compact_pricing_json(json: &str) -> Option<String> {
    let Value::Object(raw) = serde_json::from_str::<Value>(json).ok()? else {
        return None;
    };
    let mut compact = Map::new();
    for (model, pricing) in raw {
        if !is_embedded_model(&model) {
            continue;
        }
        let Value::Object(pricing) = pricing else {
            continue;
        };
        let mut fields = Map::new();
        for field in [
            "input_cost_per_token",
            "output_cost_per_token",
            "cache_creation_input_token_cost",
            "cache_read_input_token_cost",
            "input_cost_per_token_above_200k_tokens",
            "output_cost_per_token_above_200k_tokens",
            "cache_creation_input_token_cost_above_200k_tokens",
            "cache_read_input_token_cost_above_200k_tokens",
            "max_input_tokens",
            "provider_specific_entry",
        ] {
            let Some(value) = pricing.get(field) else {
                continue;
            };
            if !value.is_null() {
                fields.insert(field.to_string(), value.clone());
            }
        }
        if fields.contains_key("input_cost_per_token")
            && fields.contains_key("output_cost_per_token")
        {
            compact.insert(model, Value::Object(fields));
        }
    }
    serde_json::to_string(&Value::Object(compact)).ok()
}

fn is_embedded_model(model: &str) -> bool {
    model.starts_with("claude-")
        || model.starts_with("anthropic.")
        || model.starts_with("anthropic/")
        || model.starts_with("us.anthropic.")
        || model.starts_with("eu.anthropic.")
        || model.starts_with("global.anthropic.")
        || model.starts_with("jp.anthropic.")
        || model.starts_with("au.anthropic.")
        || model.starts_with("gpt-")
        || model.starts_with("openai/")
        || model.starts_with("azure/")
        || model.starts_with("openrouter/openai/")
}
