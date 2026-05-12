const std = @import("std");
const config_loader = @import("_config-loader.zig");
const data_loader = @import("_data-loader.zig");
const date_utils = @import("_date-utils.zig");
const format_utils = @import("_format-utils.zig");
const pricing_utils = @import("_pricing.zig");
const project_names = @import("_project-names.zig");
const session_blocks = @import("_session-blocks.zig");
const shared_args = @import("_shared-args.zig");
const token_utils = @import("_token-utils.zig");

const VERSION = "18.0.11-zig";
const RECENT_DAYS = 3;
const BLOCKS_WARNING_THRESHOLD = 0.8;
const ANSI_CYAN_CODE = "\x1b[36m";
const ANSI_YELLOW_CODE = "\x1b[33m";
const ANSI_GRAY_CODE = "\x1b[90m";
const ANSI_RESET_CODE = "\x1b[0m";

const Args = shared_args.Args;
const PricingMap = pricing_utils.PricingMap;
const SessionBlock = session_blocks.SessionBlock;
const SortOrder = shared_args.SortOrder;
const TokenTotals = token_utils.TokenTotals;
const TokenUsage = token_utils.TokenUsage;
const WeekDay = shared_args.WeekDay;
const burnRate = session_blocks.burnRate;
const calculateTokenCost = pricing_utils.calculateTokenCost;
const dateInRange = date_utils.dateInRange;
const deinitBlocks = session_blocks.deinitBlocks;
const Entry = data_loader.Entry;
const fit = format_utils.fit;
const formatCurrency = format_utils.formatCurrency;
const formatProjectName = project_names.formatProjectName;
const formatDateBuf = date_utils.formatDateBuf;
const formatIso = date_utils.formatIso;
const formatIsoBuf = date_utils.formatIsoBuf;
const formatNumber = format_utils.formatNumber;
const joinModels = format_utils.joinModels;
const loadEntries = data_loader.loadEntries;
const maxPreviousTokens = session_blocks.maxPreviousTokens;
const parseArgs = shared_args.parseArgs;
const parseTokenLimit = session_blocks.parseTokenLimit;
const projection = session_blocks.projection;
const projectHeaderLabel = project_names.projectHeaderLabel;
const shortModel = format_utils.shortModel;
const timezoneOffsetMillis = date_utils.timezoneOffsetMillis;
const weekStart = date_utils.weekStart;

const ModelBreakdown = struct {
    model: []const u8,
    totals: TokenTotals,
    first_timestamp: i64,
};

const Summary = struct {
    label: []const u8,
    project: ?[]const u8 = null,
    session_id: ?[]const u8 = null,
    project_path: ?[]const u8 = null,
    last_activity: ?[]const u8 = null,
    totals: TokenTotals,
    models: std.array_list.Managed([]const u8),
    breakdowns: std.array_list.Managed(ModelBreakdown),
    versions: std.array_list.Managed([]const u8),
};

const DebugBucket = struct {
    total: u64 = 0,
    matches: u64 = 0,
    mismatches: u64 = 0,
    avg_percent_diff: f64 = 0,
};

const DebugSample = struct {
    timestamp: []const u8,
    model: []const u8,
    original_cost: f64,
    calculated_cost: f64,
    difference: f64,
    percent_diff: f64,
    usage: TokenUsage,
};

var env_map: *std.process.Environ.Map = undefined;
var process_io: std.Io = undefined;
var out_writer_global: *std.Io.Writer = undefined;
var err_writer_global: *std.Io.Writer = undefined;
var ANSI_CYAN: []const u8 = ANSI_CYAN_CODE;
var ANSI_YELLOW: []const u8 = ANSI_YELLOW_CODE;
var ANSI_GRAY: []const u8 = ANSI_GRAY_CODE;
var ANSI_RESET: []const u8 = ANSI_RESET_CODE;

pub fn main(init: std.process.Init) !void {
    env_map = init.environ_map;
    process_io = init.io;
    const allocator = std.heap.smp_allocator;

    var stdout_buffer: [4096]u8 = undefined;
    var stdout_file_writer = std.Io.File.stdout().writer(init.io, &stdout_buffer);
    out_writer_global = &stdout_file_writer.interface;
    defer out_writer_global.flush() catch {};

    var stderr_buffer: [4096]u8 = undefined;
    var stderr_file_writer = std.Io.File.stderr().writer(init.io, &stderr_buffer);
    err_writer_global = &stderr_file_writer.interface;
    defer err_writer_global.flush() catch {};

    const argv = try init.minimal.args.toSlice(allocator);

    var args = try parseArgs(argv[1..]);
    try config_loader.applyConfig(allocator, &args, &process_io, env_map);
    configureAnsi(args.color);
    if (args.command == .help) {
        printHelp();
        return;
    }
    if (args.command == .version) {
        try stdout().print("{s}\n", .{VERSION});
        return;
    }
    if (args.jq != null) args.json = true;

    const needs_pricing = args.mode != .display or (args.debug and !args.json);
    var pricing = PricingMap.init(allocator);
    const pricing_log_writer: ?*std.Io.Writer = if (args.json) null else stdout();
    if (needs_pricing) try pricing_utils.loadPricing(allocator, &pricing, args.offline, process_io, pricing_log_writer);

    var entries = std.array_list.Managed(Entry).init(allocator);
    try loadEntries(allocator, &entries, args, &pricing, &process_io, env_map);
    if (args.debug and !args.json) try printMismatchReport(allocator, entries.items, &pricing, args.debug_samples);

    switch (args.command) {
        .daily => try runDaily(allocator, args, entries.items),
        .weekly => try runWeekly(allocator, args, entries.items),
        .monthly => try runMonthly(allocator, args, entries.items),
        .session => try runSession(allocator, args, entries.items),
        .blocks => try runBlocks(allocator, args, entries.items),
        else => unreachable,
    }
}

fn stdout() *std.Io.Writer {
    return out_writer_global;
}

fn stderr() *std.Io.Writer {
    return err_writer_global;
}

fn configureAnsi(explicit_color: ?bool) void {
    const enabled = explicit_color orelse colorEnabledFromEnv();
    if (enabled) {
        ANSI_CYAN = ANSI_CYAN_CODE;
        ANSI_YELLOW = ANSI_YELLOW_CODE;
        ANSI_GRAY = ANSI_GRAY_CODE;
        ANSI_RESET = ANSI_RESET_CODE;
    } else {
        ANSI_CYAN = "";
        ANSI_YELLOW = "";
        ANSI_GRAY = "";
        ANSI_RESET = "";
    }
}

fn colorEnabledFromEnv() bool {
    if (env_map.get("NO_COLOR")) |value| {
        if (value.len > 0) return false;
    }
    if (env_map.get("FORCE_COLOR")) |value| {
        return value.len > 0 and !std.mem.eql(u8, value, "0");
    }
    return std.Io.File.stdout().isTty(process_io) catch false;
}

fn printHelp() void {
    stdout().print(
        \\Usage: ccusage [command] [options]
        \\
        \\Commands:
        \\  daily      Show usage report grouped by date
        \\  weekly     Show usage report grouped by week
        \\  monthly    Show usage report grouped by month
        \\  session    Show usage report grouped by conversation session
        \\  blocks     Show usage report grouped by session billing blocks
        \\
        \\Options:
        \\  -s, --since <YYYYMMDD>
        \\  -u, --until <YYYYMMDD>
        \\  -j, --json
        \\  -m, --mode <auto|calculate|display>
        \\  -d, --debug
        \\  --debug-samples <count>
        \\  -o, --order <asc|desc>
        \\  -b, --breakdown
        \\  -O, --offline
        \\  -z, --timezone <TZ>
        \\  -q, --jq <filter>
        \\  --compact
        \\  --color / --no-color
        \\  --single-thread
        \\  --threads <count>
        \\
    , .{}) catch {};
}

