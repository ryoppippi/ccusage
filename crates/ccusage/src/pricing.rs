use std::collections::HashMap;

use serde::Deserialize;

const EMBEDDED_PRICING_JSON: &str = include_str!("claude-pricing.json");
const LITELLM_PRICING_URL: &str =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const PRICING_FETCH_TIMEOUT_SECONDS: u64 = 10;

#[derive(Debug, Clone, Copy)]
pub(crate) struct Pricing {
    pub(crate) input: f64,
    pub(crate) output: f64,
    pub(crate) cache_create: f64,
    pub(crate) cache_read: f64,
    pub(crate) input_above_200k: Option<f64>,
    pub(crate) output_above_200k: Option<f64>,
    pub(crate) cache_create_above_200k: Option<f64>,
    pub(crate) cache_read_above_200k: Option<f64>,
    pub(crate) fast_multiplier: f64,
}

#[derive(Debug, Default)]
pub(crate) struct PricingMap {
    entries: HashMap<String, Pricing>,
}

#[derive(Debug, Deserialize)]
struct LiteLlmPricing {
    input_cost_per_token: Option<f64>,
    output_cost_per_token: Option<f64>,
    cache_creation_input_token_cost: Option<f64>,
    cache_read_input_token_cost: Option<f64>,
    input_cost_per_token_above_200k_tokens: Option<f64>,
    output_cost_per_token_above_200k_tokens: Option<f64>,
    cache_creation_input_token_cost_above_200k_tokens: Option<f64>,
    cache_read_input_token_cost_above_200k_tokens: Option<f64>,
    provider_specific_entry: Option<ProviderSpecificEntry>,
}

#[derive(Debug, Deserialize)]
struct ProviderSpecificEntry {
    fast: Option<f64>,
}

impl PricingMap {
    pub(crate) fn load_embedded() -> Self {
        let mut map = Self::default();
        map.load_json(EMBEDDED_PRICING_JSON);
        map.put_fallback_pricing();
        map
    }

    pub(crate) fn load(offline: bool, log: bool) -> Self {
        let mut map = Self::load_embedded();
        if offline {
            return map;
        }

        if log {
            eprintln!("WARN  Fetching latest model pricing from LiteLLM...");
        }
        match fetch_pricing_json() {
            Ok(json) => {
                let loaded_count = map.load_json(&json);
                if log {
                    eprintln!("INFO  Loaded pricing for {loaded_count} models");
                }
            }
            Err(error) => {
                if log {
                    eprintln!(
                        "WARN  Failed to fetch LiteLLM pricing ({error}); using embedded pricing."
                    );
                }
            }
        }
        map
    }

    pub(crate) fn load_json(&mut self, json: &str) -> usize {
        let Ok(raw) = serde_json::from_str::<HashMap<String, LiteLlmPricing>>(json) else {
            return 0;
        };
        let loaded_count = raw.len();
        for (model, pricing) in raw {
            let Some(input) = pricing.input_cost_per_token else {
                continue;
            };
            let Some(output) = pricing.output_cost_per_token else {
                continue;
            };
            self.entries.insert(
                model,
                Pricing {
                    input,
                    output,
                    cache_create: pricing
                        .cache_creation_input_token_cost
                        .unwrap_or(input * 1.25),
                    cache_read: pricing.cache_read_input_token_cost.unwrap_or(input * 0.1),
                    input_above_200k: pricing.input_cost_per_token_above_200k_tokens,
                    output_above_200k: pricing.output_cost_per_token_above_200k_tokens,
                    cache_create_above_200k: pricing
                        .cache_creation_input_token_cost_above_200k_tokens,
                    cache_read_above_200k: pricing.cache_read_input_token_cost_above_200k_tokens,
                    fast_multiplier: pricing
                        .provider_specific_entry
                        .and_then(|entry| entry.fast)
                        .unwrap_or(1.0),
                },
            );
        }
        loaded_count
    }

