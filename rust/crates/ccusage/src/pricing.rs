use std::time::Duration;

use serde::Deserialize;

use crate::fast::FxHashMap;

const BUILD_TIME_PRICING_JSON: &str =
    include_str!(concat!(env!("OUT_DIR"), "/litellm-pricing.json"));
const FAST_MULTIPLIER_OVERRIDES_JSON: &str = include_str!("fast-multiplier-overrides.json");
const FALLBACK_PRICING_JSON: &str = include_str!("litellm-pricing-fallback.json");
const LITELLM_PRICING_URL: &str =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const PRICING_FETCH_TIMEOUT_SECONDS: u64 = 10;
const PRICING_FETCH_MAX_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy)]
pub(crate) struct Pricing {
    pub(crate) input: f64,
    pub(crate) output: f64,
    pub(crate) cache_create: f64,
    pub(crate) cache_read: f64,
    pub(crate) cache_read_explicit: bool,
    pub(crate) input_above_200k: Option<f64>,
    pub(crate) output_above_200k: Option<f64>,
    pub(crate) cache_create_above_200k: Option<f64>,
    pub(crate) cache_read_above_200k: Option<f64>,
    pub(crate) fast_multiplier: f64,
}

#[derive(Debug, Default)]
pub(crate) struct PricingMap {
    entries: FxHashMap<String, Pricing>,
    context_limits: FxHashMap<String, u64>,
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
    max_input_tokens: Option<u64>,
    provider_specific_entry: Option<ProviderSpecificEntry>,
}

#[derive(Debug, Deserialize)]
struct ProviderSpecificEntry {
    fast: Option<f64>,
}

#[derive(Debug, Default, Deserialize)]
struct FastMultiplierOverrides {
    exact: FxHashMap<String, f64>,
    normalized_prefix: FxHashMap<String, f64>,
}

impl FastMultiplierOverrides {
    fn load() -> Self {
        serde_json::from_str(FAST_MULTIPLIER_OVERRIDES_JSON)
            .expect("parse embedded fast-multiplier-overrides.json")
    }

    fn multiplier_for(&self, model: &str) -> Option<f64> {
        if let Some(multiplier) = self.exact.get(model) {
            return Some(*multiplier);
        }
        let normalized = model.replace(['.', '@'], "-");
        normalized.split(['/', ':']).find_map(|part| {
            self.normalized_prefix
                .iter()
                .find_map(|(base, multiplier)| {
                    matches_model_suffix(part, base).then_some(*multiplier)
                })
        })
    }
}

impl PricingMap {
    pub(crate) fn load_embedded() -> Self {
        let mut map = Self::default();
        let fast_multiplier_overrides = FastMultiplierOverrides::load();
        map.load_json_with_overrides(BUILD_TIME_PRICING_JSON, &fast_multiplier_overrides);
        map.load_json_with_overrides(FALLBACK_PRICING_JSON, &fast_multiplier_overrides);
        map.put_fallback_pricing(&fast_multiplier_overrides);
        map
    }

    pub(crate) fn load(offline: bool, log: bool) -> Self {
        let mut map = Self::load_embedded();
        if offline {
            return map;
        }

        let fetch_result = crate::progress::track_status(
            log && crate::progress::usage_load_output_is_tty(),
            "Refreshing model pricing from LiteLLM...",
            fetch_pricing_json,
        );

        match fetch_result {
            Ok(json) => {
                let loaded_count = map.load_json(&json);
                if loaded_count == 0 && should_log_pricing_refresh_details() {
                    eprintln!("WARN  Failed to parse LiteLLM pricing; using embedded pricing.");
                }
            }
            Err(error) => {
                if should_log_pricing_refresh_details() {
                    eprintln!(
                        "WARN  Failed to fetch LiteLLM pricing ({error}); using embedded pricing."
                    );
                }
            }
        }
        map
    }

