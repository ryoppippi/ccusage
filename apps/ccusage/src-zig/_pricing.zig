const std = @import("std");
const token_utils = @import("_token-utils.zig");

const LITELLM_PRICING_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const EMBEDDED_PRICING_JSON = @embedFile("claude-pricing.json");

const TokenUsage = token_utils.TokenUsage;

pub const Pricing = struct {
    input: f64,
    output: f64,
    cache_create: f64,
    cache_read: f64,
    input_above_200k: ?f64 = null,
    output_above_200k: ?f64 = null,
    cache_create_above_200k: ?f64 = null,
    cache_read_above_200k: ?f64 = null,
};

pub const PricingMap = std.StringHashMap(Pricing);

pub fn loadPricing(allocator: std.mem.Allocator, map: *PricingMap, offline: bool, io: std.Io, log_writer: ?*std.Io.Writer) !void {
    try loadPricingJson(allocator, map, EMBEDDED_PRICING_JSON);
    try putFallbackPricing(map);
    if (offline) return;

    if (log_writer) |writer| try writer.print("[ccusage]  WARN  Fetching latest model pricing from LiteLLM...\n\n", .{});
    var client = std.http.Client{ .allocator = allocator, .io = io };
    defer client.deinit();

    var body: std.ArrayList(u8) = .empty;
    var writer_alloc: std.Io.Writer.Allocating = .fromArrayList(allocator, &body);

    const result = client.fetch(.{
        .location = .{ .url = LITELLM_PRICING_URL },
        .response_writer = &writer_alloc.writer,
    }) catch |err| {
        if (log_writer) |writer| try writer.print("[ccusage]  WARN  Failed to fetch LiteLLM pricing ({s}); using embedded pricing.\n\n", .{@errorName(err)});
        return;
    };
    if (result.status != .ok) {
        if (log_writer) |writer| try writer.print("[ccusage]  WARN  LiteLLM pricing fetch returned {}; using embedded pricing.\n\n", .{result.status});
        return;
    }

    try loadPricingJson(allocator, map, writer_alloc.written());
    if (log_writer) |writer| try writer.print("[ccusage] INFO  Loaded latest model pricing from LiteLLM.\n\n", .{});
}

fn loadPricingJson(allocator: std.mem.Allocator, map: *PricingMap, json_text: []const u8) !void {
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, json_text, .{ .ignore_unknown_fields = true }) catch return;
    defer parsed.deinit();
    const root = switch (parsed.value) {
        .object => |object| object,
        else => return,
    };
    var it = root.iterator();
    while (it.next()) |entry| {
        const value = switch (entry.value_ptr.*) {
            .object => |object| object,
            else => continue,
        };
        const input = numberField(value, "input_cost_per_token") orelse continue;
        const output = numberField(value, "output_cost_per_token") orelse continue;
        const cache_create = numberField(value, "cache_creation_input_token_cost") orelse input * 1.25;
        const cache_read = numberField(value, "cache_read_input_token_cost") orelse input * 0.1;
        try map.put(try allocator.dupe(u8, entry.key_ptr.*), .{
            .input = input,
            .output = output,
            .cache_create = cache_create,
            .cache_read = cache_read,
            .input_above_200k = numberField(value, "input_cost_per_token_above_200k_tokens"),
            .output_above_200k = numberField(value, "output_cost_per_token_above_200k_tokens"),
            .cache_create_above_200k = numberField(value, "cache_creation_input_token_cost_above_200k_tokens"),
            .cache_read_above_200k = numberField(value, "cache_read_input_token_cost_above_200k_tokens"),
        });
    }
}

fn putFallbackPricing(map: *PricingMap) !void {
    try map.put("claude-opus-4-5", .{ .input = 5e-6, .output = 25e-6, .cache_create = 6.25e-6, .cache_read = 0.5e-6 });
    try map.put("claude-opus-4", .{ .input = 15e-6, .output = 75e-6, .cache_create = 18.75e-6, .cache_read = 1.5e-6 });
    try map.put("claude-sonnet-4-6", .{ .input = 3e-6, .output = 15e-6, .cache_create = 3.75e-6, .cache_read = 0.3e-6 });
    try map.put("claude-sonnet-4", .{ .input = 3e-6, .output = 15e-6, .cache_create = 3.75e-6, .cache_read = 0.3e-6, .input_above_200k = 6e-6, .output_above_200k = 22.5e-6, .cache_create_above_200k = 7.5e-6, .cache_read_above_200k = 0.6e-6 });
    try map.put("claude-haiku-4-5", .{ .input = 1e-6, .output = 5e-6, .cache_create = 1.25e-6, .cache_read = 0.1e-6 });
    try map.put("claude-3-5-haiku", .{ .input = 0.8e-6, .output = 4e-6, .cache_create = 1.0e-6, .cache_read = 0.08e-6 });
    try map.put("claude-3-opus", .{ .input = 15e-6, .output = 75e-6, .cache_create = 18.75e-6, .cache_read = 1.5e-6 });
    try map.put("claude-3-sonnet", .{ .input = 3e-6, .output = 15e-6, .cache_create = 3.75e-6, .cache_read = 0.3e-6 });
    try map.put("claude-3-haiku", .{ .input = 0.25e-6, .output = 1.25e-6, .cache_create = 0.3e-6, .cache_read = 0.03e-6 });
}

pub fn calculateTokenCost(model_opt: ?[]const u8, usage: TokenUsage, pricing: *const PricingMap) f64 {
    const model = model_opt orelse return 0;
    const p = findPricing(model, pricing) orelse return 0;
    return tiered(usage.input_tokens, p.input, p.input_above_200k) +
        tiered(usage.output_tokens, p.output, p.output_above_200k) +
        tiered(usage.cache_creation_input_tokens, p.cache_create, p.cache_create_above_200k) +
        tiered(usage.cache_read_input_tokens, p.cache_read, p.cache_read_above_200k);
}

fn findPricing(model: []const u8, pricing: *const PricingMap) ?Pricing {
    if (pricing.get(model)) |p| return p;
    var it = pricing.iterator();
    while (it.next()) |entry| {
        if (std.mem.indexOf(u8, model, entry.key_ptr.*) != null or std.mem.indexOf(u8, entry.key_ptr.*, model) != null) return entry.value_ptr.*;
    }
    return null;
}

fn tiered(tokens: u64, base: f64, above: ?f64) f64 {
    if (above) |a| {
        if (tokens > 200_000) return 200_000.0 * base + @as(f64, @floatFromInt(tokens - 200_000)) * a;
    }
    return @as(f64, @floatFromInt(tokens)) * base;
}

fn numberField(object: std.json.ObjectMap, key: []const u8) ?f64 {
    const value = object.get(key) orelse return null;
    return switch (value) {
        .integer => |i| @floatFromInt(i),
        .float => |f| f,
        .number_string => |s| std.fmt.parseFloat(f64, s) catch null,
        else => null,
    };
}

test "tiered cost above 200k" {
    try std.testing.expectApproxEqAbs(1.2, tiered(300_000, 3e-6, 6e-6), 0.0000001);
}
