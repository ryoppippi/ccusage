use crate::{
    cli::CostMode,
    pricing::PricingMap,
    types::{Speed, UsageEntry},
};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct CacheCreationInputTokens {
    pub(crate) ephemeral_5m_input_tokens: u64,
    pub(crate) ephemeral_1h_input_tokens: u64,
}

pub(crate) fn calculate_cost(
    data: &UsageEntry,
    mode: CostMode,
    pricing: Option<&PricingMap>,
) -> f64 {
    calculate_cost_with_cache_creation_input_tokens(data, mode, pricing, None)
}

pub(crate) fn calculate_cost_with_cache_creation_input_tokens(
    data: &UsageEntry,
    mode: CostMode,
    pricing: Option<&PricingMap>,
    cache_creation_input_tokens: Option<CacheCreationInputTokens>,
) -> f64 {
    calculate_cost_for_usage_with_cache_creation_input_tokens(
        data.message.model.as_deref(),
        data.message.usage,
        data.cost_usd,
        mode,
        pricing,
        cache_creation_input_tokens,
    )
}

pub(crate) fn calculate_cost_for_usage(
    model: Option<&str>,
    usage: crate::TokenUsageRaw,
    cost_usd: Option<f64>,
    mode: CostMode,
    pricing: Option<&PricingMap>,
) -> f64 {
    calculate_cost_for_usage_with_cache_creation_input_tokens(
        model, usage, cost_usd, mode, pricing, None,
    )
}

pub(crate) fn calculate_cost_for_usage_with_cache_creation_input_tokens(
    model: Option<&str>,
    usage: crate::TokenUsageRaw,
    cost_usd: Option<f64>,
    mode: CostMode,
    pricing: Option<&PricingMap>,
    cache_creation_input_tokens: Option<CacheCreationInputTokens>,
) -> f64 {
    match mode {
        CostMode::Display => cost_usd.unwrap_or(0.0),
        CostMode::Auto => cost_usd.unwrap_or_else(|| {
            calculate_cost_from_tokens(model, usage, pricing, cache_creation_input_tokens)
        }),
        CostMode::Calculate => {
            calculate_cost_from_tokens(model, usage, pricing, cache_creation_input_tokens)
        }
    }
}

pub(crate) fn missing_pricing_model_for_usage(
    model: Option<&str>,
    usage: crate::TokenUsageRaw,
    cost_usd: Option<f64>,
    mode: CostMode,
    pricing: Option<&PricingMap>,
) -> Option<String> {
    if mode == CostMode::Display || (mode == CostMode::Auto && cost_usd.is_some()) {
        return None;
    }
    missing_pricing_model_for_token_total(model, crate::total_usage_tokens(usage), pricing)
}

pub(crate) fn missing_pricing_model_for_token_total(
    model: Option<&str>,
    total_tokens: u64,
    pricing: Option<&PricingMap>,
) -> Option<String> {
    if total_tokens == 0 {
        return None;
    }
    let model = model?;
    let pricing = pricing?;
    pricing.find(model).is_none().then(|| model.to_string())
}

pub(crate) fn missing_pricing_model_for_candidates(
    model: &str,
    candidates: impl IntoIterator<Item = String>,
    total_tokens: u64,
    pricing: Option<&PricingMap>,
) -> Option<String> {
    if total_tokens == 0 {
        return None;
    }
    let pricing = pricing?;
    candidates
        .into_iter()
        .all(|candidate| pricing.find(&candidate).is_none())
        .then(|| model.to_string())
}

fn calculate_cost_from_tokens(
    model: Option<&str>,
    usage: crate::TokenUsageRaw,
    pricing: Option<&PricingMap>,
    cache_creation_input_tokens: Option<CacheCreationInputTokens>,
) -> f64 {
    let Some(model) = model else {
        return 0.0;
    };
    let Some(pricing) = pricing.and_then(|pricing| pricing.find(model)) else {
        return 0.0;
    };
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
        + cache_creation_cost(usage, pricing, cache_creation_input_tokens)
        + tiered_cost(
            usage.cache_read_input_tokens,
            pricing.cache_read,
            pricing.cache_read_above_200k,
        ))
        * multiplier
}

fn cache_creation_cost(
    usage: crate::TokenUsageRaw,
    pricing: crate::pricing::Pricing,
    cache_creation_input_tokens: Option<CacheCreationInputTokens>,
) -> f64 {
    let Some(cache_creation_input_tokens) = cache_creation_input_tokens else {
        return tiered_cost(
            usage.cache_creation_input_tokens,
            pricing.cache_create,
            pricing.cache_create_above_200k,
        );
    };
    let ephemeral_5m = cache_creation_input_tokens
        .ephemeral_5m_input_tokens
        .min(usage.cache_creation_input_tokens);
    let remaining = usage.cache_creation_input_tokens - ephemeral_5m;
    let ephemeral_1h = cache_creation_input_tokens
        .ephemeral_1h_input_tokens
        .min(remaining);
    let fallback_tokens = remaining - ephemeral_1h;

    tiered_cost(
        ephemeral_5m,
        pricing.cache_create,
        pricing.cache_create_above_200k,
    ) + tiered_cost(
        ephemeral_1h,
        pricing.input * 2.0,
        pricing.input_above_200k.map(|value| value * 2.0),
    ) + tiered_cost(
        fallback_tokens,
        pricing.cache_create,
        pricing.cache_create_above_200k,
    )
}

pub(crate) fn tiered_cost(tokens: u64, base: f64, above: Option<f64>) -> f64 {
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

#[cfg(test)]
mod tests {
    use super::{cache_creation_cost, CacheCreationInputTokens};
    use crate::{
        pricing::Pricing,
        types::{Speed, TokenUsageRaw},
    };

    const COST_TOLERANCE: f64 = 1e-12;

    fn base_pricing() -> Pricing {
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
        }
    }

    #[test]
    fn cache_creation_cost_uses_1h_rate_when_split_is_available() {
        let usage = TokenUsageRaw {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: 0,
            speed: Some(Speed::Standard),
        };
        let pricing = base_pricing();
        let cost = cache_creation_cost(
            usage,
            pricing,
            Some(CacheCreationInputTokens {
                ephemeral_5m_input_tokens: 0,
                ephemeral_1h_input_tokens: 100,
            }),
        );

        assert!((cost - 0.0006).abs() < COST_TOLERANCE);
    }

    #[test]
    fn cache_creation_cost_falls_back_to_single_rate_without_split() {
        let usage = TokenUsageRaw {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: 0,
            speed: Some(Speed::Standard),
        };
        let pricing = base_pricing();
        let cost = cache_creation_cost(usage, pricing, None);

        assert!((cost - 0.000375).abs() < COST_TOLERANCE);
    }
}