    pub(crate) fn load_json(&mut self, json: &str) -> usize {
        let fast_multiplier_overrides = FastMultiplierOverrides::load();
        self.load_json_with_overrides(json, &fast_multiplier_overrides)
    }

    fn load_json_with_overrides(
        &mut self,
        json: &str,
        fast_multiplier_overrides: &FastMultiplierOverrides,
    ) -> usize {
        let Ok(raw) = serde_json::from_str::<FxHashMap<String, serde_json::Value>>(json) else {
            return 0;
        };
        let mut loaded_count = 0;
        for (model, value) in raw {
            let Ok(pricing) = serde_json::from_value::<LiteLlmPricing>(value) else {
                continue;
            };
            let Some(input) = pricing.input_cost_per_token else {
                continue;
            };
            let Some(output) = pricing.output_cost_per_token else {
                continue;
            };
            let context_limit = pricing.max_input_tokens;
            let cache_read_explicit = pricing.cache_read_input_token_cost.is_some();
            let fast_multiplier = pricing
                .provider_specific_entry
                .and_then(|entry| entry.fast)
                .or_else(|| fast_multiplier_overrides.multiplier_for(&model))
                .unwrap_or(1.0);
            self.entries.insert(
                model.clone(),
                Pricing {
                    input,
                    output,
                    cache_create: pricing
                        .cache_creation_input_token_cost
                        .unwrap_or(input * 1.25),
                    cache_read: pricing.cache_read_input_token_cost.unwrap_or(input * 0.1),
                    cache_read_explicit,
                    input_above_200k: pricing.input_cost_per_token_above_200k_tokens,
                    output_above_200k: pricing.output_cost_per_token_above_200k_tokens,
                    cache_create_above_200k: pricing
                        .cache_creation_input_token_cost_above_200k_tokens,
                    cache_read_above_200k: pricing.cache_read_input_token_cost_above_200k_tokens,
                    fast_multiplier,
                },
            );
            if let Some(context_limit) = context_limit {
                self.context_limits.insert(model, context_limit);
            }
            loaded_count += 1;
        }
        loaded_count
    }

    pub(crate) fn find(&self, model: &str) -> Option<Pricing> {
        self.entries.get(model).copied().or_else(|| {
            self.entries
                .iter()
                .filter(|(candidate, _)| model.contains(*candidate) || candidate.contains(model))
                .max_by(|(left, _), (right, _)| {
                    left.len().cmp(&right.len()).then_with(|| right.cmp(left))
                })
                .map(|(_, pricing)| *pricing)
        })
    }

    pub(crate) fn context_limit(&self, model: &str) -> Option<u64> {
        self.context_limits.get(model).copied().or_else(|| {
            self.context_limits
                .iter()
                .filter(|(candidate, _)| model.contains(*candidate) || candidate.contains(model))
                .max_by(|(left, _), (right, _)| {
                    left.len().cmp(&right.len()).then_with(|| right.cmp(left))
                })
                .map(|(_, context_limit)| *context_limit)
        })
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }

