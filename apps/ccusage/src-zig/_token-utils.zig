const std = @import("std");

pub const TokenUsage = struct {
    input_tokens: u64 = 0,
    output_tokens: u64 = 0,
    cache_creation_input_tokens: u64 = 0,
    cache_read_input_tokens: u64 = 0,
    speed_fast: bool = false,

    pub fn total(self: TokenUsage) u64 {
        return self.input_tokens + self.output_tokens + self.cache_creation_input_tokens + self.cache_read_input_tokens;
    }
};

pub const TokenTotals = struct {
    input_tokens: u64 = 0,
    output_tokens: u64 = 0,
    cache_creation_tokens: u64 = 0,
    cache_read_tokens: u64 = 0,
    cost: f64 = 0,

    pub fn addUsage(self: *TokenTotals, usage: TokenUsage, cost: f64) void {
        self.input_tokens += usage.input_tokens;
        self.output_tokens += usage.output_tokens;
        self.cache_creation_tokens += usage.cache_creation_input_tokens;
        self.cache_read_tokens += usage.cache_read_input_tokens;
        self.cost += cost;
    }

    pub fn total(self: TokenTotals) u64 {
        return self.input_tokens + self.output_tokens + self.cache_creation_tokens + self.cache_read_tokens;
    }
};

test "token totals match TypeScript token utility cases" {
    try std.testing.expectEqual(@as(u64, 3800), (TokenUsage{
        .input_tokens = 1000,
        .output_tokens = 500,
        .cache_creation_input_tokens = 2000,
        .cache_read_input_tokens = 300,
    }).total());
    try std.testing.expectEqual(@as(u64, 0), (TokenUsage{}).total());
    try std.testing.expectEqual(@as(u64, 1500), (TokenUsage{
        .input_tokens = 1000,
        .output_tokens = 500,
    }).total());
}

test "token aggregation matches TypeScript calculateTotals cases" {
    var totals = TokenTotals{};
    totals.addUsage(.{
        .input_tokens = 100,
        .output_tokens = 50,
        .cache_creation_input_tokens = 25,
        .cache_read_input_tokens = 10,
    }, 0.01);
    totals.addUsage(.{
        .input_tokens = 200,
        .output_tokens = 100,
        .cache_creation_input_tokens = 50,
        .cache_read_input_tokens = 20,
    }, 0.02);

    try std.testing.expectEqual(@as(u64, 300), totals.input_tokens);
    try std.testing.expectEqual(@as(u64, 150), totals.output_tokens);
    try std.testing.expectEqual(@as(u64, 75), totals.cache_creation_tokens);
    try std.testing.expectEqual(@as(u64, 30), totals.cache_read_tokens);
    try std.testing.expectEqual(@as(u64, 555), totals.total());
    try std.testing.expectApproxEqAbs(0.03, totals.cost, 0.0000001);
}
