const std = @import("std");
const date_utils = @import("_date-utils.zig");
const shared_args = @import("_shared-args.zig");
const token_utils = @import("_token-utils.zig");

const SortOrder = shared_args.SortOrder;
const TokenTotals = token_utils.TokenTotals;
const TokenUsage = token_utils.TokenUsage;
const floorHour = date_utils.floorHour;

pub const SessionBlock = struct {
    id: []const u8,
    start: i64,
    end: i64,
    first_entry: ?i64,
    actual_end: ?i64,
    is_active: bool,
    is_gap: bool,
    entries: usize,
    totals: TokenTotals,
    models: std.array_list.Managed([]const u8),
    reset_time: ?i64,
};

pub const Burn = struct {
    tokens: f64,
    non_cache_tokens: f64,
    cost_hour: f64,
};

pub const Proj = struct {
    tokens: u64,
    cost: f64,
    remaining: u64,
};

pub fn identifyBlocks(
    allocator: std.mem.Allocator,
    comptime EntryType: type,
    entries_raw: []const EntryType,
    hours: f64,
    now: i64,
) !std.array_list.Managed(SessionBlock) {
    var entries = try allocator.dupe(EntryType, entries_raw);
    defer allocator.free(entries);

    std.mem.sort(EntryType, entries, {}, timestampLessThan(EntryType));
    var blocks = std.array_list.Managed(SessionBlock).init(allocator);
    if (entries.len == 0) return blocks;

    const duration_ms: i64 = @intFromFloat(hours * 60.0 * 60.0 * 1000.0);
    var current_start: ?i64 = null;
    var start_index: usize = 0;
    var i: usize = 0;
    while (i < entries.len) : (i += 1) {
        const entry = entries[i];
        if (current_start) |start| {
            const last = entries[i - 1].timestamp;
            if (entry.timestamp - start > duration_ms or entry.timestamp - last > duration_ms) {
                try appendBlock(allocator, EntryType, &blocks, entries[start_index..i], start, now, duration_ms);
                if (entry.timestamp - last > duration_ms) try appendGap(allocator, &blocks, last + duration_ms, entry.timestamp);
                current_start = floorHour(entry.timestamp);
                start_index = i;
            }
        } else {
            current_start = floorHour(entry.timestamp);
            start_index = i;
        }
    }
    if (current_start) |start| try appendBlock(allocator, EntryType, &blocks, entries[start_index..], start, now, duration_ms);
    return blocks;
}

pub fn filterRecent(blocks: *std.array_list.Managed(SessionBlock), now: i64, days: i64) void {
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    var write: usize = 0;
    for (blocks.items) |block| {
        if (block.start >= cutoff or block.is_active) {
            blocks.items[write] = block;
            write += 1;
        }
    }
    blocks.items.len = write;
}

pub fn filterActive(blocks: *std.array_list.Managed(SessionBlock)) void {
    var write: usize = 0;
    for (blocks.items) |block| {
        if (block.is_active) {
            blocks.items[write] = block;
            write += 1;
        }
    }
    blocks.items.len = write;
}

pub fn sortBlocks(blocks: []SessionBlock, order: SortOrder) void {
    std.mem.sort(SessionBlock, blocks, order, blockLessThan);
}

pub fn maxPreviousTokens(blocks: []const SessionBlock) u64 {
    var max: u64 = 0;
    for (blocks) |block| {
        if (!block.is_gap and !block.is_active) max = @max(max, block.totals.total());
    }
    return max;
}

pub fn parseTokenLimit(value: ?[]const u8, max_tokens: u64) ?u64 {
    const raw = value orelse return if (max_tokens > 0) max_tokens else null;
    if (raw.len == 0 or std.mem.eql(u8, raw, "max")) return if (max_tokens > 0) max_tokens else null;
    return std.fmt.parseInt(u64, raw, 10) catch null;
}

pub fn burnRate(block: SessionBlock) ?Burn {
    if (block.is_gap or block.first_entry == null or block.actual_end == null) return null;
    const elapsed = @as(f64, @floatFromInt(block.actual_end.? - block.first_entry.?)) / 60000.0;
    if (elapsed <= 0) return null;
    return .{
        .tokens = @as(f64, @floatFromInt(block.totals.total())) / elapsed,
        .non_cache_tokens = @as(f64, @floatFromInt(block.totals.input_tokens + block.totals.output_tokens)) / elapsed,
        .cost_hour = block.totals.cost / elapsed * 60.0,
    };
}