fn printMismatchReport(allocator: std.mem.Allocator, entries: []const Entry, pricing: *const PricingMap, sample_count: usize) !void {
    var entries_with_both: u64 = 0;
    var matches: u64 = 0;
    var mismatches: u64 = 0;
    var samples = std.array_list.Managed(DebugSample).init(allocator);
    defer samples.deinit();
    var model_stats = std.StringHashMap(DebugBucket).init(allocator);
    defer model_stats.deinit();
    var version_stats = std.StringHashMap(DebugBucket).init(allocator);
    defer version_stats.deinit();

    for (entries) |entry| {
        const original_cost = entry.cost_usd orelse continue;
        const model = entry.model orelse continue;
        entries_with_both += 1;
        const calculated_cost = calculateTokenCost(model, entry.usage, pricing);
        var difference = original_cost - calculated_cost;
        if (difference < 0) difference = -difference;
        const percent_diff = if (original_cost > 0) difference / original_cost * 100.0 else 0;
        const is_match = percent_diff < 0.1;
        if (is_match) {
            matches += 1;
        } else {
            mismatches += 1;
            if (samples.items.len < sample_count) {
                try samples.append(.{
                    .timestamp = entry.timestamp_text,
                    .model = model,
                    .original_cost = original_cost,
                    .calculated_cost = calculated_cost,
                    .difference = difference,
                    .percent_diff = percent_diff,
                    .usage = entry.usage,
                });
            }
        }
        try updateDebugBucket(&model_stats, model, is_match, percent_diff);
        if (entry.version) |version| try updateDebugBucket(&version_stats, version, is_match, percent_diff);
    }

    if (entries_with_both == 0) {
        try stderr().print("INFO  No pricing data found to analyze.\n", .{});
        return;
    }

    var total_buf: [32]u8 = undefined;
    var both_buf: [32]u8 = undefined;
    var matches_buf: [32]u8 = undefined;
    var mismatches_buf: [32]u8 = undefined;
    const match_rate = @as(f64, @floatFromInt(matches)) / @as(f64, @floatFromInt(entries_with_both)) * 100.0;
    try stderr().print(
        \\INFO
        \\=== Pricing Mismatch Debug Report ===
        \\INFO  Total entries processed: {s}
        \\INFO  Entries with both costUSD and model: {s}
        \\INFO  Matches (within 0.1%): {s}
        \\INFO  Mismatches: {s}
        \\INFO  Match rate: {d:.2}%
        \\
    , .{
        formatNumber(@intCast(entries.len), &total_buf),
        formatNumber(entries_with_both, &both_buf),
        formatNumber(matches, &matches_buf),
        formatNumber(mismatches, &mismatches_buf),
        match_rate,
    });

    if (mismatches > 0 and model_stats.count() > 0) {
        try stderr().print("INFO\n=== Model Statistics ===\n", .{});
        var it = model_stats.iterator();
        while (it.next()) |stat| {
            if (stat.value_ptr.mismatches == 0) continue;
            const model_match_rate = @as(f64, @floatFromInt(stat.value_ptr.matches)) / @as(f64, @floatFromInt(stat.value_ptr.total)) * 100.0;
            try stderr().print(
                \\INFO  {s}:
                \\INFO    Total entries: {}
                \\INFO    Matches: {} ({d:.1}%)
                \\INFO    Mismatches: {}
                \\INFO    Avg % difference: {d:.1}%
                \\
            , .{ stat.key_ptr.*, stat.value_ptr.total, stat.value_ptr.matches, model_match_rate, stat.value_ptr.mismatches, stat.value_ptr.avg_percent_diff });
        }
    }

    if (mismatches > 0 and version_stats.count() > 0) {
        try stderr().print("INFO\n=== Version Statistics ===\n", .{});
        var it = version_stats.iterator();
        while (it.next()) |stat| {
            if (stat.value_ptr.mismatches == 0) continue;
            const version_match_rate = @as(f64, @floatFromInt(stat.value_ptr.matches)) / @as(f64, @floatFromInt(stat.value_ptr.total)) * 100.0;
            try stderr().print(
                \\INFO  {s}:
                \\INFO    Total entries: {}
                \\INFO    Matches: {} ({d:.1}%)
                \\INFO    Mismatches: {}
                \\INFO    Avg % difference: {d:.1}%
                \\
            , .{ stat.key_ptr.*, stat.value_ptr.total, stat.value_ptr.matches, version_match_rate, stat.value_ptr.mismatches, stat.value_ptr.avg_percent_diff });
        }
    }

    if (samples.items.len > 0) {
        try stderr().print("INFO\n=== Sample Discrepancies (first {}) ===\n", .{sample_count});
        for (samples.items) |sample| {
            try stderr().print(
                \\INFO  Timestamp: {s}
                \\INFO  Model: {s}
                \\INFO  Original cost: ${d:.6}
                \\INFO  Calculated cost: ${d:.6}
                \\INFO  Difference: ${d:.6} ({d:.2}%)
                \\INFO  Tokens: {{"input_tokens":{},"output_tokens":{},"cache_creation_input_tokens":{},"cache_read_input_tokens":{}}}
                \\INFO  ---
                \\
            , .{
                sample.timestamp,
                sample.model,
                sample.original_cost,
                sample.calculated_cost,
                sample.difference,
                sample.percent_diff,
                sample.usage.input_tokens,
                sample.usage.output_tokens,
                sample.usage.cache_creation_input_tokens,
                sample.usage.cache_read_input_tokens,
            });
        }
    }
}

fn updateDebugBucket(map: *std.StringHashMap(DebugBucket), key: []const u8, is_match: bool, percent_diff: f64) !void {
    const result = try map.getOrPut(key);
    if (!result.found_existing) result.value_ptr.* = .{};
    result.value_ptr.total += 1;
    if (is_match) {
        result.value_ptr.matches += 1;
    } else {
        result.value_ptr.mismatches += 1;
    }
    result.value_ptr.avg_percent_diff =
        (result.value_ptr.avg_percent_diff * @as(f64, @floatFromInt(result.value_ptr.total - 1)) + percent_diff) /
        @as(f64, @floatFromInt(result.value_ptr.total));
}

fn runDaily(allocator: std.mem.Allocator, args: Args, entries: []const Entry) !void {
    const rows = try summarizeEntries(allocator, entries, .daily, args);
    defer deinitSummaries(rows.items);
    sortSummaries(rows.items, args.order);
    sortAllBreakdowns(rows.items);
    if (args.json) {
        if (args.instances) return printDailyProjectsJson(allocator, rows.items, args.jq);
        return printSummaryJson(allocator, "daily", rows.items, args.jq);
    }
    sortAllModels(rows.items);
    if (args.instances and hasProjectRows(rows.items)) {
        try printDailyProjectsTable("Claude Code Token Usage Report - Daily", "Date", rows.items, args.breakdown, args.compact, args.project_aliases);
        return;
    }
    try printUsageTable("Claude Code Token Usage Report - Daily", "Date", rows.items, args.breakdown, args.compact);
}

fn runWeekly(allocator: std.mem.Allocator, args: Args, entries: []const Entry) !void {
    const daily = try summarizeEntries(allocator, entries, .daily, args);
    defer deinitSummaries(daily.items);
    sortSummaries(daily.items, .asc);
    const rows = try summarizeBuckets(allocator, daily.items, .weekly, args.start_of_week);
    defer deinitSummaries(rows.items);
    sortSummaries(rows.items, args.order);
    sortAllBreakdowns(rows.items);
    if (args.json) return printSummaryJson(allocator, "weekly", rows.items, args.jq);
    sortAllModels(rows.items);
    try printUsageTable("Claude Code Token Usage Report - Weekly", "Week", rows.items, args.breakdown, args.compact);
}

fn runMonthly(allocator: std.mem.Allocator, args: Args, entries: []const Entry) !void {
    const daily = try summarizeEntries(allocator, entries, .daily, args);
    defer deinitSummaries(daily.items);
    sortSummaries(daily.items, .asc);
    const rows = try summarizeBuckets(allocator, daily.items, .monthly, args.start_of_week);
    defer deinitSummaries(rows.items);
    sortSummaries(rows.items, args.order);
    sortAllBreakdowns(rows.items);
    if (args.json) return printSummaryJson(allocator, "monthly", rows.items, args.jq);
    sortAllModels(rows.items);
    try printUsageTable("Claude Code Token Usage Report - Monthly", "Month", rows.items, args.breakdown, args.compact);
}

fn runSession(allocator: std.mem.Allocator, args: Args, entries: []const Entry) !void {
    if (args.id) |id| return runSessionId(allocator, args, entries, id);
    var rows = try summarizeEntries(allocator, entries, .session, args);
    defer deinitSummaries(rows.items);
    filterSessionSummaries(&rows, args);
    if (rows.items.len == 0) {
        if (args.json) try stdout().print("[]\n", .{}) else try stderr().print("WARN  No Claude usage data found.\n", .{});
        return;
    }
    sortSummariesByCost(rows.items);
    sortAllBreakdowns(rows.items);
    if (args.json) return printSessionJson(allocator, rows.items, args.jq);
    sortAllModels(rows.items);
    try printSessionTable("Claude Code Token Usage Report - By Session", rows.items, args.breakdown, args.compact);
}

const SummaryKind = enum { daily, session };
const BucketKind = enum { weekly, monthly };

fn summarizeEntries(allocator: std.mem.Allocator, entries: []const Entry, kind: SummaryKind, args: Args) !std.array_list.Managed(Summary) {
    var rows = std.array_list.Managed(Summary).init(allocator);
    var indexes = std.StringHashMap(usize).init(allocator);
    for (entries) |entry| {
        const key = switch (kind) {
            .daily => if (args.instances) try std.fmt.allocPrint(allocator, "{s}\x00{s}", .{ entry.date, entry.project }) else entry.date,
            .session => try std.fmt.allocPrint(allocator, "{s}/{s}", .{ entry.project_path, entry.session_id }),
        };
        const idx = indexes.get(key) orelse blk: {
            const label = switch (kind) {
                .daily => entry.date,
                .session => shortSession(entry.session_id),
            };
            try rows.append(.{
                .label = try allocator.dupe(u8, label),
                .project = if (kind == .daily and (args.instances or args.project != null)) entry.project else null,
                .session_id = if (kind == .session) entry.session_id else null,
                .project_path = if (kind == .session) entry.project_path else null,
                .last_activity = if (kind == .session) entry.date else null,
                .totals = .{},
                .models = std.array_list.Managed([]const u8).init(allocator),
                .breakdowns = std.array_list.Managed(ModelBreakdown).init(allocator),
                .versions = std.array_list.Managed([]const u8).init(allocator),
            });
            try indexes.put(try allocator.dupe(u8, key), rows.items.len - 1);
            break :blk rows.items.len - 1;
        };
        addEntryToSummary(&rows.items[idx], entry) catch return error.OutOfMemory;
    }
    sortAllBreakdowns(rows.items);
    sortAllVersions(rows.items);
    return rows;
}

fn summarizeBuckets(allocator: std.mem.Allocator, daily: []const Summary, kind: BucketKind, start: WeekDay) !std.array_list.Managed(Summary) {
    var rows = std.array_list.Managed(Summary).init(allocator);
    var indexes = std.StringHashMap(usize).init(allocator);
    for (daily) |row| {
        const bucket = switch (kind) {
            .monthly => row.label[0..@min(7, row.label.len)],
            .weekly => try weekStart(allocator, row.label, start),
        };
        const idx = indexes.get(bucket) orelse blk: {
            try rows.append(.{
                .label = try allocator.dupe(u8, bucket),
                .totals = .{},
                .models = std.array_list.Managed([]const u8).init(allocator),
                .breakdowns = std.array_list.Managed(ModelBreakdown).init(allocator),
                .versions = std.array_list.Managed([]const u8).init(allocator),
            });
            try indexes.put(try allocator.dupe(u8, bucket), rows.items.len - 1);
            break :blk rows.items.len - 1;
        };
        addSummaryToSummary(&rows.items[idx], row) catch return error.OutOfMemory;
    }
    sortAllBreakdowns(rows.items);
    sortAllVersions(rows.items);
    return rows;
}

fn sortAllBreakdowns(rows: []Summary) void {
    for (rows) |*row| {
        std.mem.sort(ModelBreakdown, row.breakdowns.items, {}, breakdownCostDesc);
    }
}

fn sortAllModels(rows: []Summary) void {
    for (rows) |*row| {
        std.mem.sort([]const u8, row.models.items, {}, stringLessThan);
    }
}

fn sortAllVersions(rows: []Summary) void {
    for (rows) |*row| {
        std.mem.sort([]const u8, row.versions.items, {}, stringLessThan);
    }
}