    pub(crate) fn find(&self, model: &str) -> Option<Pricing> {
        self.entries.get(model).copied().or_else(|| {
            self.entries
                .iter()
                .filter(|(candidate, _)| model.contains(*candidate) || candidate.contains(model))
                .max_by(|(left, _), (right, _)| {
                    left.len()
                        .cmp(&right.len())
                        .then_with(|| right.cmp(left))
                })
                .map(|(_, pricing)| *pricing)
        })
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }

    fn put_fallback_pricing(&mut self) {
        self.entries.insert(
            "claude-opus-4-5".to_string(),
            Pricing {
                input: 5e-6,
                output: 25e-6,
                cache_create: 6.25e-6,
                cache_read: 0.5e-6,
                input_above_200k: None,
                output_above_200k: None,
                cache_create_above_200k: None,
                cache_read_above_200k: None,
                fast_multiplier: 1.0,
            },
        );
        self.entries.insert(
            "claude-opus-4-6".to_string(),
            Pricing {
                input: 5e-6,
                output: 25e-6,
                cache_create: 6.25e-6,
                cache_read: 0.5e-6,
                input_above_200k: None,
                output_above_200k: None,
                cache_create_above_200k: None,
                cache_read_above_200k: None,
                fast_multiplier: 6.0,
            },
        );
        self.entries.insert(
            "claude-opus-4-7".to_string(),
            Pricing {
                input: 5e-6,
                output: 25e-6,
                cache_create: 6.25e-6,
                cache_read: 0.5e-6,
                input_above_200k: None,
                output_above_200k: None,
                cache_create_above_200k: None,
                cache_read_above_200k: None,
                fast_multiplier: 6.0,
            },
        );
        self.entries.insert(
            "claude-haiku-4-5".to_string(),
            Pricing {
                input: 1e-6,
                output: 5e-6,
                cache_create: 1.25e-6,
                cache_read: 0.1e-6,
                input_above_200k: None,
                output_above_200k: None,
                cache_create_above_200k: None,
                cache_read_above_200k: None,
                fast_multiplier: 1.0,
            },
        );
        self.entries.insert(
            "claude-opus-4".to_string(),
            Pricing {
                input: 15e-6,
                output: 75e-6,
                cache_create: 18.75e-6,
                cache_read: 1.5e-6,
                input_above_200k: None,
                output_above_200k: None,
                cache_create_above_200k: None,
                cache_read_above_200k: None,
                fast_multiplier: 1.0,
            },
        );
        self.entries.insert(
            "claude-sonnet-4-6".to_string(),
            Pricing {
                input: 3e-6,
                output: 15e-6,
                cache_create: 3.75e-6,
                cache_read: 0.3e-6,
                input_above_200k: None,
                output_above_200k: None,
                cache_create_above_200k: None,
                cache_read_above_200k: None,
                fast_multiplier: 1.0,
            },
        );
        self.entries.insert(
            "claude-sonnet-4".to_string(),
            Pricing {
                input: 3e-6,
                output: 15e-6,
                cache_create: 3.75e-6,
                cache_read: 0.3e-6,
                input_above_200k: Some(6e-6),
                output_above_200k: Some(22.5e-6),
                cache_create_above_200k: Some(7.5e-6),
                cache_read_above_200k: Some(0.6e-6),
                fast_multiplier: 1.0,
            },
        );
        self.entries.insert(
            "claude-3-5-haiku".to_string(),
            Pricing {
                input: 0.8e-6,
                output: 4e-6,
                cache_create: 1.0e-6,
                cache_read: 0.08e-6,
                input_above_200k: None,
                output_above_200k: None,
                cache_create_above_200k: None,
                cache_read_above_200k: None,
                fast_multiplier: 1.0,
            },
        );
        self.entries.insert(
            "claude-3-opus".to_string(),
            Pricing {
                input: 15e-6,
                output: 75e-6,
                cache_create: 18.75e-6,
                cache_read: 1.5e-6,
                input_above_200k: None,
                output_above_200k: None,
                cache_create_above_200k: None,
                cache_read_above_200k: None,
                fast_multiplier: 1.0,
            },
        );
        self.entries.insert(
            "claude-3-sonnet".to_string(),
            Pricing {
                input: 3e-6,
                output: 15e-6,
                cache_create: 3.75e-6,
                cache_read: 0.3e-6,
                input_above_200k: None,
                output_above_200k: None,
                cache_create_above_200k: None,
                cache_read_above_200k: None,
                fast_multiplier: 1.0,
            },
        );
        self.entries.insert(
            "claude-3-haiku".to_string(),
            Pricing {
                input: 0.25e-6,
                output: 1.25e-6,
                cache_create: 0.3e-6,
                cache_read: 0.03e-6,
                input_above_200k: None,
                output_above_200k: None,
                cache_create_above_200k: None,
                cache_read_above_200k: None,
                fast_multiplier: 1.0,
            },
        );
        self.entries.insert(
            "gpt-5".to_string(),
            Pricing {
                input: 1.25e-6,
                output: 10e-6,
                cache_create: 1.25e-6,
                cache_read: 0.125e-6,
                input_above_200k: None,
                output_above_200k: None,
                cache_create_above_200k: None,
                cache_read_above_200k: None,
                fast_multiplier: 1.0,
            },
        );
        let gpt_5_codex_pricing = Pricing {
            input: 1.75e-6,
            output: 14e-6,
            cache_create: 1.75e-6,
            cache_read: 0.175e-6,
            input_above_200k: None,
            output_above_200k: None,
            cache_create_above_200k: None,
            cache_read_above_200k: None,
            fast_multiplier: 1.0,
        };
        self.entries
            .insert("gpt-5.2-codex".to_string(), gpt_5_codex_pricing);
        self.entries
            .insert("gpt-5.3-codex".to_string(), gpt_5_codex_pricing);
    }
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

#[cfg(test)]
mod tests {
    use super::{Pricing, PricingMap};