pub fn projection(block: SessionBlock, now: i64) ?Proj {
    if (!block.is_active or block.is_gap) return null;
    const burn = burnRate(block) orelse return null;
    const remaining_f = @max(0.0, @as(f64, @floatFromInt(block.end - now)) / 60000.0);
    return .{
        .tokens = @intFromFloat(@round(@as(f64, @floatFromInt(block.totals.total())) + burn.tokens * remaining_f)),
        .cost = round2(block.totals.cost + burn.cost_hour / 60.0 * remaining_f),
        .remaining = @intFromFloat(@round(remaining_f)),
    };
}

pub fn deinitBlocks(blocks: []SessionBlock) void {
    for (blocks) |block| block.models.deinit();
}

fn appendBlock(
    allocator: std.mem.Allocator,
    comptime EntryType: type,
    blocks: *std.array_list.Managed(SessionBlock),
    entries: []const EntryType,
    start: i64,
    now: i64,
    duration_ms: i64,
) !void {
    var totals = TokenTotals{};
    var models = std.array_list.Managed([]const u8).init(allocator);
    var reset_time: ?i64 = null;
    for (entries) |entry| {
        totals.addUsage(entry.usage, entry.cost);
        if (entry.model) |model| if (!containsString(models.items, model)) try models.append(model);
        if (entry.reset_time) |reset| reset_time = reset;
    }
    const actual_end = if (entries.len > 0) entries[entries.len - 1].timestamp else start;
    const first_entry = if (entries.len > 0) entries[0].timestamp else start;
    const id = try date_utils.formatIso(allocator, start);
    try blocks.append(.{
        .id = id,
        .start = start,
        .end = start + duration_ms,
        .first_entry = first_entry,
        .actual_end = actual_end,
        .is_active = now - actual_end < duration_ms and now < start + duration_ms,
        .is_gap = false,
        .entries = entries.len,
        .totals = totals,
        .models = models,
        .reset_time = reset_time,
    });
}

fn appendGap(allocator: std.mem.Allocator, blocks: *std.array_list.Managed(SessionBlock), start: i64, end: i64) !void {
    const models = std.array_list.Managed([]const u8).init(allocator);
    const id_date = try date_utils.formatIso(allocator, start);
    const id = try std.fmt.allocPrint(allocator, "gap-{s}", .{id_date});
    try blocks.append(.{
        .id = id,
        .start = start,
        .end = end,
        .first_entry = null,
        .actual_end = null,
        .is_active = false,
        .is_gap = true,
        .entries = 0,
        .totals = .{},
        .models = models,
        .reset_time = null,
    });
}

fn containsString(items: []const []const u8, value: []const u8) bool {
    for (items) |item| if (std.mem.eql(u8, item, value)) return true;
    return false;
}

fn timestampLessThan(comptime EntryType: type) fn (void, EntryType, EntryType) bool {
    return struct {
        fn lessThan(_: void, a: EntryType, b: EntryType) bool {
            return a.timestamp < b.timestamp;
        }
    }.lessThan;
}

fn blockLessThan(order: SortOrder, a: SessionBlock, b: SessionBlock) bool {
    return switch (order) {
        .asc => a.start < b.start,
        .desc => a.start > b.start,
    };
}

fn round2(value: f64) f64 {
    return @round(value * 100.0) / 100.0;
}

const TestEntry = struct {
    timestamp: i64,
    usage: TokenUsage,
    cost: f64,
    model: ?[]const u8,
    reset_time: ?i64 = null,
};

fn mockEntry(timestamp: i64, input: u64, output: u64, model: []const u8, cost: f64) TestEntry {
    return .{
        .timestamp = timestamp,
        .usage = .{
            .input_tokens = input,
            .output_tokens = output,
        },
        .cost = cost,
        .model = model,
    };
}