fn breakdownCostDesc(_: void, a: ModelBreakdown, b: ModelBreakdown) bool {
    if (a.totals.cost == b.totals.cost) return a.first_timestamp < b.first_timestamp;
    return a.totals.cost > b.totals.cost;
}

fn addEntryToSummary(summary: *Summary, entry: Entry) !void {
    summary.totals.addUsage(entry.usage, entry.cost);
    if (entry.model) |model| {
        if (!containsString(summary.models.items, model)) try summary.models.append(model);
        for (summary.breakdowns.items) |*breakdown| {
            if (std.mem.eql(u8, breakdown.model, model)) {
                breakdown.totals.addUsage(entry.usage, entry.cost);
                return;
            }
        }
        var totals = TokenTotals{};
        totals.addUsage(entry.usage, entry.cost);
        try summary.breakdowns.append(.{ .model = model, .totals = totals, .first_timestamp = entry.timestamp });
    }
    if (entry.version) |version| {
        if (!containsString(summary.versions.items, version)) try summary.versions.append(version);
    }
    if (summary.last_activity) |last| {
        if (std.mem.order(u8, entry.date, last) == .gt) summary.last_activity = entry.date;
    }
}

fn addSummaryToSummary(dst: *Summary, src: Summary) !void {
    dst.totals.input_tokens += src.totals.input_tokens;
    dst.totals.output_tokens += src.totals.output_tokens;
    dst.totals.cache_creation_tokens += src.totals.cache_creation_tokens;
    dst.totals.cache_read_tokens += src.totals.cache_read_tokens;
    dst.totals.cost += src.totals.cost;
    for (src.models.items) |model| if (!containsString(dst.models.items, model)) try dst.models.append(model);
    for (src.breakdowns.items) |item| {
        var found = false;
        for (dst.breakdowns.items) |*breakdown| {
            if (std.mem.eql(u8, breakdown.model, item.model)) {
                breakdown.totals.input_tokens += item.totals.input_tokens;
                breakdown.totals.output_tokens += item.totals.output_tokens;
                breakdown.totals.cache_creation_tokens += item.totals.cache_creation_tokens;
                breakdown.totals.cache_read_tokens += item.totals.cache_read_tokens;
                breakdown.totals.cost += item.totals.cost;
                breakdown.first_timestamp = @min(breakdown.first_timestamp, item.first_timestamp);
                found = true;
                break;
            }
        }
        if (!found) try dst.breakdowns.append(item);
    }
}

fn runSessionId(allocator: std.mem.Allocator, args: Args, entries: []const Entry, id: []const u8) !void {
    var selected = std.array_list.Managed(Entry).init(allocator);
    defer selected.deinit();
    var totals = TokenTotals{};
    for (entries) |entry| {
        try selected.append(entry);
        totals.addUsage(entry.usage, entry.cost);
    }
    if (selected.items.len == 0) {
        if (args.json) try stdout().print("null\n", .{}) else try stderr().print("No session found with ID: {s}\n", .{id});
        return;
    }
    if (args.json) {
        var out = std.array_list.Managed(u8).init(allocator);
        defer out.deinit();
        try out.appendSlice("{\n  \"sessionId\": ");
        try writeJsonString(&out, id);
        try out.print(",\n  \"totalCost\": {d},\n  \"totalTokens\": {},\n  \"entries\": [\n", .{ totals.cost, totals.total() });
        for (selected.items, 0..) |entry, idx| {
            if (idx > 0) try out.appendSlice(",\n");
            try out.appendSlice("    {\"timestamp\":");
            try writeJsonString(&out, entry.timestamp_text);
            try out.print(",\"inputTokens\":{},\"outputTokens\":{},\"cacheCreationTokens\":{},\"cacheReadTokens\":{},\"model\":", .{
                entry.usage.input_tokens,
                entry.usage.output_tokens,
                entry.usage.cache_creation_input_tokens,
                entry.usage.cache_read_input_tokens,
            });
            try writeJsonString(&out, entry.model orelse "unknown");
            try out.print(",\"costUSD\":{d}}}", .{entry.cost_usd orelse 0});
        }
        try out.appendSlice("\n  ]\n}\n");
        return printMaybeJq(allocator, out.items, args.jq);
    }
    try stdout().print("Claude Code Session Usage - {s}\nTotal Cost: ${d:.2}\nTotal Tokens: {}\nTotal Entries: {}\n", .{ id, totals.cost, totals.total(), selected.items.len });
}

fn runBlocks(allocator: std.mem.Allocator, args: Args, entries: []const Entry) !void {
    if (args.session_length <= 0) return error.InvalidSessionLength;
    var blocks = try session_blocks.identifyBlocks(allocator, Entry, entries, args.session_length, nowMillis());
    defer deinitBlocks(blocks.items);
    filterBlocks(&blocks, args);
    session_blocks.sortBlocks(blocks.items, args.order);
    if (args.recent) session_blocks.filterRecent(&blocks, nowMillis(), RECENT_DAYS);
    if (args.active) session_blocks.filterActive(&blocks);
    if (args.active and blocks.items.len == 0) {
        if (args.json) {
            var out = std.array_list.Managed(u8).init(allocator);
            defer out.deinit();
            try out.appendSlice("{\"blocks\":[],\"message\":\"No active block\"}\n");
            return printMaybeJq(allocator, out.items, args.jq);
        }
        try stderr().print("No active session block found.\n", .{});
        return;
    }
    if (args.json) return printBlocksJson(allocator, blocks.items, args);
    if (args.active and blocks.items.len == 1) return printActiveBlockDetails(blocks.items[0], args, maxPreviousTokens(blocks.items));
    try printBlocksTable(blocks.items, args);
}

fn printDailyProjectsJson(allocator: std.mem.Allocator, rows: []const Summary, jq: ?[]const u8) !void {
    var out = std.array_list.Managed(u8).init(allocator);
    defer out.deinit();
    var projects = std.array_list.Managed([]const u8).init(allocator);
    defer projects.deinit();

    try out.appendSlice("{\n  \"projects\": {");
    for (rows) |row| {
        const project = row.project orelse "unknown";
        if (containsString(projects.items, project)) continue;
        if (projects.items.len > 0) try out.appendSlice(",");
        try projects.append(project);
        try out.appendSlice("\n    ");
        try writeJsonString(&out, project);
        try out.appendSlice(": [");
        var row_count: usize = 0;
        for (rows) |project_row| {
            const project_row_name = project_row.project orelse "unknown";
            if (!std.mem.eql(u8, project, project_row_name)) continue;
            if (row_count > 0) try out.appendSlice(",");
            try out.appendSlice("\n      {\n        ");
            try writeJsonStringField(&out, "date", project_row.label);
            try out.appendSlice(",\n");
            try writeUsageFields(&out, project_row);
            try out.appendSlice("\n      }");
            row_count += 1;
        }
        try out.appendSlice("\n    ]");
    }
    try out.appendSlice("\n  },\n  \"totals\": ");
    try writeTotalsJson(&out, totalsFor(rows));
    try out.appendSlice("\n}\n");
    try printMaybeJq(allocator, out.items, jq);
}

fn printSummaryJson(allocator: std.mem.Allocator, key: []const u8, rows: []const Summary, jq: ?[]const u8) !void {
    var out = std.array_list.Managed(u8).init(allocator);
    defer out.deinit();
    try out.print("{{\n  \"{s}\": [", .{key});
    for (rows, 0..) |row, idx| {
        if (idx > 0) try out.appendSlice(",");
        try out.append('\n');
        try writeSummaryJson(&out, row, key);
    }
    try out.appendSlice("\n  ],\n  \"totals\": ");
    try writeTotalsJson(&out, totalsFor(rows));
    try out.appendSlice("\n}\n");
    try printMaybeJq(allocator, out.items, jq);
}

fn printSessionJson(allocator: std.mem.Allocator, rows: []const Summary, jq: ?[]const u8) !void {
    var out = std.array_list.Managed(u8).init(allocator);
    defer out.deinit();
    try out.appendSlice("{\n  \"sessions\": [");
    for (rows, 0..) |row, idx| {
        if (idx > 0) try out.appendSlice(",");
        try out.append('\n');
        try writeSessionJson(&out, row);
    }
    try out.appendSlice("\n  ],\n  \"totals\": ");
    try writeTotalsJson(&out, totalsFor(rows));
    try out.appendSlice("\n}\n");
    try printMaybeJq(allocator, out.items, jq);
}

fn writeSessionJson(out: *std.array_list.Managed(u8), row: Summary) !void {
    try out.appendSlice("    {\n      \"sessionId\": ");
    try writeJsonString(out, row.session_id orelse row.label);
    try out.appendSlice(",\n");
    try writeUsageFields(out, row);
    try out.appendSlice(",\n      \"lastActivity\": ");
    try writeJsonString(out, row.last_activity orelse "");
    try out.appendSlice(",\n      \"projectPath\": ");
    try writeJsonString(out, row.project_path orelse "");
    try out.appendSlice("\n    }");
}

fn writeJsonString(out: *std.array_list.Managed(u8), value: []const u8) !void {
    const hex = "0123456789abcdef";
    try out.append('"');
    for (value) |byte| {
        switch (byte) {
            '"' => try out.appendSlice("\\\""),
            '\\' => try out.appendSlice("\\\\"),
            '\n' => try out.appendSlice("\\n"),
            '\r' => try out.appendSlice("\\r"),
            '\t' => try out.appendSlice("\\t"),
            0...8, 11...12, 14...0x1f => {
                try out.appendSlice("\\u00");
                try out.append(hex[byte >> 4]);
                try out.append(hex[byte & 0xf]);
            },
            else => try out.append(byte),
        }
    }
    try out.append('"');
}

fn writeJsonStringField(out: *std.array_list.Managed(u8), name: []const u8, value: []const u8) !void {
    try out.print("\"{s}\":", .{name});
    try writeJsonString(out, value);
}

fn writeSummaryJson(out: *std.array_list.Managed(u8), row: Summary, key: []const u8) !void {
    const field = if (std.mem.eql(u8, key, "daily")) "date" else if (std.mem.eql(u8, key, "weekly")) "week" else "month";
    try out.appendSlice("    {\n      ");
    try writeJsonStringField(out, field, row.label);
    try out.appendSlice(",\n");
    try writeUsageFields(out, row);
    if (row.project) |project| {
        try out.appendSlice(",\n      ");
        try writeJsonStringField(out, "project", project);
    }
    try out.appendSlice("\n    }");
}

