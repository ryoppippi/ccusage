use std::{
    borrow::Cow,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use serde::Deserialize;

use crate::fast::FxHashMap;

const BUILD_TIME_PRICING_JSON: &str =
    include_str!(concat!(env!("OUT_DIR"), "/litellm-pricing.json"));
const FAST_MULTIPLIER_OVERRIDES_JSON: &str = include_str!("fast-multiplier-overrides.json");
const LITELLM_PRICING_URL: &str =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const MODELS_DEV_API_URL: &str = "https://models.dev/api.json";
const PRICING_FETCH_TIMEOUT_SECONDS: u64 = 10;
const PRICING_FETCH_MAX_BYTES: u64 = 64 * 1024 * 1024;
const MODELS_DEV_FAILURE_RETRY_AFTER: Duration = Duration::from_secs(60);
// Anthropic date-suffixed model aliases use YYYYMMDD, while other numeric
// suffixes are treated as distinct model versions.
const MODEL_DATE_SUFFIX_DIGITS: usize = 8;

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
    enable_models_dev_fallback: bool,
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

#[derive(Debug, Deserialize)]
struct ModelsDevProvider {
    models: FxHashMap<String, ModelsDevModel>,
}

struct ModelsDevPricingCache {
    pricing: OnceLock<PricingMap>,
    last_failure: Mutex<Option<Instant>>,
    failure_retry_after: Duration,
}

impl ModelsDevPricingCache {
    const fn new(failure_retry_after: Duration) -> Self {
        Self {
            pricing: OnceLock::new(),
            last_failure: Mutex::new(None),
            failure_retry_after,
        }
    }

    fn get_or_try_load<F>(&self, fetch_json: F) -> Option<&PricingMap>
    where
        F: FnOnce() -> std::io::Result<String>,
    {
        if let Some(pricing) = self.pricing.get() {
            return Some(pricing);
        }
        if self.last_failure.lock().is_ok_and(|last_failure| {
            last_failure.is_some_and(|failed_at| failed_at.elapsed() < self.failure_retry_after)
        }) {
            return None;
        }

        let Some(map) = load_models_dev_pricing(fetch_json) else {
            if let Ok(mut last_failure) = self.last_failure.lock() {
                *last_failure = Some(Instant::now());
            }
            return None;
        };
        let _ = self.pricing.set(map);
        if let Ok(mut last_failure) = self.last_failure.lock() {
            *last_failure = None;
        }
        self.pricing.get()
    }
}

#[derive(Debug, Deserialize)]
struct ModelsDevModel {
    id: Option<String>,
    cost: Option<ModelsDevCost>,
    limit: Option<ModelsDevLimit>,
}

#[derive(Debug, Deserialize)]
struct ModelsDevCost {
    input: Option<f64>,
    output: Option<f64>,
    cache_read: Option<f64>,
    cache_write: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct ModelsDevLimit {
    context: Option<u64>,
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
        map.put_builtin_pricing(&fast_multiplier_overrides);
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

        map.enable_models_dev_fallback = true;
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

    fn load_models_dev_json_missing(&mut self, json: &str) -> Option<usize> {
        let Ok(raw) = serde_json::from_str::<FxHashMap<String, ModelsDevProvider>>(json) else {
            return None;
        };
        let mut loaded_count = 0;
        for provider in raw.into_values() {
            for (model_key, model) in provider.models {
                let model_id = model.id.unwrap_or(model_key);
                if self.entries.contains_key(&model_id) {
                    continue;
                }
                let Some(cost) = model.cost else {
                    continue;
                };
                let Some(input) = cost.input else {
                    continue;
                };
                let Some(output) = cost.output else {
                    continue;
                };
                let input = input / 1_000_000.0;
                let output = output / 1_000_000.0;
                let cache_read_explicit = cost.cache_read.is_some();
                self.entries.insert(
                    model_id.clone(),
                    Pricing {
                        input,
                        output,
                        cache_create: cost
                            .cache_write
                            .map(|value| value / 1_000_000.0)
                            .unwrap_or(input * 1.25),
                        cache_read: cost
                            .cache_read
                            .map(|value| value / 1_000_000.0)
                            .unwrap_or(input * 0.1),
                        cache_read_explicit,
                        input_above_200k: None,
                        output_above_200k: None,
                        cache_create_above_200k: None,
                        cache_read_above_200k: None,
                        fast_multiplier: 1.0,
                    },
                );
                if let Some(context_limit) = model.limit.and_then(|limit| limit.context) {
                    self.context_limits.insert(model_id, context_limit);
                }
                loaded_count += 1;
            }
        }
        Some(loaded_count)
    }

    pub(crate) fn find(&self, model: &str) -> Option<Pricing> {
        self.find_entry(model).or_else(|| {
            self.enable_models_dev_fallback
                .then(|| models_dev_pricing().and_then(|pricing| pricing.find_entry(model)))
                .flatten()
        })
    }

    fn find_entry(&self, model: &str) -> Option<Pricing> {
        self.entries.get(model).copied().or_else(|| {
            let normalized_model = normalized_pricing_key(model);
            self.entries
                .iter()
                .filter(|(candidate, _)| {
                    pricing_key_matches(candidate, model, normalized_model.as_ref())
                })
                .max_by(|(left, _), (right, _)| {
                    left.len().cmp(&right.len()).then_with(|| right.cmp(left))
                })
                .map(|(_, pricing)| *pricing)
        })
    }

    pub(crate) fn context_limit(&self, model: &str) -> Option<u64> {
        self.context_limit_entry(model).or_else(|| {
            self.enable_models_dev_fallback
                .then(|| {
                    models_dev_pricing().and_then(|pricing| pricing.context_limit_entry(model))
                })
                .flatten()
        })
    }

    fn context_limit_entry(&self, model: &str) -> Option<u64> {
        self.context_limits.get(model).copied().or_else(|| {
            let normalized_model = normalized_pricing_key(model);
            self.context_limits
                .iter()
                .filter(|(candidate, _)| {
                    pricing_key_matches(candidate, model, normalized_model.as_ref())
                })
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

    #[cfg(test)]
    fn models_dev_fallback_enabled(&self) -> bool {
        self.enable_models_dev_fallback
    }

    fn put_builtin_pricing(&mut self, fast_multiplier_overrides: &FastMultiplierOverrides) {
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
            "claude-opus-4-8".to_string(),
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
                    .multiplier_for("claude-opus-4-8")
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
        // Source: https://platform.kimi.ai/docs/pricing/chat-k25
        self.entries.insert(
            "moonshot/kimi-k2.5".to_string(),
            Pricing {
                input: 0.6e-6,
                output: 3e-6,
                cache_create: 0.75e-6,
                cache_read: 0.1e-6,
                cache_read_explicit: true,
                input_above_200k: None,
                output_above_200k: None,
                cache_create_above_200k: None,
                cache_read_above_200k: None,
                fast_multiplier: 1.0,
            },
        );
        // Source: https://platform.kimi.ai/docs/pricing/chat-k26
        self.entries.insert(
            "moonshot/kimi-k2.6".to_string(),
            Pricing {
                input: 0.95e-6,
                output: 4e-6,
                cache_create: 1.1875e-6,
                cache_read: 0.16e-6,
                cache_read_explicit: true,
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
        // Source: https://docs.z.ai/guides/overview/pricing
        let glm_base = Pricing {
            input: 0.6e-6,
            output: 2.2e-6,
            cache_create: 0.75e-6,
            cache_read: 0.11e-6,
            cache_read_explicit: true,
            input_above_200k: None,
            output_above_200k: None,
            cache_create_above_200k: None,
            cache_read_above_200k: None,
            fast_multiplier: 1.0,
        };
        self.entries.insert("glm-4.5".to_string(), glm_base);
        self.entries.insert("glm-4.6".to_string(), glm_base);
        self.entries.insert("glm-4.7".to_string(), glm_base);
        self.entries.insert(
            "glm-5".to_string(),
            Pricing {
                input: 1.0e-6,
                output: 3.2e-6,
                cache_create: 1.25e-6,
                cache_read: 0.2e-6,
                ..glm_base
            },
        );
        self.entries.insert(
            "glm-5-turbo".to_string(),
            Pricing {
                input: 1.2e-6,
                output: 4.0e-6,
                cache_create: 1.5e-6,
                cache_read: 0.24e-6,
                ..glm_base
            },
        );
        self.entries.insert(
            "glm-5.1".to_string(),
            Pricing {
                input: 1.4e-6,
                output: 4.4e-6,
                cache_create: 1.75e-6,
                cache_read: 0.26e-6,
                ..glm_base
            },
        );
        self.context_limits.insert("gpt-5.5".to_string(), 1_050_000);
        self.context_limits
            .insert("grok-4.3".to_string(), 1_000_000);
        self.context_limits.insert("gpt-5.4".to_string(), 1_050_000);
        for model in [
            "claude-opus-4-8",
            "claude-opus-4-7",
            "claude-opus-4-6",
            "claude-sonnet-4-6",
        ] {
            self.context_limits.insert(model.to_string(), 1_000_000);
        }
        self.context_limits
            .insert("moonshot/kimi-k2.5".to_string(), 262_144);
        self.context_limits
            .insert("moonshot/kimi-k2.6".to_string(), 262_144);

        for model in [
            "claude-opus-4-5",
            "claude-haiku-4-5",
            "claude-opus-4",
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

/// Matches pricing keys across provider/model aliases while preserving version boundaries.
fn pricing_key_matches(candidate: &str, model: &str, normalized_model: &str) -> bool {
    if contains_pricing_key(model, candidate) || contains_pricing_key(candidate, model) {
        return true;
    }
    let normalized_candidate = normalized_pricing_key(candidate);
    contains_pricing_key(normalized_model, normalized_candidate.as_ref())
        || contains_pricing_key(normalized_candidate.as_ref(), normalized_model)
}

/// Finds a key only when the surrounding bytes are non-alphanumeric boundaries.
fn contains_pricing_key(value: &str, key: &str) -> bool {
    value.match_indices(key).any(|(index, _)| {
        let before = index
            .checked_sub(1)
            .and_then(|before| value.as_bytes().get(before))
            .copied();
        let suffix = &value[index + key.len()..];
        before.is_none_or(is_pricing_key_boundary) && suffix_allows_pricing_key_match(key, suffix)
    })
}

/// Treats punctuation separators as boundaries, but not adjacent version digits.
fn is_pricing_key_boundary(byte: u8) -> bool {
    !byte.is_ascii_alphanumeric()
}

fn suffix_allows_pricing_key_match(key: &str, suffix: &str) -> bool {
    let Some(separator) = suffix.as_bytes().first().copied() else {
        return true;
    };
    if !is_pricing_key_boundary(separator) {
        return false;
    }
    !suffix_starts_with_numeric_model_version(key, suffix)
}

fn suffix_starts_with_numeric_model_version(key: &str, suffix: &str) -> bool {
    if !key.as_bytes().last().is_some_and(u8::is_ascii_digit) {
        return false;
    }
    if !matches!(suffix.as_bytes().first(), Some(b'-' | b'.')) {
        return false;
    }

    let rest = &suffix[1..];
    let digit_len = rest
        .as_bytes()
        .iter()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    if digit_len == 0 {
        return false;
    }
    let after_digits = rest.as_bytes().get(digit_len).copied();
    !(digit_len == MODEL_DATE_SUFFIX_DIGITS && after_digits.is_none_or(is_pricing_key_boundary))
}

/// Normalizes known model separator variants without allocating for canonical keys.
fn normalized_pricing_key(value: &str) -> Cow<'_, str> {
    if value.contains(['.', '@']) {
        Cow::Owned(value.replace(['.', '@'], "-"))
    } else {
        Cow::Borrowed(value)
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

fn models_dev_pricing() -> Option<&'static PricingMap> {
    static MODELS_DEV_PRICING: ModelsDevPricingCache =
        ModelsDevPricingCache::new(MODELS_DEV_FAILURE_RETRY_AFTER);
    MODELS_DEV_PRICING.get_or_try_load(fetch_models_dev_json)
}

fn load_models_dev_pricing<F>(fetch_json: F) -> Option<PricingMap>
where
    F: FnOnce() -> std::io::Result<String>,
{
    let json = match fetch_json() {
        Ok(json) => json,
        Err(error) => {
            if should_log_pricing_refresh_details() {
                eprintln!(
                    "WARN  Failed to fetch models.dev pricing ({error}); using LiteLLM pricing."
                );
            }
            return None;
        }
    };
    let mut map = PricingMap::default();
    if map.load_models_dev_json_missing(&json).is_none() {
        if should_log_pricing_refresh_details() {
            eprintln!("WARN  Failed to parse models.dev pricing; using LiteLLM pricing.");
        }
        return None;
    }
    Some(map)
}

fn fetch_pricing_json() -> std::io::Result<String> {
    fetch_json_url(LITELLM_PRICING_URL)
}

fn fetch_models_dev_json() -> std::io::Result<String> {
    fetch_json_url(MODELS_DEV_API_URL)
}

fn fetch_json_url(url: &str) -> std::io::Result<String> {
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(PRICING_FETCH_TIMEOUT_SECONDS)))
        .build()
        .new_agent();
    let mut response = agent
        .get(url)
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
    use super::{Pricing, PricingMap, BUILD_TIME_PRICING_JSON};
    use std::sync::atomic::{AtomicUsize, Ordering};

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
    fn embedded_pricing_includes_moonshot_kimi_for_offline_reports() {
        let pricing = PricingMap::load_embedded();
        let kimi_k25 = pricing.find("moonshot/kimi-k2.5").unwrap();
        let kimi_k26 = pricing.find("moonshot/kimi-k2.6").unwrap();

        assert_eq!(kimi_k25.input, 0.6e-6);
        assert_eq!(kimi_k25.output, 3e-6);
        assert_eq!(kimi_k25.cache_read, 0.1e-6);
        assert!(kimi_k25.cache_read_explicit);
        assert_eq!(kimi_k26.input, 0.95e-6);
        assert_eq!(kimi_k26.output, 4e-6);
        assert_eq!(kimi_k26.cache_read, 0.16e-6);
        assert!(kimi_k26.cache_read_explicit);
        assert_eq!(pricing.context_limit("moonshot/kimi-k2.5"), Some(262_144));
        assert_eq!(pricing.context_limit("moonshot/kimi-k2.6"), Some(262_144));
    }

    #[test]
    fn embedded_pricing_includes_z_ai_glm_models_for_offline_reports() {
        let pricing = PricingMap::load_embedded();

        let glm_51 = pricing.find("glm-5.1").unwrap();
        assert_eq!(glm_51.input, 1.4e-6);
        assert_eq!(glm_51.output, 4.4e-6);
        assert_eq!(glm_51.cache_read, 0.26e-6);
        assert!(glm_51.cache_read_explicit);

        let glm_5 = pricing.find("glm-5").unwrap();
        assert_eq!(glm_5.input, 1.0e-6);
        assert_eq!(glm_5.output, 3.2e-6);
        assert_eq!(glm_5.cache_read, 0.2e-6);

        let glm_5_turbo = pricing.find("glm-5-turbo").unwrap();
        assert_eq!(glm_5_turbo.input, 1.2e-6);
        assert_eq!(glm_5_turbo.output, 4.0e-6);
        assert_eq!(glm_5_turbo.cache_read, 0.24e-6);

        let glm_47 = pricing.find("glm-4.7").unwrap();
        assert_eq!(glm_47.input, 0.6e-6);
        assert_eq!(glm_47.output, 2.2e-6);
        assert_eq!(glm_47.cache_read, 0.11e-6);
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
    fn keeps_models_dev_fallback_disabled_for_embedded_and_offline_pricing() {
        assert!(!PricingMap::load_embedded().models_dev_fallback_enabled());
        assert!(!PricingMap::load(true, false).models_dev_fallback_enabled());
    }

    #[test]
    fn retries_models_dev_pricing_after_fetch_failure() {
        let cache = super::ModelsDevPricingCache::new(std::time::Duration::ZERO);

        let failed = cache.get_or_try_load(|| {
            Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "temporary failure",
            ))
        });
        assert!(failed.is_none());

        let pricing = cache
            .get_or_try_load(|| {
                Ok(r#"{
                    "openai": {
                        "id": "openai",
                        "name": "OpenAI",
                        "models": {
                            "gpt-retry": {
                                "id": "gpt-retry",
                                "name": "GPT Retry",
                                "cost": {
                                    "input": 1.0,
                                    "output": 2.0
                                },
                                "limit": {
                                    "context": 42
                                }
                            }
                        }
                    }
                }"#
                .to_string())
            })
            .expect("models.dev retry should cache successful pricing");

        let gpt_retry = pricing
            .find_entry("gpt-retry")
            .expect("successful retry should load pricing");
        assert_eq!(gpt_retry.input, 0.000001);
        assert_eq!(gpt_retry.output, 0.000002);
        assert_eq!(pricing.context_limit_entry("gpt-retry"), Some(42));
    }

    #[test]
    fn backs_off_models_dev_pricing_after_fetch_failure() {
        let cache = super::ModelsDevPricingCache::new(std::time::Duration::from_secs(60));
        let attempts = AtomicUsize::new(0);

        let failed = cache.get_or_try_load(|| {
            attempts.fetch_add(1, Ordering::Relaxed);
            Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "temporary failure",
            ))
        });
        assert!(failed.is_none());

        let skipped = cache.get_or_try_load(|| {
            attempts.fetch_add(1, Ordering::Relaxed);
            Ok(r#"{
                "openai": {
                    "id": "openai",
                    "name": "OpenAI",
                    "models": {
                        "gpt-skipped": {
                            "id": "gpt-skipped",
                            "name": "GPT Skipped",
                            "cost": {
                                "input": 1.0,
                                "output": 2.0
                            }
                        }
                    }
                }
            }"#
            .to_string())
        });
        assert!(skipped.is_none());
        assert_eq!(attempts.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn loads_missing_models_dev_pricing_without_overriding_litellm() {
        let mut pricing = PricingMap::default();
        pricing.load_json(
            r#"{
                "gpt-primary": {
                    "input_cost_per_token": 0.000001,
                    "output_cost_per_token": 0.000010,
                    "cache_read_input_token_cost": 0.0000001,
                    "max_input_tokens": 123
                },
                "openrouter/gpt-alias": {
                    "input_cost_per_token": 0.000003,
                    "output_cost_per_token": 0.000030,
                    "max_input_tokens": 321
                }
            }"#,
        );

        let models_dev_json = r#"{
                "openai": {
                    "id": "openai",
                    "name": "OpenAI",
                    "models": {
                        "gpt-primary": {
                            "id": "gpt-primary",
                            "name": "GPT Primary",
                            "cost": {
                                "input": 9.0,
                                "output": 90.0,
                                "cache_read": 0.9,
                                "cache_write": 11.25
                            },
                            "limit": {
                                "context": 999
                            }
                        },
                        "gpt-fallback": {
                            "id": "gpt-fallback",
                            "name": "GPT Fallback",
                            "cost": {
                                "input": 2.0,
                                "output": 8.0,
                                "cache_read": 0.2,
                                "cache_write": 2.5
                            },
                            "limit": {
                                "context": 456
                            }
                        },
                        "gpt-alias": {
                            "id": "gpt-alias",
                            "name": "GPT Alias",
                            "cost": {
                                "input": 4.0,
                                "output": 16.0
                            },
                            "limit": {
                                "context": 654
                            }
                        }
                    }
                }
            }"#;

        assert_eq!(
            pricing.load_models_dev_json_missing(models_dev_json),
            Some(2)
        );

        let primary = pricing.find("gpt-primary").unwrap();
        let fallback = pricing.find("gpt-fallback").unwrap();
        let alias = pricing.entries.get("gpt-alias").unwrap();

        assert_eq!(primary.input, 1e-6);
        assert_eq!(primary.output, 10e-6);
        assert_eq!(primary.cache_read, 0.1e-6);
        assert_eq!(pricing.context_limit("gpt-primary"), Some(123));
        assert!((fallback.input - 2e-6).abs() < f64::EPSILON);
        assert!((fallback.output - 8e-6).abs() < f64::EPSILON);
        assert!((fallback.cache_create - 2.5e-6).abs() < f64::EPSILON);
        assert!((fallback.cache_read - 0.2e-6).abs() < f64::EPSILON);
        assert!(fallback.cache_read_explicit);
        assert_eq!(fallback.input_above_200k, None);
        assert_eq!(fallback.output_above_200k, None);
        assert_eq!(fallback.fast_multiplier, 1.0);
        assert_eq!(pricing.context_limit("gpt-fallback"), Some(456));
        assert!((alias.input - 4e-6).abs() < f64::EPSILON);
        assert_eq!(pricing.context_limits.get("gpt-alias"), Some(&654));
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
        assert_eq!(
            pricing
                .find("anthropic.claude-opus-4-8")
                .unwrap()
                .fast_multiplier,
            2.0
        );
    }

    #[test]
    fn embedded_pricing_resolves_opus_47_dot_model_names() {
        let pricing = PricingMap::load_embedded();

        assert_eq!(
            pricing.find("claude-opus-4.7-20260416").unwrap().input,
            5e-6
        );
        assert_eq!(pricing.context_limit("claude-opus-4.7"), Some(1_000_000));
        assert_eq!(
            pricing
                .find("openrouter/anthropic/claude-opus-4.7")
                .unwrap()
                .input,
            5e-6
        );
    }

    #[test]
    fn embedded_pricing_resolves_opus_48_dot_model_names() {
        let pricing = PricingMap::load_embedded();

        let opus_48 = pricing.find("claude-opus-4.8-20260528").unwrap();
        assert_eq!(opus_48.input, 5e-6);
        assert_eq!(opus_48.output, 25e-6);
        assert_eq!(opus_48.cache_create, 6.25e-6);
        assert_eq!(opus_48.cache_read, 0.5e-6);
        assert_eq!(pricing.context_limit("claude-opus-4.8"), Some(1_000_000));
    }

    #[test]
    fn embedded_pricing_resolves_separator_aliases_for_other_claude_models() {
        let pricing = PricingMap::load_embedded();
        let sonnet_46 = pricing.find("claude-sonnet-4-6").unwrap();
        let haiku_45 = pricing.find("claude-haiku-4-5").unwrap();

        assert_eq!(
            pricing.find("claude-sonnet-4.6-20260416").unwrap().input,
            sonnet_46.input
        );
        assert_eq!(
            pricing.find("claude-haiku-4.5").unwrap().input,
            haiku_45.input
        );
        assert_eq!(
            pricing.context_limit("claude-sonnet-4.6"),
            pricing.context_limit("claude-sonnet-4-6")
        );
        assert_eq!(
            pricing.context_limit("claude-haiku-4.5"),
            pricing.context_limit("claude-haiku-4-5")
        );
    }

    #[test]
    fn fuzzy_match_requires_model_key_boundaries() {
        let mut pricing = PricingMap::default();
        pricing.entries.insert(
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
                fast_multiplier: 1.0,
            },
        );
        pricing.entries.insert(
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

        assert!(pricing.find("claude-opus-4.70").is_none());
    }

    #[test]
    fn fuzzy_match_does_not_fall_back_across_numeric_model_versions() {
        let mut pricing = PricingMap::default();
        pricing.entries.insert(
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

        assert!(pricing.find("claude-opus-4.8-20260528").is_none());
        assert!(pricing.find("claude-opus-4-9").is_none());
        assert!(pricing.find("claude-opus-5").is_none());
        assert!(pricing.find("claude-opus-4.70").is_none());
        assert!(pricing.find("claude-opus-4-20250514").is_some());
    }

    #[test]
    fn fuzzy_match_allows_date_like_suffixes_for_known_numeric_model_versions() {
        let pricing = PricingMap::load_embedded();

        assert!(pricing.find("claude-opus-4-8-20270898").is_some());
        assert!(pricing.find("claude-opus-4-9").is_none());
        assert!(pricing.find("claude-opus-5").is_none());
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
                "claude-opus-4.8-20260528": {
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
            pricing
                .find("claude-opus-4.8-20260528")
                .unwrap()
                .fast_multiplier,
            2.0
        );
        assert_eq!(
            pricing.find("claude-opus-4-70").unwrap().fast_multiplier,
            1.0
        );
    }

    #[test]
    fn embedded_build_time_pricing_is_compact() {
        assert!(BUILD_TIME_PRICING_JSON.len() < 200_000);
        assert!(!BUILD_TIME_PRICING_JSON.contains("\"source\""));
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