test "identifyBlocks matches TypeScript session block grouping cases" {
    const allocator = std.testing.allocator;
    const base = try date_utils.parseTimestamp("2024-01-01T10:00:00Z");
    const hour: i64 = 60 * 60 * 1000;
    const now = base + 24 * hour;

    {
        var blocks = try identifyBlocks(allocator, TestEntry, &.{}, 5, now);
        defer blocks.deinit();
        try std.testing.expectEqual(@as(usize, 0), blocks.items.len);
    }

    {
        const entries = [_]TestEntry{
            mockEntry(base, 1000, 500, "claude-sonnet-4-20250514", 0.01),
            mockEntry(base + hour, 1000, 500, "claude-sonnet-4-20250514", 0.01),
            mockEntry(base + 2 * hour, 1000, 500, "claude-sonnet-4-20250514", 0.01),
        };
        var blocks = try identifyBlocks(allocator, TestEntry, &entries, 5, now);
        defer {
            deinitBlocks(blocks.items);
            blocks.deinit();
        }
        try std.testing.expectEqual(@as(usize, 1), blocks.items.len);
        try std.testing.expectEqual(base, blocks.items[0].start);
        try std.testing.expectEqual(@as(usize, 3), blocks.items[0].entries);
        try std.testing.expectEqual(@as(u64, 3000), blocks.items[0].totals.input_tokens);
        try std.testing.expectEqual(@as(u64, 1500), blocks.items[0].totals.output_tokens);
        try std.testing.expectApproxEqAbs(@as(f64, 0.03), blocks.items[0].totals.cost, 0.000001);
    }

    {
        const entries = [_]TestEntry{
            mockEntry(base, 1000, 500, "claude-sonnet-4-20250514", 0.01),
            mockEntry(base + 6 * hour, 1000, 500, "claude-sonnet-4-20250514", 0.01),
        };
        var blocks = try identifyBlocks(allocator, TestEntry, &entries, 5, now);
        defer {
            deinitBlocks(blocks.items);
            blocks.deinit();
        }
        try std.testing.expectEqual(@as(usize, 3), blocks.items.len);
        try std.testing.expectEqual(@as(usize, 1), blocks.items[0].entries);
        try std.testing.expect(blocks.items[1].is_gap);
        try std.testing.expectEqual(@as(usize, 1), blocks.items[2].entries);
    }
}

test "identifyBlocks handles sorting, model dedupe, cache tokens, and custom duration" {
    const allocator = std.testing.allocator;
    const base = try date_utils.parseTimestamp("2024-01-01T10:55:30Z");
    const floored = try date_utils.parseTimestamp("2024-01-01T10:00:00Z");
    const hour: i64 = 60 * 60 * 1000;
    const now = floored + 24 * hour;

    const entries = [_]TestEntry{
        .{
            .timestamp = base + 2 * hour,
            .usage = .{ .input_tokens = 500, .output_tokens = 200, .cache_creation_input_tokens = 100, .cache_read_input_tokens = 200 },
            .cost = 0.02,
            .model = "claude-opus-4-20250514",
        },
        mockEntry(base, 1000, 500, "claude-sonnet-4-20250514", 0.01),
        mockEntry(base + hour, 1000, 500, "claude-sonnet-4-20250514", 0.01),
    };
    var blocks = try identifyBlocks(allocator, TestEntry, &entries, 3, now);
    defer {
        deinitBlocks(blocks.items);
        blocks.deinit();
    }

    try std.testing.expectEqual(@as(usize, 1), blocks.items.len);
    try std.testing.expectEqual(floored, blocks.items[0].start);
    try std.testing.expectEqual(base, blocks.items[0].first_entry.?);
    try std.testing.expectEqual(floored + 3 * hour, blocks.items[0].end);
    try std.testing.expectEqual(@as(u64, 2500), blocks.items[0].totals.input_tokens);
    try std.testing.expectEqual(@as(u64, 1200), blocks.items[0].totals.output_tokens);
    try std.testing.expectEqual(@as(u64, 100), blocks.items[0].totals.cache_creation_input_tokens);
    try std.testing.expectEqual(@as(u64, 200), blocks.items[0].totals.cache_read_input_tokens);
    try std.testing.expectEqual(@as(usize, 2), blocks.items[0].models.items.len);
}

test "burnRate uses first and last entry timestamps instead of floored block start" {
    const allocator = std.testing.allocator;
    const first = try date_utils.parseTimestamp("2024-01-01T10:55:30Z");
    const floored = try date_utils.parseTimestamp("2024-01-01T10:00:00Z");
    const second = first + 60 * 1000;
    const hour: i64 = 60 * 60 * 1000;
    var models = std.array_list.Managed([]const u8).init(allocator);
    defer models.deinit();
    try models.append("claude-sonnet-4-20250514");

    const block = SessionBlock{
        .id = "2024-01-01T10:00:00.000Z",
        .start = floored,
        .end = floored + 5 * hour,
        .first_entry = first,
        .actual_end = second,
        .is_active = true,
        .is_gap = false,
        .entries = 2,
        .totals = .{
            .input_tokens = 3000,
            .output_tokens = 1500,
            .cost = 0.03,
        },
        .models = models,
        .reset_time = null,
    };

    const burn = burnRate(block).?;
    try std.testing.expectApproxEqAbs(@as(f64, 4500), burn.tokens, 0.000001);
    try std.testing.expectApproxEqAbs(@as(f64, 4500), burn.non_cache_tokens, 0.000001);
    try std.testing.expectApproxEqAbs(@as(f64, 1.8), burn.cost_hour, 0.000001);
}