fn writeUsageFields(out: *std.array_list.Managed(u8), row: Summary) !void {
    try out.print(
        \\      "inputTokens": {},
        \\      "outputTokens": {},
        \\      "cacheCreationTokens": {},
        \\      "cacheReadTokens": {},
        \\      "totalTokens": {},
        \\      "totalCost": {d},
        \\      "modelsUsed": [
    , .{ row.totals.input_tokens, row.totals.output_tokens, row.totals.cache_creation_tokens, row.totals.cache_read_tokens, row.totals.total(), row.totals.cost });
    for (row.models.items, 0..) |model, idx| {
        if (idx > 0) try out.appendSlice(", ");
        try writeJsonString(out, model);
    }
    try out.appendSlice("],\n      \"modelBreakdowns\": [");
    for (row.breakdowns.items, 0..) |breakdown, idx| {
        if (idx > 0) try out.appendSlice(", ");
        try out.appendSlice("{\"modelName\":");
        try writeJsonString(out, breakdown.model);
        try out.print(",\"inputTokens\":{},\"outputTokens\":{},\"cacheCreationTokens\":{},\"cacheReadTokens\":{},\"cost\":{d}}}", .{
            breakdown.totals.input_tokens,
            breakdown.totals.output_tokens,
            breakdown.totals.cache_creation_tokens,
            breakdown.totals.cache_read_tokens,
            breakdown.totals.cost,
        });
    }
    try out.append(']');
}

fn writeTotalsJson(out: *std.array_list.Managed(u8), totals: TokenTotals) !void {
    try out.print("{{\"inputTokens\":{},\"outputTokens\":{},\"cacheCreationTokens\":{},\"cacheReadTokens\":{},\"totalTokens\":{},\"totalCost\":{d}}}", .{
        totals.input_tokens,
        totals.output_tokens,
        totals.cache_creation_tokens,
        totals.cache_read_tokens,
        totals.total(),
        totals.cost,
    });
}

fn printBlocksJson(allocator: std.mem.Allocator, blocks: []const SessionBlock, args: Args) !void {
    var out = std.array_list.Managed(u8).init(allocator);
    defer out.deinit();
    const max_tokens = maxPreviousTokens(blocks);
    try out.appendSlice("{\n  \"blocks\": [");
    for (blocks, 0..) |block, idx| {
        if (idx > 0) try out.appendSlice(",");
        const start = try formatIso(allocator, block.start);
        const end = try formatIso(allocator, block.end);
        try out.appendSlice("\n    {\"id\":");
        try writeJsonString(&out, block.id);
        try out.appendSlice(",\"startTime\":");
        try writeJsonString(&out, start);
        try out.appendSlice(",\"endTime\":");
        try writeJsonString(&out, end);
        try out.appendSlice(",\"actualEndTime\":");
        if (block.actual_end) |actual| {
            const actual_s = try formatIso(allocator, actual);
            try writeJsonString(&out, actual_s);
        } else try out.appendSlice("null");
        try out.print(",\"isActive\":{},\"isGap\":{},\"entries\":{},\"tokenCounts\":{{\"inputTokens\":{},\"outputTokens\":{},\"cacheCreationInputTokens\":{},\"cacheReadInputTokens\":{}}},\"totalTokens\":{},\"costUSD\":{d},\"models\":[", .{
            block.is_active,
            block.is_gap,
            block.entries,
            block.totals.input_tokens,
            block.totals.output_tokens,
            block.totals.cache_creation_tokens,
            block.totals.cache_read_tokens,
            block.totals.total(),
            block.totals.cost,
        });
        for (block.models.items, 0..) |model, midx| {
            if (midx > 0) try out.appendSlice(",");
            try writeJsonString(&out, model);
        }
        try out.appendSlice("]");
        if (block.is_active) {
            if (burnRate(block)) |burn| {
                try out.print(",\"burnRate\":{{\"tokensPerMinute\":{d},\"tokensPerMinuteForIndicator\":{d},\"costPerHour\":{d}}}", .{ burn.tokens, burn.non_cache_tokens, burn.cost_hour });
            } else try out.appendSlice(",\"burnRate\":null");
            if (projection(block, nowMillis())) |proj| {
                try out.print(",\"projection\":{{\"totalTokens\":{},\"totalCost\":{d},\"remainingMinutes\":{}}}", .{ proj.tokens, proj.cost, proj.remaining });
                if (parseTokenLimit(args.token_limit, max_tokens)) |limit| {
                    const percent = @as(f64, @floatFromInt(proj.tokens)) / @as(f64, @floatFromInt(limit)) * 100.0;
                    const status = if (proj.tokens > limit) "exceeds" else if (@as(f64, @floatFromInt(proj.tokens)) > @as(f64, @floatFromInt(limit)) * BLOCKS_WARNING_THRESHOLD) "warning" else "ok";
                    try out.print(",\"tokenLimitStatus\":{{\"limit\":{},\"projectedUsage\":{},\"percentUsed\":{d},\"status\":\"{s}\"}}", .{ limit, proj.tokens, percent, status });
                }
            } else try out.appendSlice(",\"projection\":null");
        } else try out.appendSlice(",\"burnRate\":null,\"projection\":null");
        if (block.reset_time) |reset| {
            const reset_s = try formatIso(allocator, reset);
            try out.appendSlice(",\"usageLimitResetTime\":");
            try writeJsonString(&out, reset_s);
        }
        try out.append('}');
    }
    try out.appendSlice("\n  ]\n}\n");
    try printMaybeJq(allocator, out.items, args.jq);
}

fn printUsageTable(title: []const u8, first_col: []const u8, rows: []const Summary, show_breakdown: bool, force_compact: bool) !void {
    if (rows.len == 0) {
        try stderr().print("No Claude usage data found.\n", .{});
        return;
    }
    _ = force_compact;
    try printTitleBox(title);
    const widths = usageTableWidths(first_col, rows, show_breakdown, null);
    try printBorder("┌", "┬", "┐", widths);
    try printUsageHeader(first_col, widths);
    try printBorder("├", "┼", "┤", widths);
    for (rows) |row| {
        try printSummaryDataRows(row, show_breakdown, widths);
    }
    try printUsageWrappedRow("Total", totalsFor(rows), &.{}, widths, ANSI_YELLOW);
    try printBorder("└", "┴", "┘", widths);
}

fn printSessionTable(title: []const u8, rows: []const Summary, show_breakdown: bool, force_compact: bool) !void {
    if (rows.len == 0) {
        try stderr().print("No Claude usage data found.\n", .{});
        return;
    }
    const compact = force_compact or terminalColumns() < 100;
    try printTitleBox(title);
    const widths = sessionTableWidths(compact);
    try printBorder9("┌", "┬", "┐", widths);
    try printSessionHeader(widths);
    try printBorder9("├", "┼", "┤", widths);
    for (rows) |row| {
        try printSessionDataRows(row, show_breakdown, widths);
    }
    try printSessionWrappedRow("Total", totalsFor(rows), &.{}, null, widths, ANSI_YELLOW);
    try printBorder9("└", "┴", "┘", widths);
}

fn printDailyProjectsTable(title: []const u8, first_col: []const u8, rows: []const Summary, show_breakdown: bool, force_compact: bool, aliases: ?[]const u8) !void {
    if (rows.len == 0) {
        try stderr().print("No Claude usage data found.\n", .{});
        return;
    }
    _ = force_compact;
    try printTitleBox(title);
    const widths = usageTableWidths(first_col, rows, show_breakdown, aliases);
    try printBorder("┌", "┬", "┐", widths);
    try printUsageHeader(first_col, widths);
    try printBorder("├", "┼", "┤", widths);

    for (rows, 0..) |row, idx| {
        const project = row.project orelse continue;
        if (!isFirstProjectOccurrence(rows[0..idx], project)) continue;
        if (idx != 0) {
            try printEmptyTableLine(widths);
            try printBorder("├", "┼", "┤", widths);
        }
        try printProjectHeader(project, aliases, widths);
        try printBorder("├", "┼", "┤", widths);
        for (rows) |project_row| {
            if (project_row.project) |row_project| {
                if (std.mem.eql(u8, row_project, project)) {
                    try printSummaryDataRows(project_row, show_breakdown, widths);
                }
            }
        }
    }
    try printUsageWrappedRow("Total", totalsFor(rows), &.{}, widths, ANSI_YELLOW);
    try printBorder("└", "┴", "┘", widths);
}

fn printSummaryDataRows(row: Summary, show_breakdown: bool, widths: [8]usize) !void {
    try printUsageWrappedRow(row.label, row.totals, row.models.items, widths, null);
    try printBorder("├", "┼", "┤", widths);
    if (show_breakdown) {
        for (row.breakdowns.items) |breakdown| {
            var label_buf: [96]u8 = undefined;
            try printUsageWrappedRow(modelBreakdownLabel(breakdown.model, &label_buf), breakdown.totals, &.{}, widths, ANSI_GRAY);
            try printBorder("├", "┼", "┤", widths);
        }
    }
}

fn printSessionDataRows(row: Summary, show_breakdown: bool, widths: [9]usize) !void {
    try printSessionWrappedRow(row.label, row.totals, row.models.items, row.last_activity, widths, null);
    try printBorder9("├", "┼", "┤", widths);
    if (show_breakdown) {
        for (row.breakdowns.items) |breakdown| {
            var label_buf: [96]u8 = undefined;
            try printSessionWrappedRow(modelBreakdownLabel(breakdown.model, &label_buf), breakdown.totals, &.{}, null, widths, ANSI_GRAY);
            try printBorder9("├", "┼", "┤", widths);
        }
    }
}

fn hasProjectRows(rows: []const Summary) bool {
    for (rows) |row| if (row.project != null) return true;
    return false;
}

fn isFirstProjectOccurrence(previous: []const Summary, project: []const u8) bool {
    for (previous) |row| {
        if (row.project) |seen| {
            if (std.mem.eql(u8, seen, project)) return false;
        }
    }
    return true;
}

fn usageTableWidths(first_col: []const u8, rows: []const Summary, show_breakdown: bool, aliases: ?[]const u8) [8]usize {
    var content = [_]usize{ first_col.len, "Models".len, "Input".len, "Output".len, "Cache Create".len, "Cache Read".len, "Total Tokens".len, "Cost (USD)".len };
    for (rows) |row| {
        updateUsageContentWidths(&content, row.label, row.totals, row.models.items);
        if (row.project) |project| {
            var project_buf: [128]u8 = undefined;
            var label_buf: [160]u8 = undefined;
            content[0] = @max(content[0], projectHeaderLabel(formatProjectName(project, aliases, &project_buf), &label_buf).len);
        }
        if (show_breakdown) {
            for (row.breakdowns.items) |breakdown| {
                var label_buf: [96]u8 = undefined;
                updateUsageContentWidths(&content, modelBreakdownLabel(breakdown.model, &label_buf), breakdown.totals, &.{});
            }
        }
    }
    updateUsageContentWidths(&content, "Total", totalsFor(rows), &.{});
    return adjustedUsageTableWidths(content);
}

fn updateUsageContentWidths(widths: *[8]usize, label_raw: []const u8, totals: TokenTotals, models: []const []const u8) void {
    widths[0] = @max(widths[0], displayWidth(label_raw));
    var model_width: usize = 0;
    for (models) |model| {
        var model_buf: [96]u8 = undefined;
        model_width += displayWidth(modelBullet(model, &model_buf));
    }
    widths[1] = @max(widths[1], model_width);
    var input_buf: [32]u8 = undefined;
    var output_buf: [32]u8 = undefined;
    var cache_create_buf: [32]u8 = undefined;
    var cache_read_buf: [32]u8 = undefined;
    var total_buf: [32]u8 = undefined;
    var cost_buf: [32]u8 = undefined;
    widths[2] = @max(widths[2], formatNumber(totals.input_tokens, &input_buf).len);
    widths[3] = @max(widths[3], formatNumber(totals.output_tokens, &output_buf).len);
    widths[4] = @max(widths[4], formatNumber(totals.cache_creation_tokens, &cache_create_buf).len);
    widths[5] = @max(widths[5], formatNumber(totals.cache_read_tokens, &cache_read_buf).len);
    widths[6] = @max(widths[6], formatNumber(totals.total(), &total_buf).len);
    widths[7] = @max(widths[7], formatCurrency(totals.cost, &cost_buf).len);
}

fn adjustedUsageTableWidths(content: [8]usize) [8]usize {
    var widths = [_]usize{
        @max(content[0] + 2, @as(usize, 10)),
        @max(content[1] + 2, @as(usize, 15)),
        @max(content[2] + 3, @as(usize, 11)),
        @max(content[3] + 3, @as(usize, 11)),
        @max(content[4] + 3, @as(usize, 11)),
        @max(content[5] + 3, @as(usize, 11)),
        @max(content[6] + 3, @as(usize, 11)),
        @max(content[7] + 3, @as(usize, 11)),
    };
    const columns = terminalColumns();
    const overhead: usize = 3 * widths.len + 1;
    var total_content: usize = 0;
    for (widths) |width| total_content += width;
    if (total_content + overhead <= columns) return usageCellWidths(widths);

    const available = if (columns > overhead) columns - overhead else 0;
    const scale = @as(f64, @floatFromInt(available)) / @as(f64, @floatFromInt(total_content));
    for (&widths, 0..) |*width, idx| {
        const scaled: usize = @intFromFloat(@floor(@as(f64, @floatFromInt(width.*)) * scale));
        width.* = switch (idx) {
            0 => @max(scaled, @as(usize, 10)),
            1 => @max(scaled, @as(usize, 12)),
            2...7 => @max(scaled, @as(usize, 10)),
            else => scaled,
        };
    }
    return usageCellWidths(widths);
}

fn usageCellWidths(table_widths: [8]usize) [8]usize {
    var widths = table_widths;
    for (&widths) |*width| width.* = if (width.* > 2) width.* - 2 else 0;
    return widths;
}

fn sessionTableWidths(compact: bool) [9]usize {
    const columns = terminalColumns();
    const model_width: usize = if (compact or columns <= 120) 16 else @min(@max(@as(usize, 20), columns / 4), @as(usize, 36));
    return .{ 18, model_width, 8, 8, 8, 8, 8, 8, 13 };
}

fn printBorder(left: []const u8, sep: []const u8, right: []const u8, widths: [8]usize) !void {
    try stdout().writeAll(ANSI_GRAY);
    try stdout().writeAll(left);
    for (widths, 0..) |width, idx| {
        try writeRepeat(stdout(), "─", width + 2);
        if (idx + 1 < widths.len) try stdout().writeAll(sep);
    }
    try stdout().writeAll(right);
    try stdout().writeAll(ANSI_RESET);
    try stdout().writeAll("\n");
}

fn printBorder9(left: []const u8, sep: []const u8, right: []const u8, widths: [9]usize) !void {
    try stdout().writeAll(ANSI_GRAY);
    try stdout().writeAll(left);
    for (widths, 0..) |width, idx| {
        try writeRepeat(stdout(), "─", width + 2);
        if (idx + 1 < widths.len) try stdout().writeAll(sep);
    }
    try stdout().writeAll(right);
    try stdout().writeAll(ANSI_RESET);
    try stdout().writeAll("\n");
}

fn printUsageHeader(first_col: []const u8, widths: [8]usize) !void {
    const top = [_][]const u8{ first_col, "Models", "Input", "Output", "Cache", "Cache", "Total", "Cost" };
    const bottom = [_][]const u8{ "", "", "", "", "Create", "Read", "Tokens", "(USD)" };
    try printTableLine(top, widths, .{ .right_from = 2, .color = ANSI_CYAN });
    try printTableLine(bottom, widths, .{ .right_from = 2, .color = ANSI_CYAN });
}

fn printSessionHeader(widths: [9]usize) !void {
    const top = [_][]const u8{ "Session", "Models", "Input", "Output", "Cache", "Cache", "Total", "Cost", "Last" };
    const bottom = [_][]const u8{ "", "", "", "", "Create", "Read", "Tokens", "(USD)", "Activity" };
    try printTableLine9(top, widths, .{ .right_from = 2, .color = ANSI_CYAN });
    try printTableLine9(bottom, widths, .{ .right_from = 2, .color = ANSI_CYAN });
}

const LineStyle = struct {
    right_from: usize,
    color: ?[]const u8 = null,
};

fn printTableLine(cells: [8][]const u8, widths: [8]usize, style: LineStyle) !void {
    try stdout().writeAll(ANSI_GRAY);
    try stdout().writeAll("│");
    try stdout().writeAll(ANSI_RESET);
    for (cells, 0..) |cell, idx| {
        try stdout().writeAll(" ");
        try writeCell(cell, widths[idx], idx >= style.right_from, style.color);
        try stdout().writeAll(" ");
        try stdout().writeAll(ANSI_GRAY);
        try stdout().writeAll("│");
        try stdout().writeAll(ANSI_RESET);
    }
    try stdout().writeAll("\n");
}

fn printTableLine9(cells: [9][]const u8, widths: [9]usize, style: LineStyle) !void {
    try stdout().writeAll(ANSI_GRAY);
    try stdout().writeAll("│");
    try stdout().writeAll(ANSI_RESET);
    for (cells, 0..) |cell, idx| {
        try stdout().writeAll(" ");
        try writeCell(cell, widths[idx], idx >= style.right_from, style.color);
        try stdout().writeAll(" ");
        try stdout().writeAll(ANSI_GRAY);
        try stdout().writeAll("│");
        try stdout().writeAll(ANSI_RESET);
    }
    try stdout().writeAll("\n");
}

fn printEmptyTableLine(widths: [8]usize) !void {
    const cells = [_][]const u8{ "", "", "", "", "", "", "", "" };
    try printTableLine(cells, widths, .{ .right_from = 2 });
}

fn printProjectHeader(project: []const u8, aliases: ?[]const u8, widths: [8]usize) !void {
    var project_buf: [128]u8 = undefined;
    const display = formatProjectName(project, aliases, &project_buf);
    var label_buf: [160]u8 = undefined;
    const lines = splitLabelLinesForWidth(projectHeaderLabel(display, &label_buf), widths[0]);
    var line_idx: usize = 0;
    while (line_idx < lines.count) : (line_idx += 1) {
        const cells = [_][]const u8{ lines.lines[line_idx], "", "", "", "", "", "", "" };
        try printTableLine(cells, widths, .{ .right_from = 2, .color = ANSI_CYAN });
    }
}

fn printUsageWrappedRow(label_raw: []const u8, totals: TokenTotals, models: []const []const u8, widths: [8]usize, color: ?[]const u8) !void {
    var input_buf: [32]u8 = undefined;
    var output_buf: [32]u8 = undefined;
    var cache_create_buf: [32]u8 = undefined;
    var cache_read_buf: [32]u8 = undefined;
    var total_buf: [32]u8 = undefined;
    var cost_buf: [32]u8 = undefined;
    const numeric = [_][]const u8{
        formatNumber(totals.input_tokens, &input_buf),
        formatNumber(totals.output_tokens, &output_buf),
        formatNumber(totals.cache_creation_tokens, &cache_create_buf),
        formatNumber(totals.cache_read_tokens, &cache_read_buf),
        formatNumber(totals.total(), &total_buf),
        formatCurrency(totals.cost, &cost_buf),
    };
    const date_lines = splitLabelLinesForWidth(label_raw, widths[0]);
    const line_count = @max(date_lines.count, @max(@as(usize, 1), models.len));
    var line_idx: usize = 0;
    while (line_idx < line_count) : (line_idx += 1) {
        var model_buf: [96]u8 = undefined;
        const model_text = if (line_idx < models.len) modelBullet(models[line_idx], &model_buf) else "";
        const cells = [_][]const u8{
            if (line_idx < date_lines.count) date_lines.lines[line_idx] else "",
            model_text,
            if (line_idx == 0) numeric[0] else "",
            if (line_idx == 0) numeric[1] else "",
            if (line_idx == 0) numeric[2] else "",
            if (line_idx == 0) numeric[3] else "",
            if (line_idx == 0) numeric[4] else "",
            if (line_idx == 0) numeric[5] else "",
        };
        try printTableLine(cells, widths, .{ .right_from = 2, .color = color });
    }
}

fn printSessionWrappedRow(label_raw: []const u8, totals: TokenTotals, models: []const []const u8, last_activity: ?[]const u8, widths: [9]usize, color: ?[]const u8) !void {
    var input_buf: [32]u8 = undefined;
    var output_buf: [32]u8 = undefined;
    var cache_create_buf: [32]u8 = undefined;
    var cache_read_buf: [32]u8 = undefined;
    var total_buf: [32]u8 = undefined;
    var cost_buf: [32]u8 = undefined;
    const numeric = [_][]const u8{
        formatNumber(totals.input_tokens, &input_buf),
        formatNumber(totals.output_tokens, &output_buf),
        formatNumber(totals.cache_creation_tokens, &cache_create_buf),
        formatNumber(totals.cache_read_tokens, &cache_read_buf),
        formatNumber(totals.total(), &total_buf),
        formatCurrency(totals.cost, &cost_buf),
    };
    const label_lines = splitLabelLinesForWidth(label_raw, widths[0]);
    const activity_lines = if (last_activity) |activity| splitLabelLines(activity) else LabelLines{ .lines = .{ "", "" }, .count = 1 };
    const line_count = @max(@max(label_lines.count, activity_lines.count), @max(@as(usize, 1), models.len));
    var line_idx: usize = 0;
    while (line_idx < line_count) : (line_idx += 1) {
        var model_buf: [96]u8 = undefined;
        const model_text = if (line_idx < models.len) modelBullet(models[line_idx], &model_buf) else "";
        const cells = [_][]const u8{
            if (line_idx < label_lines.count) label_lines.lines[line_idx] else "",
            model_text,
            if (line_idx == 0) numeric[0] else "",
            if (line_idx == 0) numeric[1] else "",
            if (line_idx == 0) numeric[2] else "",
            if (line_idx == 0) numeric[3] else "",
            if (line_idx == 0) numeric[4] else "",
            if (line_idx == 0) numeric[5] else "",
            if (line_idx < activity_lines.count) activity_lines.lines[line_idx] else "",
        };
        try printTableLine9(cells, widths, .{ .right_from = 2, .color = color });
    }
}

const LabelLines = struct {
    lines: [2][]const u8,
    count: usize,
};

fn splitLabelLines(label: []const u8) LabelLines {
    if (label.len == 10 and label[4] == '-' and label[7] == '-') {
        return .{ .lines = .{ label[0..4], label[5..10] }, .count = 2 };
    }
    return .{ .lines = .{ label, "" }, .count = 1 };
}

fn splitLabelLinesForWidth(label: []const u8, width: usize) LabelLines {
    const lines = splitLabelLines(label);
    if (lines.count != 1) return lines;
    const project_prefix = "Project: ";
    if (std.mem.startsWith(u8, label, project_prefix) and displayWidth(label) > width) {
        return .{ .lines = .{ label[0 .. project_prefix.len - 1], label[project_prefix.len..] }, .count = 2 };
    }
    const prefix = "  └─ ";
    if (std.mem.startsWith(u8, label, prefix) and displayWidth(label) > width + 2) {
        return .{ .lines = .{ label[0 .. prefix.len - 1], label[prefix.len..] }, .count = 2 };
    }
    return lines;
}

fn modelBullet(model: []const u8, buf: []u8) []const u8 {
    var short_buf: [64]u8 = undefined;
    const display = shortModel(model, &short_buf);
    return std.fmt.bufPrint(buf, "- {s}", .{display}) catch "-";
}

fn modelBreakdownLabel(model: []const u8, buf: []u8) []const u8 {
    var short_buf: [64]u8 = undefined;
    const display = shortModel(model, &short_buf);
    return std.fmt.bufPrint(buf, "  └─ {s}", .{display}) catch "  └─";
}

fn writeCell(text: []const u8, width: usize, right: bool, color: ?[]const u8) !void {
    var fit_buf: [128]u8 = undefined;
    const fitted = fitEllipsis(text, width, &fit_buf);
    const fitted_width = displayWidth(fitted);
    const pad = if (width > fitted_width) width - fitted_width else 0;
    if (right) try writeRepeat(stdout(), " ", pad);
    if (color) |c| try stdout().writeAll(c);
    try stdout().writeAll(fitted);
    if (color != null) try stdout().writeAll(ANSI_RESET);
    if (!right) try writeRepeat(stdout(), " ", pad);
}

fn fitEllipsis(text: []const u8, width: usize, buf: []u8) []const u8 {
    if (displayWidth(text) <= width) return text;
    if (width == 0) return "";
    if (width == 1) return "…";
    var out_len: usize = 0;
    var used_width: usize = 0;
    var idx: usize = 0;
    while (idx < text.len and used_width + 1 < width and out_len < buf.len - 3) {
        const seq_len = utf8SeqLen(text[idx]);
        if (idx + seq_len > text.len or out_len + seq_len > buf.len - 3) break;
        @memcpy(buf[out_len .. out_len + seq_len], text[idx .. idx + seq_len]);
        out_len += seq_len;
        idx += seq_len;
        used_width += 1;
    }
    @memcpy(buf[out_len .. out_len + 3], "…");
    return buf[0 .. out_len + 3];
}

fn displayWidth(text: []const u8) usize {
    var width: usize = 0;
    var idx: usize = 0;
    while (idx < text.len) {
        if (text[idx] < 0x80) {
            idx += 1;
            width += 1;
            continue;
        }
        const seq_len = utf8SeqLen(text[idx]);
        idx += @min(seq_len, text.len - idx);
        width += 1;
    }
    return width;
}

fn utf8SeqLen(first: u8) usize {
    return std.unicode.utf8ByteSequenceLength(first) catch 1;
}

fn printUsageTableCompact(first_col: []const u8, rows: []const Summary, show_breakdown: bool) !void {
    try stdout().print("┌────────────┬────────────────────────┬────────────┬────────────┬────────────┐\n", .{});
    try stdout().print("│ {s}{s:<10}{s} │ {s}{s:<22}{s} │ {s}{s:>10}{s} │ {s}{s:>10}{s} │ {s}{s:>10}{s} │\n", .{
        ANSI_CYAN, first_col,    ANSI_RESET,
        ANSI_CYAN, "Models",     ANSI_RESET,
        ANSI_CYAN, "Input",      ANSI_RESET,
        ANSI_CYAN, "Output",     ANSI_RESET,
        ANSI_CYAN, "Cost (USD)", ANSI_RESET,
    });
    try stdout().print("├────────────┼────────────────────────┼────────────┼────────────┼────────────┤\n", .{});
    for (rows) |row| {
        try printUsageRowCompact(row.label, row.totals, row.models.items, null);
        if (show_breakdown) {
            for (row.breakdowns.items) |breakdown| {
                var label_buf: [96]u8 = undefined;
                try printUsageRowCompact(modelBreakdownLabel(breakdown.model, &label_buf), breakdown.totals, &.{}, ANSI_GRAY);
            }
        }
    }
    try stdout().print("├────────────┼────────────────────────┼────────────┼────────────┼────────────┤\n", .{});
    try printUsageRowCompact("Total", totalsFor(rows), &.{}, ANSI_YELLOW);
    try stdout().print("└────────────┴────────────────────────┴────────────┴────────────┴────────────┘\n", .{});
}

fn printUsageRow(label_raw: []const u8, totals: TokenTotals, models: []const []const u8) !void {
    var label_buf: [17]u8 = undefined;
    const label = fit(label_raw, &label_buf);
    var models_buf: [29]u8 = undefined;
    const model_text = joinModels(models, &models_buf);
    var input_buf: [32]u8 = undefined;
    var output_buf: [32]u8 = undefined;
    var cache_create_buf: [32]u8 = undefined;
    var cache_read_buf: [32]u8 = undefined;
    var total_buf: [32]u8 = undefined;
    var cost_buf: [32]u8 = undefined;
    try stdout().print("│ {s:<16} │ {s:<28} │ {s:>10} │ {s:>10} │ {s:>12} │ {s:>10} │ {s:>12} │ {s:>10} │\n", .{
        label,
        model_text,
        formatNumber(totals.input_tokens, &input_buf),
        formatNumber(totals.output_tokens, &output_buf),
        formatNumber(totals.cache_creation_tokens, &cache_create_buf),
        formatNumber(totals.cache_read_tokens, &cache_read_buf),
        formatNumber(totals.total(), &total_buf),
        formatCurrency(totals.cost, &cost_buf),
    });
}

fn printUsageRowStyled(label_raw: []const u8, totals: TokenTotals, models: []const []const u8, color: []const u8) !void {
    var label_buf: [17]u8 = undefined;
    const label = fit(label_raw, &label_buf);
    var models_buf: [29]u8 = undefined;
    const model_text = joinModels(models, &models_buf);
    var input_buf: [32]u8 = undefined;
    var output_buf: [32]u8 = undefined;
    var cache_create_buf: [32]u8 = undefined;
    var cache_read_buf: [32]u8 = undefined;
    var total_buf: [32]u8 = undefined;
    var cost_buf: [32]u8 = undefined;
    try stdout().print("│ {s}{s:<16}{s} │ {s}{s:<28}{s} │ {s}{s:>10}{s} │ {s}{s:>10}{s} │ {s}{s:>12}{s} │ {s}{s:>10}{s} │ {s}{s:>12}{s} │ {s}{s:>10}{s} │\n", .{
        color, label,                                                         ANSI_RESET,
        color, model_text,                                                    ANSI_RESET,
        color, formatNumber(totals.input_tokens, &input_buf),                 ANSI_RESET,
        color, formatNumber(totals.output_tokens, &output_buf),               ANSI_RESET,
        color, formatNumber(totals.cache_creation_tokens, &cache_create_buf), ANSI_RESET,
        color, formatNumber(totals.cache_read_tokens, &cache_read_buf),       ANSI_RESET,
        color, formatNumber(totals.total(), &total_buf),                      ANSI_RESET,
        color, formatCurrency(totals.cost, &cost_buf),                        ANSI_RESET,
    });
}

fn printUsageRowCompact(label_raw: []const u8, totals: TokenTotals, models: []const []const u8, color_opt: ?[]const u8) !void {
    var label_buf: [11]u8 = undefined;
    const label = fit(label_raw, &label_buf);
    var models_buf: [23]u8 = undefined;
    const model_text = joinModels(models, &models_buf);
    var input_buf: [32]u8 = undefined;
    var output_buf: [32]u8 = undefined;
    var cost_buf: [32]u8 = undefined;
    const color = color_opt orelse "";
    const reset = if (color_opt == null) "" else ANSI_RESET;
    try stdout().print("│ {s}{s:<10}{s} │ {s}{s:<22}{s} │ {s}{s:>10}{s} │ {s}{s:>10}{s} │ {s}{s:>10}{s} │\n", .{
        color, label,                                           reset,
        color, model_text,                                      reset,
        color, formatNumber(totals.input_tokens, &input_buf),   reset,
        color, formatNumber(totals.output_tokens, &output_buf), reset,
        color, formatCurrency(totals.cost, &cost_buf),          reset,
    });
}

fn printTitleBox(title: []const u8) !void {
    const width = title.len + 4;
    try stdout().writeAll("\n ╭");
    try writeRepeat(stdout(), "─", width);
    try stdout().writeAll("╮\n │");
    try writeRepeat(stdout(), " ", width);
    try stdout().writeAll("│\n │  ");
    try stdout().writeAll(title);
    try stdout().writeAll("  │\n │");
    try writeRepeat(stdout(), " ", width);
    try stdout().writeAll("│\n ╰");
    try writeRepeat(stdout(), "─", width);
    try stdout().writeAll("╯\n\n");
}

fn writeRepeat(writer: *std.Io.Writer, text: []const u8, count: usize) !void {
    if (count == 0 or text.len == 0) return;
    var buffer: [256]u8 = undefined;
    const repeats_per_chunk = @max(@as(usize, 1), buffer.len / text.len);
    var remaining = count;
    while (remaining > 0) {
        const repeats = @min(remaining, repeats_per_chunk);
        var pos: usize = 0;
        var i: usize = 0;
        while (i < repeats) : (i += 1) {
            @memcpy(buffer[pos .. pos + text.len], text);
            pos += text.len;
        }
        try writer.writeAll(buffer[0..pos]);
        remaining -= repeats;
    }
}

fn terminalColumns() usize {
    if (env_map.get("COLUMNS")) |value| {
        return std.fmt.parseInt(usize, value, 10) catch 120;
    }
    return 120;
}

fn printBlocksTable(blocks: []const SessionBlock, args: Args) !void {
    if (blocks.len == 0) {
        try stderr().print("No Claude usage data found.\n", .{});
        return;
    }
    const limit = parseTokenLimit(args.token_limit, maxPreviousTokens(blocks));
    try printTitleBox("Claude Code Token Usage Report - Session Blocks");
    try stdout().print("┌──────────────────────────┬──────────────┬──────────────────────────────┬────────────┬──────────┬────────────┐\n", .{});
    try stdout().print("│ {s}{s:<24}{s} │ {s}{s:<12}{s} │ {s}{s:<28}{s} │ {s}{s:>10}{s} │ {s}{s:>8}{s} │ {s}{s:>10}{s} │\n", .{
        ANSI_CYAN, "Block Start", ANSI_RESET,
        ANSI_CYAN, "Status",      ANSI_RESET,
        ANSI_CYAN, "Models",      ANSI_RESET,
        ANSI_CYAN, "Tokens",      ANSI_RESET,
        ANSI_CYAN, "%",           ANSI_RESET,
        ANSI_CYAN, "Cost",        ANSI_RESET,
    });
    try stdout().print("├──────────────────────────┼──────────────┼──────────────────────────────┼────────────┼──────────┼────────────┤\n", .{});
    for (blocks) |block| {
        var start_buf: [32]u8 = undefined;
        const start = try formatIsoBuf(block.start, &start_buf);
        var model_buf: [29]u8 = undefined;
        var token_buf: [32]u8 = undefined;
        var cost_buf: [32]u8 = undefined;
        var percent_buf: [32]u8 = undefined;
        const percent = if (limit) |l| try std.fmt.bufPrint(&percent_buf, "{d:.1}%", .{@as(f64, @floatFromInt(block.totals.total())) / @as(f64, @floatFromInt(l)) * 100.0}) else "-";
        try stdout().print("│ {s:<24} │ {s:<12} │ {s:<28} │ {s:>10} │ {s:>8} │ {s:>10} │\n", .{
            fit(start, start_buf[0..24]),
            if (block.is_gap) "(inactive)" else if (block.is_active) "ACTIVE" else "",
            joinModels(block.models.items, &model_buf),
            if (block.is_gap) "-" else formatNumber(block.totals.total(), &token_buf),
            percent,
            if (block.is_gap) "-" else formatCurrency(block.totals.cost, &cost_buf),
        });
    }
    try stdout().print("└──────────────────────────┴──────────────┴──────────────────────────────┴────────────┴──────────┴────────────┘\n", .{});
}

fn printActiveBlockDetails(block: SessionBlock, args: Args, max_tokens: u64) !void {
    try printTitleBox("Current Session Block Status");
    var start_buf: [40]u8 = undefined;
    var input_buf: [32]u8 = undefined;
    var output_buf: [32]u8 = undefined;
    var cost_buf: [32]u8 = undefined;
    const now = nowMillis();
    const elapsed = @max(@as(i64, 0), now - block.start) / 60000;
    const remaining = @max(@as(i64, 0), block.end - now) / 60000;
    try stdout().print("Block Started: {s} ({}h {}m ago)\n", .{ try formatIsoBuf(block.start, &start_buf), @divTrunc(elapsed, 60), @mod(elapsed, 60) });
    try stdout().print("Time Remaining: {}h {}m\n\n", .{ @divTrunc(remaining, 60), @mod(remaining, 60) });
    try stdout().print("Current Usage:\n", .{});
    try stdout().print("  Input Tokens:     {s}\n", .{formatNumber(block.totals.input_tokens, &input_buf)});
    try stdout().print("  Output Tokens:    {s}\n", .{formatNumber(block.totals.output_tokens, &output_buf)});
    try stdout().print("  Total Cost:       {s}\n\n", .{formatCurrency(block.totals.cost, &cost_buf)});

    if (burnRate(block)) |burn| {
        var tokens_buf: [32]u8 = undefined;
        var hourly_buf: [32]u8 = undefined;
        try stdout().print("Burn Rate:\n", .{});
        try stdout().print("  Tokens/minute:    {s}\n", .{formatNumber(@intFromFloat(@round(burn.tokens)), &tokens_buf)});
        try stdout().print("  Cost/hour:        {s}\n\n", .{formatCurrency(burn.cost_hour, &hourly_buf)});
    }

    if (projection(block, nowMillis())) |proj| {
        var projected_tokens_buf: [32]u8 = undefined;
        var projected_cost_buf: [32]u8 = undefined;
        try stdout().print("Projected Usage (if current rate continues):\n", .{});
        try stdout().print("  Total Tokens:     {s}\n", .{formatNumber(proj.tokens, &projected_tokens_buf)});
        try stdout().print("  Total Cost:       {s}\n\n", .{formatCurrency(proj.cost, &projected_cost_buf)});
        if (parseTokenLimit(args.token_limit, max_tokens)) |limit| {
            if (limit > 0) {
                var limit_buf: [32]u8 = undefined;
                var current_buf: [32]u8 = undefined;
                var remaining_buf: [32]u8 = undefined;
                const current = block.totals.total();
                const remaining_tokens = if (limit > current) limit - current else 0;
                const current_percent = @as(f64, @floatFromInt(current)) / @as(f64, @floatFromInt(limit)) * 100.0;
                const projected_percent = @as(f64, @floatFromInt(proj.tokens)) / @as(f64, @floatFromInt(limit)) * 100.0;
                const status = if (projected_percent > 100.0) "EXCEEDS LIMIT" else if (projected_percent > BLOCKS_WARNING_THRESHOLD * 100.0) "WARNING" else "OK";
                try stdout().print("Token Limit Status:\n", .{});
                try stdout().print("  Limit:            {s} tokens\n", .{formatNumber(limit, &limit_buf)});
                try stdout().print("  Current Usage:    {s} ({d:.1}%)\n", .{ formatNumber(current, &current_buf), current_percent });
                try stdout().print("  Remaining:        {s} tokens\n", .{formatNumber(remaining_tokens, &remaining_buf)});
                try stdout().print("  Projected Usage:  {d:.1}% {s}\n", .{ projected_percent, status });
            }
        }
    }
}

fn printMaybeJq(allocator: std.mem.Allocator, json_text: []const u8, jq: ?[]const u8) !void {
    const filter = jq orelse {
        try stdout().writeAll(json_text);
        return;
    };
    const tmp = try std.fmt.allocPrint(allocator, "/tmp/ccusage-zig-{d}.json", .{std.Io.Timestamp.now(process_io, .real).toMicroseconds()});
    try std.Io.Dir.cwd().writeFile(process_io, .{ .sub_path = tmp, .data = json_text });
    defer std.Io.Dir.cwd().deleteFile(process_io, tmp) catch {};
    const result = try std.process.run(allocator, process_io, .{ .argv = &.{ "jq", filter, tmp }, .stdout_limit = .unlimited, .stderr_limit = .limited(64 * 1024) });
    defer allocator.free(result.stdout);
    defer allocator.free(result.stderr);
    switch (result.term) {
        .exited => |code| if (code != 0) {
            try stderr().writeAll(result.stderr);
            return error.JqFailed;
        },
        else => return error.JqFailed,
    }
    try stdout().writeAll(result.stdout);
}

fn containsString(items: []const []const u8, needle: []const u8) bool {
    for (items) |item| if (std.mem.eql(u8, item, needle)) return true;
    return false;
}

fn shortSession(session_id: []const u8) []const u8 {
    var last: usize = 0;
    var second_last: usize = 0;
    for (session_id, 0..) |ch, idx| {
        if (ch == '-') {
            second_last = last;
            last = idx + 1;
        }
    }
    return if (second_last > 0) session_id[second_last..] else session_id;
}

fn totalsFor(rows: []const Summary) TokenTotals {
    var totals = TokenTotals{};
    for (rows) |row| {
        totals.input_tokens += row.totals.input_tokens;
        totals.output_tokens += row.totals.output_tokens;
        totals.cache_creation_tokens += row.totals.cache_creation_tokens;
        totals.cache_read_tokens += row.totals.cache_read_tokens;
        totals.cost += row.totals.cost;
    }
    return totals;
}

fn sortSummaries(rows: []Summary, order: SortOrder) void {
    std.mem.sort(Summary, rows, order, summaryLessThan);
}

fn sortSummariesByCost(rows: []Summary) void {
    std.mem.sort(Summary, rows, {}, summaryCostDesc);
}

fn summaryLessThan(order: SortOrder, a: Summary, b: Summary) bool {
    return switch (order) {
        .asc => std.mem.order(u8, a.label, b.label) == .lt,
        .desc => std.mem.order(u8, a.label, b.label) == .gt,
    };
}

fn summaryCostDesc(_: void, a: Summary, b: Summary) bool {
    return a.totals.cost > b.totals.cost;
}

fn stringLessThan(_: void, a: []const u8, b: []const u8) bool {
    return std.mem.order(u8, a, b) == .lt;
}

fn filterSessionSummaries(rows: *std.array_list.Managed(Summary), args: Args) void {
    if (args.since == null and args.until == null) return;
    var write: usize = 0;
    for (rows.items) |row| {
        if (dateInRange(row.last_activity orelse "", args.since, args.until)) {
            rows.items[write] = row;
            write += 1;
        } else {
            row.models.deinit();
            row.breakdowns.deinit();
            row.versions.deinit();
        }
    }
    rows.items.len = write;
}

fn filterBlocks(blocks: *std.array_list.Managed(SessionBlock), args: Args) void {
    if (args.since == null and args.until == null) return;
    var write: usize = 0;
    for (blocks.items) |block| {
        var buf: [32]u8 = undefined;
        const date = formatDateBuf(block.start + timezoneOffsetMillis(block.start, args.timezone), &buf) catch continue;
        if (dateInRange(date, args.since, args.until)) {
            blocks.items[write] = block;
            write += 1;
        }
    }
    blocks.items.len = write;
}

fn nowMillis() i64 {
    return std.Io.Timestamp.now(process_io, .real).toMilliseconds();
}

fn deinitSummaries(rows: []Summary) void {
    for (rows) |row| {
        row.models.deinit();
        row.breakdowns.deinit();
        row.versions.deinit();
    }
}

fn testEntry(date: []const u8, input: u64, output: u64, cache_create: u64, cache_read: u64, cost: f64) Entry {
    return .{
        .timestamp = 0,
        .timestamp_text = "2024-01-01T12:00:00Z",
        .date = date,
        .session_id = "session",
        .project = "project",
        .project_path = "project",
        .version = null,
        .message_id = null,
        .request_id = null,
        .model = null,
        .usage = .{
            .input_tokens = input,
            .output_tokens = output,
            .cache_creation_input_tokens = cache_create,
            .cache_read_input_tokens = cache_read,
        },
        .cost_usd = cost,
        .cost = cost,
        .is_api_error = false,
        .reset_time = null,
        .file_index = 0,
        .file_first_timestamp = 0,
        .line_number = 0,
    };
}

fn testSessionEntry(session_id: []const u8, project_path: []const u8, date: []const u8, version: ?[]const u8, cost: f64) Entry {
    var entry = testEntry(date, 100, 50, 10, 5, cost);
    entry.session_id = session_id;
    entry.project = project_path;
    entry.project_path = project_path;
    entry.version = version;
    return entry;
}

test "monthly summaries match TypeScript grouping, ordering, and cache aggregation cases" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    const entries = [_]Entry{
        testEntry("2024-01-01", 100, 50, 25, 10, 0.01),
        testEntry("2023-12-01", 100, 50, 0, 0, 0.01),
        testEntry("2024-02-01", 100, 50, 0, 0, 0.01),
        testEntry("2023-11-01", 100, 50, 0, 0, 0.01),
        testEntry("2024-01-15", 200, 100, 50, 20, 0.02),
    };
    const args = Args{};
    const daily = try summarizeEntries(allocator, &entries, .daily, args);
    defer deinitSummaries(daily.items);
    sortSummaries(daily.items, .asc);

    const monthly = try summarizeBuckets(allocator, daily.items, .monthly, args.start_of_week);
    defer deinitSummaries(monthly.items);
    sortSummaries(monthly.items, .desc);

    try std.testing.expectEqual(@as(usize, 4), monthly.items.len);
    try std.testing.expectEqualStrings("2024-02", monthly.items[0].label);
    try std.testing.expectEqualStrings("2024-01", monthly.items[1].label);
    try std.testing.expectEqualStrings("2023-12", monthly.items[2].label);
    try std.testing.expectEqualStrings("2023-11", monthly.items[3].label);
    try std.testing.expectEqual(@as(u64, 300), monthly.items[1].totals.input_tokens);
    try std.testing.expectEqual(@as(u64, 150), monthly.items[1].totals.output_tokens);
    try std.testing.expectEqual(@as(u64, 75), monthly.items[1].totals.cache_creation_tokens);
    try std.testing.expectEqual(@as(u64, 30), monthly.items[1].totals.cache_read_tokens);
    try std.testing.expectApproxEqAbs(@as(f64, 0.03), monthly.items[1].totals.cost, 0.000001);

    sortSummaries(monthly.items, .asc);
    try std.testing.expectEqualStrings("2023-11", monthly.items[0].label);
    try std.testing.expectEqualStrings("2023-12", monthly.items[1].label);
    try std.testing.expectEqualStrings("2024-01", monthly.items[2].label);
    try std.testing.expectEqualStrings("2024-02", monthly.items[3].label);
}

