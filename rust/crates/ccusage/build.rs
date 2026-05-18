use std::{env, fs, path::PathBuf};

const FALLBACK_PRICING_JSON: &str = "src/litellm-pricing-fallback.json";
const LITELLM_PRICING_URL: &str =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const OUT_PRICING_JSON: &str = "litellm-pricing.json";
const PRICING_FETCH_TIMEOUT_SECONDS: u64 = 10;

fn main() {
    println!("cargo:rerun-if-changed={FALLBACK_PRICING_JSON}");
    println!("cargo:rerun-if-env-changed=CCUSAGE_SKIP_PRICING_FETCH");

    let out_path = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set by cargo"))
        .join(OUT_PRICING_JSON);
    let pricing_json = if env::var_os("CCUSAGE_SKIP_PRICING_FETCH").is_some() {
        fallback_pricing_json()
    } else {
        fetch_pricing_json().unwrap_or_else(|error| {
            println!("cargo:warning=failed to fetch LiteLLM pricing for embed: {error}");
            fallback_pricing_json()
        })
    };

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