test "burnRate and projection match TypeScript session block calculations" {
    const allocator = std.testing.allocator;
    const base = try date_utils.parseTimestamp("2024-01-01T10:00:00Z");
    const minute: i64 = 60 * 1000;
    const hour: i64 = 60 * minute;
    var models = std.array_list.Managed([]const u8).init(allocator);
    defer models.deinit();
    try models.append("claude-sonnet-4-20250514");

    const block = SessionBlock{
        .id = "2024-01-01T10:00:00.000Z",
        .start = base,
        .end = base + 5 * hour,
        .first_entry = base,
        .actual_end = base + minute,
        .is_active = true,
        .is_gap = false,
        .entries = 2,
        .totals = .{
            .input_tokens = 1500,
            .output_tokens = 700,
            .cache_creation_input_tokens = 2000,
            .cache_read_input_tokens = 8000,
            .cost = 0.03,
        },
        .models = models,
        .reset_time = null,
    };

    const burn = burnRate(block).?;
    try std.testing.expectApproxEqAbs(@as(f64, 12200), burn.tokens, 0.000001);
    try std.testing.expectApproxEqAbs(@as(f64, 2200), burn.non_cache_tokens, 0.000001);
    try std.testing.expectApproxEqAbs(@as(f64, 1.8), burn.cost_hour, 0.000001);

    const proj = projection(block, base + hour).?;
    try std.testing.expect(proj.tokens > block.totals.total());
    try std.testing.expect(proj.cost > block.totals.cost);
    try std.testing.expect(proj.remaining > 0);
}

test "recent and active filters match TypeScript block option behavior" {
    const allocator = std.testing.allocator;
    const now = try date_utils.parseTimestamp("2024-01-10T10:00:00Z");
    const day: i64 = 24 * 60 * 60 * 1000;
    var blocks = std.array_list.Managed(SessionBlock).init(allocator);
    defer blocks.deinit();

    try blocks.append(.{
        .id = "recent",
        .start = now - 2 * day,
        .end = now - 2 * day + 5 * 60 * 60 * 1000,
        .first_entry = null,
        .actual_end = null,
        .is_active = false,
        .is_gap = false,
        .entries = 0,
        .totals = .{},
        .models = std.array_list.Managed([]const u8).init(allocator),
        .reset_time = null,
    });
    try blocks.append(.{
        .id = "old-active",
        .start = now - 10 * day,
        .end = now - 10 * day + 5 * 60 * 60 * 1000,
        .first_entry = null,
        .actual_end = null,
        .is_active = true,
        .is_gap = false,
        .entries = 0,
        .totals = .{},
        .models = std.array_list.Managed([]const u8).init(allocator),
        .reset_time = null,
    });
    try blocks.append(.{
        .id = "old",
        .start = now - 8 * day,
        .end = now - 8 * day + 5 * 60 * 60 * 1000,
        .first_entry = null,
        .actual_end = null,
        .is_active = false,
        .is_gap = false,
        .entries = 0,
        .totals = .{},
        .models = std.array_list.Managed([]const u8).init(allocator),
        .reset_time = null,
    });

    filterRecent(&blocks, now, 3);
    defer deinitBlocks(blocks.items);
    try std.testing.expectEqual(@as(usize, 2), blocks.items.len);
    try std.testing.expect(std.mem.eql(u8, blocks.items[0].id, "recent"));
    try std.testing.expect(std.mem.eql(u8, blocks.items[1].id, "old-active"));

    filterActive(&blocks);
    try std.testing.expectEqual(@as(usize, 1), blocks.items.len);
    try std.testing.expect(std.mem.eql(u8, blocks.items[0].id, "old-active"));
}