test "weekly summaries match TypeScript week starts, ordering, and cache aggregation cases" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    const entries = [_]Entry{
        testEntry("2024-01-01", 100, 50, 25, 10, 0.01),
        testEntry("2023-12-04", 100, 50, 0, 0, 0.01),
        testEntry("2024-02-05", 100, 50, 0, 0, 0.01),
        testEntry("2023-11-06", 100, 50, 0, 0, 0.01),
        testEntry("2024-01-03", 200, 100, 50, 20, 0.02),
    };
    const args = Args{};
    const daily = try summarizeEntries(allocator, &entries, .daily, args);
    defer deinitSummaries(daily.items);
    sortSummaries(daily.items, .asc);

    const weekly = try summarizeBuckets(allocator, daily.items, .weekly, .sunday);
    defer deinitSummaries(weekly.items);
    sortSummaries(weekly.items, .desc);

    try std.testing.expectEqual(@as(usize, 4), weekly.items.len);
    try std.testing.expectEqualStrings("2024-02-04", weekly.items[0].label);
    try std.testing.expectEqualStrings("2023-12-31", weekly.items[1].label);
    try std.testing.expectEqualStrings("2023-12-03", weekly.items[2].label);
    try std.testing.expectEqualStrings("2023-11-05", weekly.items[3].label);
    try std.testing.expectEqual(@as(u64, 300), weekly.items[1].totals.input_tokens);
    try std.testing.expectEqual(@as(u64, 150), weekly.items[1].totals.output_tokens);
    try std.testing.expectEqual(@as(u64, 75), weekly.items[1].totals.cache_creation_tokens);
    try std.testing.expectEqual(@as(u64, 30), weekly.items[1].totals.cache_read_tokens);
    try std.testing.expectApproxEqAbs(@as(f64, 0.03), weekly.items[1].totals.cost, 0.000001);

    sortSummaries(weekly.items, .asc);
    try std.testing.expectEqualStrings("2023-11-05", weekly.items[0].label);
    try std.testing.expectEqualStrings("2023-12-03", weekly.items[1].label);
    try std.testing.expectEqualStrings("2023-12-31", weekly.items[2].label);
    try std.testing.expectEqualStrings("2024-02-04", weekly.items[3].label);

    const monday_weekly = try summarizeBuckets(allocator, daily.items, .weekly, .monday);
    defer deinitSummaries(monday_weekly.items);
    sortSummaries(monday_weekly.items, .asc);
    try std.testing.expectEqualStrings("2023-11-06", monday_weekly.items[0].label);
    try std.testing.expectEqualStrings("2023-12-04", monday_weekly.items[1].label);
    try std.testing.expectEqualStrings("2024-01-01", monday_weekly.items[2].label);
    try std.testing.expectEqualStrings("2024-02-05", monday_weekly.items[3].label);
}