    fn put_fallback_pricing(&mut self, fast_multiplier_overrides: &FastMultiplierOverrides) {
        self.entries.insert(
            "claude-opus-4-5".to_string(),
            Pricing {
                input: 5e-6,
                output: 25e-6,
                cache_create: 6.25e-6,
                cache_read: 0.5e-6,
                cache_read_explicit: true,
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
                cache_read_explicit: true,
                input_above_200k: None,
                output_above_200k: None,
                cache_create_above_200k: None,
                cache_read_above_200k: None,
                fast_multiplier: fast_multiplier_overrides
                    .multiplier_for("claude-opus-4-6")
                    .unwrap_or(1.0),
            },
        );
        self.entries.insert(
            "claude-opus-4-7".to_string(),
            Pricing {
                input: 5e-6,
                output: 25e-6,
                cache_create: 6.25e-6,
                cache_read: 0.5e-6,
                cache_read_explicit: true,
                input_above_200k: None,
                output_above_200k: None,
                cache_create_above_200k: None,
                cache_read_above_200k: None,
                fast_multiplier: fast_multiplier_overrides
                    .multiplier_for("claude-opus-4-7")
                    .unwrap_or(1.0),
            },
        );
        self.entries.insert(
            "claude-haiku-4-5".to_string(),
            Pricing {
                input: 1e-6,
                output: 5e-6,
                cache_create: 1.25e-6,
                cache_read: 0.1e-6,
                cache_read_explicit: true,
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
                cache_read_explicit: true,
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
                cache_read_explicit: true,
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
                cache_read_explicit: true,
                input_above_200k: Some(6e-6),
                output_above_200k: Some(22.5e-6),
                cache_create_above_200k: Some(7.5e-6),
                cache_read_above_200k: Some(0.6e-6),
                fast_multiplier: 1.0,
            },
        );
        let claude_3_5_haiku = Pricing {
            input: 0.8e-6,
            output: 4e-6,
            cache_create: 1.0e-6,
            cache_read: 0.08e-6,
            cache_read_explicit: true,
            input_above_200k: None,
            output_above_200k: None,
            cache_create_above_200k: None,
            cache_read_above_200k: None,
            fast_multiplier: 1.0,
        };
        self.entries
            .insert("claude-3-5-haiku".to_string(), claude_3_5_haiku);
        self.entries
            .insert("claude-3-5-haiku-20241022".to_string(), claude_3_5_haiku);
        self.entries.insert(
            "claude-3-opus".to_string(),
            Pricing {
                input: 15e-6,
                output: 75e-6,
                cache_create: 18.75e-6,
                cache_read: 1.5e-6,
                cache_read_explicit: true,
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
                cache_read_explicit: true,
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
                cache_read_explicit: true,
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
                cache_read_explicit: true,
                input_above_200k: None,
                output_above_200k: None,
                cache_create_above_200k: None,
                cache_read_above_200k: None,
                fast_multiplier: 1.0,
            },
        );
        self.entries.insert(
            "gpt-5.5".to_string(),
            Pricing {
                input: 5e-6,
                output: 30e-6,
                cache_create: 5e-6,
                cache_read: 0.5e-6,
                cache_read_explicit: true,
                input_above_200k: None,
                output_above_200k: None,
                cache_create_above_200k: None,
                cache_read_above_200k: None,
                fast_multiplier: fast_multiplier_overrides
                    .multiplier_for("gpt-5.5")
                    .unwrap_or(1.0),
            },
        );
        self.entries.insert(
            "grok-4.3".to_string(),
            Pricing {
                input: 1.25e-6,
                output: 2.5e-6,
                cache_create: 1.25e-6,
                cache_read: 0.125e-6,
                cache_read_explicit: false,
                input_above_200k: None,
                output_above_200k: None,
                cache_create_above_200k: None,
                cache_read_above_200k: None,
                fast_multiplier: 1.0,
            },
        );
        let gpt_5_1_pricing = Pricing {
            input: 1.25e-6,
            output: 10e-6,
            cache_create: 1.25e-6,
            cache_read: 0.125e-6,
            cache_read_explicit: true,
            input_above_200k: None,
            output_above_200k: None,
            cache_create_above_200k: None,
            cache_read_above_200k: None,
            fast_multiplier: 1.0,
        };
        self.entries.insert("gpt-5.1".to_string(), gpt_5_1_pricing);
        self.entries
            .insert("gpt-5.1-codex".to_string(), gpt_5_1_pricing);
        let gpt_5_codex_pricing = Pricing {
            input: 1.75e-6,
            output: 14e-6,
            cache_create: 1.75e-6,
            cache_read: 0.175e-6,
            cache_read_explicit: true,
            input_above_200k: None,
            output_above_200k: None,
            cache_create_above_200k: None,
            cache_read_above_200k: None,
            fast_multiplier: 1.0,
        };
        self.entries
            .insert("gpt-5.2-codex".to_string(), gpt_5_codex_pricing);
        self.entries.insert(
            "gpt-5.3-codex".to_string(),
            Pricing {
                fast_multiplier: fast_multiplier_overrides
                    .multiplier_for("gpt-5.3-codex")
                    .unwrap_or(1.0),
                ..gpt_5_codex_pricing
            },
        );
        self.entries
            .insert("gpt-5.2".to_string(), gpt_5_codex_pricing);
        self.entries.insert(
            "gpt-5.4".to_string(),
            Pricing {
                input: 2.5e-6,
                output: 15e-6,
                cache_create: 2.5e-6,
                cache_read: 0.25e-6,
                cache_read_explicit: true,
                input_above_200k: None,
                output_above_200k: None,
                cache_create_above_200k: None,
                cache_read_above_200k: None,
                fast_multiplier: fast_multiplier_overrides
                    .multiplier_for("gpt-5.4")
                    .unwrap_or(1.0),
            },
        );
        self.entries.insert(
            "gpt-5.4-mini".to_string(),
            Pricing {
                input: 0.75e-6,
                output: 4.5e-6,
                cache_create: 0.75e-6,
                cache_read: 0.075e-6,
                cache_read_explicit: true,
                input_above_200k: None,
                output_above_200k: None,
                cache_create_above_200k: None,
                cache_read_above_200k: None,
                fast_multiplier: 1.0,
            },
        );
        self.entries.insert(
            "gpt-5.4-nano".to_string(),
            Pricing {
                input: 0.2e-6,
                output: 1.25e-6,
                cache_create: 0.2e-6,
                cache_read: 0.02e-6,
                cache_read_explicit: true,
                input_above_200k: None,
                output_above_200k: None,
                cache_create_above_200k: None,
                cache_read_above_200k: None,
                fast_multiplier: 1.0,
            },
        );
        self.context_limits.insert("gpt-5.5".to_string(), 1_050_000);
        self.context_limits
            .insert("grok-4.3".to_string(), 1_000_000);
        self.context_limits.insert("gpt-5.4".to_string(), 1_050_000);

        for model in [
            "claude-opus-4-5",
            "claude-opus-4-6",
            "claude-opus-4-7",
            "claude-haiku-4-5",
            "claude-opus-4",
            "claude-sonnet-4-6",
            "claude-sonnet-4",
            "claude-3-5-haiku",
            "claude-3-5-haiku-20241022",
            "claude-3-opus",
            "claude-3-sonnet",
            "claude-3-haiku",
        ] {
            self.context_limits.insert(model.to_string(), 200_000);
        }
    }
}