test "identifyBlocks matches TypeScript configurable duration edge cases" {
    const allocator = std.testing.allocator;
    const base = try date_utils.parseTimestamp("2024-01-01T10:00:00Z");
    const hour: i64 = 60 * 60 * 1000;
    const minute: i64 = 60 * 1000;
    const now = base + 48 * hour;

    {
        const entries = [_]TestEntry{
            mockEntry(base, 1000, 500, "claude-sonnet-4-20250514", 0.01),
            mockEntry(base + 2 * hour, 1000, 500, "claude-sonnet-4-20250514", 0.01),
            mockEntry(base + 6 * hour, 1000, 500, "claude-sonnet-4-20250514", 0.01),
        };
        var blocks = try identifyBlocks(allocator, TestEntry, &entries, 2.5, now);
        defer {
            deinitBlocks(blocks.items);
            blocks.deinit();
        }
        try std.testing.expectEqual(@as(usize, 3), blocks.items.len);
        try std.testing.expectEqual(@as(usize, 2), blocks.items[0].entries);
        try std.testing.expectEqual(base + @divTrunc(5 * hour, 2), blocks.items[0].end);
        try std.testing.expect(blocks.items[1].is_gap);
        try std.testing.expectEqual(@as(usize, 1), blocks.items[2].entries);
    }

    {
        const entries = [_]TestEntry{
            mockEntry(base, 1000, 500, "claude-sonnet-4-20250514", 0.01),
            mockEntry(base + 20 * minute, 1000, 500, "claude-sonnet-4-20250514", 0.01),
            mockEntry(base + 80 * minute, 1000, 500, "claude-sonnet-4-20250514", 0.01),
        };
        var blocks = try identifyBlocks(allocator, TestEntry, &entries, 0.5, now);
        defer {
            deinitBlocks(blocks.items);
            blocks.deinit();
        }
        try std.testing.expectEqual(@as(usize, 3), blocks.items.len);
        try std.testing.expectEqual(@as(usize, 2), blocks.items[0].entries);
        try std.testing.expectEqual(base + 30 * minute, blocks.items[0].end);
        try std.testing.expect(blocks.items[1].is_gap);
        try std.testing.expectEqual(@as(usize, 1), blocks.items[2].entries);
    }

    {
        const entries = [_]TestEntry{
            mockEntry(base, 1000, 500, "claude-sonnet-4-20250514", 0.01),
            mockEntry(base + 12 * hour, 1000, 500, "claude-sonnet-4-20250514", 0.01),
            mockEntry(base + 20 * hour, 1000, 500, "claude-sonnet-4-20250514", 0.01),
        };
        var blocks = try identifyBlocks(allocator, TestEntry, &entries, 24, now);
        defer {
            deinitBlocks(blocks.items);
            blocks.deinit();
        }
        try std.testing.expectEqual(@as(usize, 1), blocks.items.len);
        try std.testing.expectEqual(@as(usize, 3), blocks.items[0].entries);
        try std.testing.expectEqual(base + 24 * hour, blocks.items[0].end);
    }

    {
        const entries = [_]TestEntry{
            mockEntry(base, 1000, 500, "claude-sonnet-4-20250514", 0.01),
            mockEntry(base + hour, 1000, 500, "claude-sonnet-4-20250514", 0.01),
            mockEntry(base + 5 * hour, 1000, 500, "claude-sonnet-4-20250514", 0.01),
        };
        var blocks = try identifyBlocks(allocator, TestEntry, &entries, 3, now);
        defer {
            deinitBlocks(blocks.items);
            blocks.deinit();
        }
        try std.testing.expectEqual(@as(usize, 3), blocks.items.len);
        try std.testing.expect(blocks.items[1].is_gap);
        try std.testing.expectEqual(base + 4 * hour, blocks.items[1].start);
        try std.testing.expectEqual(base + 5 * hour, blocks.items[1].end);
    }

    {
        const entries = [_]TestEntry{
            mockEntry(base, 1000, 500, "claude-sonnet-4-20250514", 0.01),
            mockEntry(base + 2 * hour, 1000, 500, "claude-sonnet-4-20250514", 0.01),
        };
        var blocks = try identifyBlocks(allocator, TestEntry, &entries, 2, now);
        defer {
            deinitBlocks(blocks.items);
            blocks.deinit();
        }
        try std.testing.expectEqual(@as(usize, 1), blocks.items.len);
        try std.testing.expectEqual(@as(usize, 2), blocks.items[0].entries);
    }
}

test "token limit parsing matches blocks option cases" {
    try std.testing.expectEqual(@as(?u64, 42), parseTokenLimit("42", 100));
    try std.testing.expectEqual(@as(?u64, 100), parseTokenLimit("max", 100));
    try std.testing.expectEqual(@as(?u64, 100), parseTokenLimit("", 100));
    try std.testing.expectEqual(@as(?u64, null), parseTokenLimit("bad", 100));
    try std.testing.expectEqual(@as(?u64, null), parseTokenLimit(null, 0));
    try std.testing.expectEqual(@as(?u64, 100), parseTokenLimit(null, 100));
}