test "session summaries match TypeScript aggregation, versions, cost sort, and last activity filtering" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    const entries = [_]Entry{
        testSessionEntry("session1", "project1", "2024-01-01", "1.1.0", 0.05),
        testSessionEntry("session1", "project1", "2024-01-15", "1.0.0", 0.02),
        testSessionEntry("session1", "project1", "2024-01-15", "1.1.0", 0.03),
        testSessionEntry("session2", "project2", "2024-01-01", null, 0.01),
        testSessionEntry("session3", "project1", "2024-01-31", null, 0.2),
    };
    var args = Args{ .since = "20240110", .until = "20240125" };
    var rows = try summarizeEntries(allocator, &entries, .session, args);
    defer deinitSummaries(rows.items);

    filterSessionSummaries(&rows, args);
    try std.testing.expectEqual(@as(usize, 1), rows.items.len);
    try std.testing.expectEqualStrings("session1", rows.items[0].session_id.?);
    try std.testing.expectEqualStrings("project1", rows.items[0].project_path.?);
    try std.testing.expectEqualStrings("2024-01-15", rows.items[0].last_activity.?);
    try std.testing.expectEqual(@as(u64, 300), rows.items[0].totals.input_tokens);
    try std.testing.expectEqual(@as(u64, 150), rows.items[0].totals.output_tokens);
    try std.testing.expectEqual(@as(u64, 30), rows.items[0].totals.cache_creation_tokens);
    try std.testing.expectEqual(@as(u64, 15), rows.items[0].totals.cache_read_tokens);
    try std.testing.expectApproxEqAbs(@as(f64, 0.1), rows.items[0].totals.cost, 0.000001);
    try std.testing.expectEqual(@as(usize, 2), rows.items[0].versions.items.len);
    try std.testing.expectEqualStrings("1.0.0", rows.items[0].versions.items[0]);
    try std.testing.expectEqualStrings("1.1.0", rows.items[0].versions.items[1]);

    args = Args{};
    const all_rows = try summarizeEntries(allocator, &entries, .session, args);
    defer deinitSummaries(all_rows.items);
    sortSummariesByCost(all_rows.items);
    try std.testing.expectEqualStrings("session3", all_rows.items[0].session_id.?);
    try std.testing.expectEqualStrings("session1", all_rows.items[1].session_id.?);
    try std.testing.expectEqualStrings("session2", all_rows.items[2].session_id.?);
}