fn matches_model_suffix(part: &str, base: &str) -> bool {
    let Some(index) = part.rfind(base) else {
        return false;
    };
    let suffix = &part[index..];
    suffix == base || suffix.as_bytes().get(base.len()) == Some(&b'-')
}

fn should_log_pricing_refresh_details() -> bool {
    crate::log_level().is_some_and(|level| level >= 4)
}

fn fetch_pricing_json() -> std::io::Result<String> {
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(PRICING_FETCH_TIMEOUT_SECONDS)))
        .build()
        .new_agent();
    let mut response = agent
        .get(LITELLM_PRICING_URL)
        .call()
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    if response.status().as_u16() != 200 {
        return Err(std::io::Error::other(format!(
            "HTTP {}",
            response.status().as_u16()
        )));
    }
    response
        .body_mut()
        .with_config()
        .limit(PRICING_FETCH_MAX_BYTES)
        .read_to_string()
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::{Pricing, PricingMap, BUILD_TIME_PRICING_JSON, FALLBACK_PRICING_JSON};

    #[test]
    fn loads_embedded_claude_pricing() {
        let pricing = PricingMap::load_embedded();
        assert!(pricing.len() > 0);
        assert!(pricing.find("claude-sonnet-4-20250514").is_some());
    }

    #[test]
    fn reads_embedded_model_context_limits() {
        let pricing = PricingMap::load_embedded();

        assert_eq!(
            pricing.context_limit("anthropic.claude-3-5-sonnet-20240620-v1:0"),
            Some(1_000_000)
        );
    }

    #[test]
    fn embedded_pricing_includes_hermes_frontier_models() {
        let pricing = PricingMap::load_embedded();

        assert!(pricing.find("gpt-5.5").is_some());
        assert!(pricing.find("grok-4.3").is_some());
        assert_eq!(pricing.context_limit("grok-4.3"), Some(1_000_000));
    }

    #[test]
    fn records_whether_cache_read_rate_came_from_litellm_pricing() {
        let mut pricing = PricingMap::default();
        pricing.load_json(
            r#"{
                "gpt-with-cache": {
                    "input_cost_per_token": 0.000001,
                    "output_cost_per_token": 0.000010,
                    "cache_read_input_token_cost": 0.0000001
                },
                "gpt-without-cache": {
                    "input_cost_per_token": 0.000001,
                    "output_cost_per_token": 0.000010
                }
            }"#,
        );

        assert!(pricing.find("gpt-with-cache").unwrap().cache_read_explicit);
        assert!(
            !pricing
                .find("gpt-without-cache")
                .unwrap()
                .cache_read_explicit
        );
    }

    #[test]
    fn skips_invalid_litellm_entries_without_discarding_valid_pricing() {
        let mut pricing = PricingMap::default();
        let loaded = pricing.load_json(
            r#"{
                "sample_spec": {
                    "max_input_tokens": "max input tokens, if the provider specifies it"
                },
                "gpt-valid": {
                    "input_cost_per_token": 0.000001,
                    "output_cost_per_token": 0.000010,
                    "max_input_tokens": 123
                }
            }"#,
        );

        assert_eq!(loaded, 1);
        assert!(pricing.find("gpt-valid").is_some());
        assert_eq!(pricing.context_limit("gpt-valid"), Some(123));
    }

    #[test]
    fn embedded_pricing_resolves_overlapping_model_keys_exactly() {
        let pricing = PricingMap::load_embedded();
        let sonnet_4 = pricing.find("claude-sonnet-4-20250514").unwrap();
        let sonnet_45 = pricing.find("claude-sonnet-4-5-20250929").unwrap();

        assert_eq!(
            pricing.find("claude-sonnet-4-20250514").unwrap().input,
            sonnet_4.input
        );
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
        assert_eq!(
            pricing.find("claude-3-5-haiku-20241022").unwrap().input,
            0.8e-6,
        );
    }

    #[test]
    fn embedded_pricing_includes_gpt_5_5_for_offline_codex_reports() {
        let pricing = PricingMap::load_embedded();
        let gpt_55 = pricing.find("gpt-5.5").unwrap();

        assert_eq!(gpt_55.input, 5e-6);
        assert_eq!(gpt_55.output, 30e-6);
        assert_eq!(gpt_55.cache_read, 0.5e-6);
        assert!(gpt_55.cache_read_explicit);
        assert_eq!(gpt_55.fast_multiplier, 2.5);
        assert_eq!(pricing.context_limit("gpt-5.5"), Some(1_050_000));
    }

    #[test]
    fn embedded_pricing_includes_codex_priority_multiplier() {
        let pricing = PricingMap::load_embedded();

        assert_eq!(pricing.find("gpt-5.5").unwrap().fast_multiplier, 2.5);
        assert_eq!(pricing.find("gpt-5.4").unwrap().fast_multiplier, 2.0);
        assert_eq!(pricing.find("gpt-5.3-codex").unwrap().fast_multiplier, 2.0);
    }

    #[test]
    fn embedded_pricing_includes_claude_fast_multiplier_for_provider_models() {
        let pricing = PricingMap::load_embedded();

        assert_eq!(
            pricing
                .find("anthropic.claude-opus-4-6-v1")
                .unwrap()
                .fast_multiplier,
            6.0
        );
        assert_eq!(
            pricing
                .find("anthropic.claude-opus-4-7")
                .unwrap()
                .fast_multiplier,
            6.0
        );
    }

    #[test]
    fn fills_codex_fast_multiplier_when_litellm_pricing_omits_it() {
        let mut pricing = PricingMap::default();
        pricing.load_json(
            r#"{
                "gpt-5.5": {
                    "input_cost_per_token": 0.000005,
                    "output_cost_per_token": 0.000030,
                    "cache_read_input_token_cost": 0.0000005
                },
                "gpt-5.4": {
                    "input_cost_per_token": 0.0000025,
                    "output_cost_per_token": 0.000015,
                    "cache_read_input_token_cost": 0.00000025
                },
                "gpt-5.3-codex": {
                    "input_cost_per_token": 0.00000175,
                    "output_cost_per_token": 0.000014,
                    "cache_read_input_token_cost": 0.000000175
                },
                "gpt-5.2-codex": {
                    "input_cost_per_token": 0.00000175,
                    "output_cost_per_token": 0.000014,
                    "cache_read_input_token_cost": 0.000000175
                }
            }"#,
        );

        assert_eq!(pricing.find("gpt-5.5").unwrap().fast_multiplier, 2.5);
        assert_eq!(pricing.find("gpt-5.4").unwrap().fast_multiplier, 2.0);
        assert_eq!(pricing.find("gpt-5.3-codex").unwrap().fast_multiplier, 2.0);
        assert_eq!(pricing.find("gpt-5.2-codex").unwrap().fast_multiplier, 1.0);
    }

    #[test]
    fn fills_claude_fast_multiplier_when_litellm_pricing_omits_it() {
        let mut pricing = PricingMap::default();
        pricing.load_json(
            r#"{
                "vertex_ai/claude-opus-4-7@default": {
                    "input_cost_per_token": 0.000005,
                    "output_cost_per_token": 0.000025
                },
                "openrouter/anthropic/claude-opus-4.7": {
                    "input_cost_per_token": 0.000005,
                    "output_cost_per_token": 0.000025
                },
                "claude-opus-4.7-20260416": {
                    "input_cost_per_token": 0.000005,
                    "output_cost_per_token": 0.000025
                },
                "claude-opus-4-70": {
                    "input_cost_per_token": 0.000005,
                    "output_cost_per_token": 0.000025
                }
            }"#,
        );

        assert_eq!(
            pricing
                .find("vertex_ai/claude-opus-4-7@default")
                .unwrap()
                .fast_multiplier,
            6.0
        );
        assert_eq!(
            pricing
                .find("openrouter/anthropic/claude-opus-4.7")
                .unwrap()
                .fast_multiplier,
            6.0
        );
        assert_eq!(
            pricing
                .find("claude-opus-4.7-20260416")
                .unwrap()
                .fast_multiplier,
            6.0
        );
        assert_eq!(
            pricing.find("claude-opus-4-70").unwrap().fast_multiplier,
            1.0
        );
    }

    #[test]
    fn embedded_build_time_pricing_is_compact() {
        assert!(BUILD_TIME_PRICING_JSON.len() < 200_000);
        assert!(FALLBACK_PRICING_JSON.len() < 100_000);
        assert!(!BUILD_TIME_PRICING_JSON.contains("\"source\""));
        assert!(!FALLBACK_PRICING_JSON.contains("\"source\""));
        assert!(!BUILD_TIME_PRICING_JSON.contains("vertex_ai/"));
        assert!(BUILD_TIME_PRICING_JSON.contains("claude-sonnet-4-20250514"));
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
                cache_read_explicit: true,
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
                cache_read_explicit: true,
                input_above_200k: None,
                output_above_200k: None,
                cache_create_above_200k: None,
                cache_read_above_200k: None,
                fast_multiplier: 1.0,
            },
        );

        let matched = pricing
            .find("claude-sonnet-4-20250514-via-bedrock")
            .unwrap();

        assert_eq!(matched.input, 2.0);
    }
}