    #[test]
    fn loads_embedded_claude_pricing() {
        let pricing = PricingMap::load_embedded();
        assert!(pricing.len() > 0);
        assert!(pricing.find("claude-sonnet-4-20250514").is_some());
    }

    #[test]
    fn embedded_pricing_resolves_overlapping_model_keys_exactly() {
        let pricing = PricingMap::load_embedded();
        let sonnet_4 = pricing.find("claude-sonnet-4-20250514").unwrap();
        let sonnet_45 = pricing.find("claude-sonnet-4-5-20250929").unwrap();

        assert_eq!(pricing.find("claude-sonnet-4-20250514").unwrap().input, sonnet_4.input);
        assert_eq!(
            pricing.find("claude-sonnet-4-5-20250929").unwrap().input,
            sonnet_45.input,
        );
        assert_eq!(
            pricing
                .find("anthropic.claude-sonnet-4-20250514-v1:0")
                .unwrap()
                .input,
            sonnet_4.input,
        );
    }

    #[test]
    fn fuzzy_match_prefers_longest_model_key() {
        let mut pricing = PricingMap::default();
        pricing.entries.insert(
            "claude-sonnet-4".to_string(),
            Pricing {
                input: 1.0,
                output: 0.0,
                cache_create: 0.0,
                cache_read: 0.0,
                input_above_200k: None,
                output_above_200k: None,
                cache_create_above_200k: None,
                cache_read_above_200k: None,
                fast_multiplier: 1.0,
            },
        );
        pricing.entries.insert(
            "claude-sonnet-4-20250514".to_string(),
            Pricing {
                input: 2.0,
                output: 0.0,
                cache_create: 0.0,
                cache_read: 0.0,
                input_above_200k: None,
                output_above_200k: None,
                cache_create_above_200k: None,
                cache_read_above_200k: None,
                fast_multiplier: 1.0,
            },
        );

        let matched = pricing.find("claude-sonnet-4-20250514-via-bedrock").unwrap();

        assert_eq!(matched.input, 2.0);
    }
}
