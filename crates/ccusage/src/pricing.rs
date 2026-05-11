use std::collections::HashMap;

use serde_json::Value;

use crate::{CostMode, Speed, UsageEntry};

const LITELLM_PRICING_URL: &str =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const PROVIDER_PREFIXES: [&str; 5] = [
    "anthropic/",
    "claude-3-5-",
    "claude-3-",
    "claude-",
    "openrouter/openai/",
];

#[derive(Debug, Clone, Copy)]
pub(crate) struct Pricing {
    input: f64,
    output: f64,
    cache_create: f64,
    cache_read: f64,
    input_above_200k: Option<f64>,
    output_above_200k: Option<f64>,
    cache_create_above_200k: Option<f64>,
    cache_read_above_200k: Option<f64>,
    fast_multiplier: f64,
}

#[derive(Debug, Default)]
pub(crate) struct PricingRegistry {
    online: Option<HashMap<String, Pricing>>,
    bundled: HashMap<String, Pricing>,
}

impl PricingRegistry {
    pub(crate) async fn load(offline: bool, quiet: bool) -> Self {
        let bundled = bundled_pricing();
        if offline {
            return Self {
                online: None,
                bundled,
            };
        }
        if !quiet {
            eprintln!("Fetching latest model pricing from LiteLLM...");
        }
        match fetch_litellm_pricing().await {
            Ok(online) => Self {
                online: Some(online),
                bundled,
            },
            Err(error) => {
                if !quiet {
                    eprintln!(
                        "Failed to fetch model pricing from LiteLLM, falling back to cached pricing data"
                    );
                    eprintln!("Fetch error details: {error}");
                }
                Self {
                    online: None,
                    bundled,
                }
            }
        }
    }

    fn get(&self, model: &str) -> Option<Pricing> {
        self.online
            .as_ref()
            .and_then(|pricing| lookup_online_pricing(pricing, model))
            .or_else(|| lookup_online_pricing(&self.bundled, model))
            .or_else(|| embedded_pricing_for_model(model))
    }
}

pub(crate) fn calculate_cost(data: &UsageEntry, mode: CostMode, pricing: &PricingRegistry) -> f64 {
    match mode {
        CostMode::Display => data.cost_usd.unwrap_or(0.0),
        CostMode::Auto => data
            .cost_usd
            .unwrap_or_else(|| calculate_cost_from_tokens(data, pricing)),
        CostMode::Calculate => calculate_cost_from_tokens(data, pricing),
    }
}

fn calculate_cost_from_tokens(data: &UsageEntry, registry: &PricingRegistry) -> f64 {
    let Some(model) = data.message.model.as_deref() else {
        return 0.0;
    };
    let Some(pricing) = registry.get(model) else {
        return 0.0;
    };
    let usage = data.message.usage;
    let multiplier = if matches!(usage.speed, Some(Speed::Fast)) {
        pricing.fast_multiplier
    } else {
        1.0
    };
    (tiered_cost(usage.input_tokens, pricing.input, pricing.input_above_200k)
        + tiered_cost(
            usage.output_tokens,
            pricing.output,
            pricing.output_above_200k,
        )
        + tiered_cost(
            usage.cache_creation_input_tokens,
            pricing.cache_create,
            pricing.cache_create_above_200k,
        )
        + tiered_cost(
            usage.cache_read_input_tokens,
            pricing.cache_read,
            pricing.cache_read_above_200k,
        ))
        * multiplier
}

fn tiered_cost(tokens: u64, base: f64, above: Option<f64>) -> f64 {
    const THRESHOLD: u64 = 200_000;
    if tokens == 0 {
        return 0.0;
    }
    if let Some(above) = above {
        if tokens > THRESHOLD {
            return (THRESHOLD as f64 * base) + ((tokens - THRESHOLD) as f64 * above);
        }
    }
    tokens as f64 * base
}

async fn fetch_litellm_pricing() -> anyhow::Result<HashMap<String, Pricing>> {
    let response = reqwest::get(LITELLM_PRICING_URL)
        .await?
        .error_for_status()?;
    let data = response.json::<HashMap<String, Value>>().await?;
    let mut pricing = HashMap::new();
    for (model, value) in data {
        if let Some(parsed) = parse_pricing(&value) {
            pricing.insert(model, parsed);
        }
    }
    Ok(pricing)
}

fn bundled_pricing() -> HashMap<String, Pricing> {
    let raw = include_str!(concat!(env!("OUT_DIR"), "/claude_pricing.json"));
    serde_json::from_str::<HashMap<String, Value>>(raw)
        .ok()
        .map(parse_pricing_map)
        .unwrap_or_default()
}

fn parse_pricing_map(data: HashMap<String, Value>) -> HashMap<String, Pricing> {
    data.into_iter()
        .filter_map(|(model, value)| parse_pricing(&value).map(|pricing| (model, pricing)))
        .collect()
}

fn lookup_online_pricing(pricing: &HashMap<String, Pricing>, model: &str) -> Option<Pricing> {
    if let Some(value) = pricing.get(model).copied() {
        return Some(value);
    }
    for prefix in PROVIDER_PREFIXES {
        if let Some(value) = pricing.get(&format!("{prefix}{model}")).copied() {
            return Some(value);
        }
    }
    let lower = model.to_lowercase();
    pricing.iter().find_map(|(key, value)| {
        let comparison = key.to_lowercase();
        (comparison.contains(&lower) || lower.contains(&comparison)).then_some(*value)
    })
}

fn parse_pricing(value: &Value) -> Option<Pricing> {
    if !value.is_object() {
        return None;
    }
    Some(Pricing {
        input: number_field(value, "input_cost_per_token").unwrap_or(0.0),
        output: number_field(value, "output_cost_per_token").unwrap_or(0.0),
        cache_create: number_field(value, "cache_creation_input_token_cost").unwrap_or(0.0),
        cache_read: number_field(value, "cache_read_input_token_cost").unwrap_or(0.0),
        input_above_200k: number_field(value, "input_cost_per_token_above_200k_tokens"),
        output_above_200k: number_field(value, "output_cost_per_token_above_200k_tokens"),
        cache_create_above_200k: number_field(
            value,
            "cache_creation_input_token_cost_above_200k_tokens",
        ),
        cache_read_above_200k: number_field(value, "cache_read_input_token_cost_above_200k_tokens"),
        fast_multiplier: value
            .get("provider_specific_entry")
            .and_then(|entry| number_field(entry, "fast"))
            .unwrap_or(1.0),
    })
}

fn number_field(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

fn embedded_pricing_for_model(model: &str) -> Option<Pricing> {
    let normalized = model
        .strip_prefix("anthropic/")
        .or_else(|| model.strip_prefix("claude-"))
        .unwrap_or(model);
    let model = if model.starts_with("claude-") {
        model
    } else {
        normalized
    };
    if model.contains("opus-4-5") || model.contains("opus-4-6") || model.contains("opus-4-7") {
        Some(Pricing {
            input: 5e-6,
            output: 25e-6,
            cache_create: 6.25e-6,
            cache_read: 0.5e-6,
            input_above_200k: None,
            output_above_200k: None,
            cache_create_above_200k: None,
            cache_read_above_200k: None,
            fast_multiplier: if model.contains("opus-4-6") || model.contains("opus-4-7") {
                6.0
            } else {
                1.0
            },
        })
    } else if model.contains("haiku-4-5") {
        Some(Pricing {
            input: 1e-6,
            output: 5e-6,
            cache_create: 1.25e-6,
            cache_read: 0.1e-6,
            input_above_200k: None,
            output_above_200k: None,
            cache_create_above_200k: None,
            cache_read_above_200k: None,
            fast_multiplier: 1.0,
        })
    } else if model.contains("opus-4") {
        Some(Pricing {
            input: 15e-6,
            output: 75e-6,
            cache_create: 18.75e-6,
            cache_read: 1.5e-6,
            input_above_200k: None,
            output_above_200k: None,
            cache_create_above_200k: None,
            cache_read_above_200k: None,
            fast_multiplier: 1.0,
        })
    } else if model.contains("sonnet-4-6") {
        Some(Pricing {
            input: 3e-6,
            output: 15e-6,
            cache_create: 3.75e-6,
            cache_read: 0.3e-6,
            input_above_200k: None,
            output_above_200k: None,
            cache_create_above_200k: None,
            cache_read_above_200k: None,
            fast_multiplier: 1.0,
        })
    } else if model.contains("sonnet-4") {
        Some(Pricing {
            input: 3e-6,
            output: 15e-6,
            cache_create: 3.75e-6,
            cache_read: 0.3e-6,
            input_above_200k: Some(6e-6),
            output_above_200k: Some(22.5e-6),
            cache_create_above_200k: Some(7.5e-6),
            cache_read_above_200k: Some(0.6e-6),
            fast_multiplier: 1.0,
        })
    } else if model.contains("haiku-4") || model.contains("haiku-3-5") {
        Some(Pricing {
            input: 0.8e-6,
            output: 4e-6,
            cache_create: 1.0e-6,
            cache_read: 0.08e-6,
            input_above_200k: None,
            output_above_200k: None,
            cache_create_above_200k: None,
            cache_read_above_200k: None,
            fast_multiplier: 1.0,
        })
    } else if model.contains("opus-3") {
        Some(Pricing {
            input: 15e-6,
            output: 75e-6,
            cache_create: 18.75e-6,
            cache_read: 1.5e-6,
            input_above_200k: None,
            output_above_200k: None,
            cache_create_above_200k: None,
            cache_read_above_200k: None,
            fast_multiplier: 1.0,
        })
    } else if model.contains("sonnet-3") {
        Some(Pricing {
            input: 3e-6,
            output: 15e-6,
            cache_create: 3.75e-6,
            cache_read: 0.3e-6,
            input_above_200k: None,
            output_above_200k: None,
            cache_create_above_200k: None,
            cache_read_above_200k: None,
            fast_multiplier: 1.0,
        })
    } else if model.contains("haiku-3") {
        Some(Pricing {
            input: 0.25e-6,
            output: 1.25e-6,
            cache_create: 0.3e-6,
            cache_read: 0.03e-6,
            input_above_200k: None,
            output_above_200k: None,
            cache_create_above_200k: None,
            cache_read_above_200k: None,
            fast_multiplier: 1.0,
        })
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calculates_tiered_cost() {
        assert!((tiered_cost(300_000, 3e-6, Some(6e-6)) - 1.2).abs() < f64::EPSILON);
    }
}
