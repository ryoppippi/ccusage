const std = @import("std");
const config_loader = @import("_config-loader.zig");
const date_utils = @import("_date-utils.zig");
const format_utils = @import("_format-utils.zig");
const json_utils = @import("_json-utils.zig");
const pricing_utils = @import("_pricing.zig");
const shared_args = @import("_shared-args.zig");
const token_utils = @import("_token-utils.zig");

const Args = shared_args.Args;
const PricingMap = pricing_utils.PricingMap;
const TokenUsage = token_utils.TokenUsage;
const allDigits = format_utils.allDigits;
const calculateTokenCost = pricing_utils.calculateTokenCost;
const dateInRange = date_utils.dateInRange;
const formatDateForTimezone = date_utils.formatDateForTimezone;
const indexOfNeedle = json_utils.indexOfNeedle;
const jsonBoolField = json_utils.jsonBoolField;
const jsonF64Field = json_utils.jsonF64Field;
const jsonObjectField = json_utils.jsonObjectField;
const jsonObjectFieldLast = json_utils.jsonObjectFieldLast;
const jsonStringField = json_utils.jsonStringField;
const jsonStringFieldLast = json_utils.jsonStringFieldLast;
const jsonU64Field = json_utils.jsonU64Field;
const parseTimestamp = date_utils.parseTimestamp;

const EnvMap = std.process.Environ.Map;

pub const Entry = struct {
    timestamp: i64,
    timestamp_text: []const u8,
    date: []const u8,
    session_id: []const u8,
    project: []const u8,
    project_path: []const u8,
    version: ?[]const u8,
    message_id: ?[]const u8,
    request_id: ?[]const u8,
    model: ?[]const u8,
    usage: TokenUsage,
    cost_usd: ?f64,
    cost: f64,
    is_api_error: bool,
    reset_time: ?i64,
    file_index: usize,
    file_first_timestamp: i64,
    line_number: usize,
};

const ParseWorker = struct {
    allocator: std.mem.Allocator,
    io: *std.Io,
    files: []const []const u8,
    start: usize,
    end: usize,
    args: Args,
    pricing: *const PricingMap,
    entries: std.array_list.Managed(Entry),
    err: ?anyerror = null,
};

pub const ParsedUsageLine = struct {
    timestamp_text: []const u8,
    version: ?[]const u8,
    message_id: ?[]const u8,
    request_id: ?[]const u8,
    model_raw: ?[]const u8,
    usage: TokenUsage,
    cost_usd: ?f64,
    is_api_error: bool,
    reset_time: ?i64,
};

pub fn parseUsageLine(line: []const u8, need_version: bool, need_reset_time: bool) ?ParsedUsageLine {
    const message = jsonObjectField(line, "\"message\"") orelse return null;
    const message_fields = fastMessageFields(line) orelse return null;
    const usage_obj = jsonObjectFieldLast(message, "\"usage\"") orelse return null;
    const input_tokens = jsonU64Field(usage_obj, "\"input_tokens\"") orelse return null;
    const output_tokens = jsonU64Field(usage_obj, "\"output_tokens\"") orelse return null;
    const speed = jsonStringField(usage_obj, "\"speed\"");
    if (speed) |value| {
        if (!std.mem.eql(u8, value, "standard") and !std.mem.eql(u8, value, "fast")) return null;
    }
    const timestamp_text = jsonStringFieldLast(line, "\"timestamp\"") orelse return null;
    if (!isIsoTimestamp(timestamp_text)) return null;
    const version_raw = jsonStringField(line, "\"version\"");
    // TypeScript validates version whenever the field exists, even when the caller does not need to store it.
    if (version_raw) |value| if (!isVersion(value)) return null;
    const version = if (need_version) version_raw else null;
    const message_id = message_fields.id orelse jsonStringField(message, "\"id\"");
    if (message_id) |value| if (value.len == 0) return null;
    const request_id = jsonStringFieldLast(line, "\"requestId\"");
    if (request_id) |value| if (value.len == 0) return null;
    return .{
        .timestamp_text = timestamp_text,
        .version = version,
        .message_id = message_id,
        .request_id = request_id,
        .model_raw = message_fields.model orelse jsonStringField(message, "\"model\""),
        .usage = .{
            .input_tokens = input_tokens,
            .output_tokens = output_tokens,
            .cache_creation_input_tokens = jsonU64Field(usage_obj, "\"cache_creation_input_tokens\"") orelse 0,
            .cache_read_input_tokens = jsonU64Field(usage_obj, "\"cache_read_input_tokens\"") orelse 0,
            .speed_fast = if (speed) |value| std.mem.eql(u8, value, "fast") else false,
        },
        .cost_usd = if (indexOfNeedle(line, "\"costUSD\"") != null) jsonF64Field(line, "\"costUSD\"") else null,
        .is_api_error = if (need_reset_time) jsonBoolField(line, "\"isApiErrorMessage\"") orelse false else false,
        .reset_time = if (need_reset_time) usageLimitResetTime(line) else null,
    };
}

const FastMessageFields = struct {
    id: ?[]const u8 = null,
    model: ?[]const u8 = null,
};

fn fastMessageFields(line: []const u8) ?FastMessageFields {
    const message_key = indexOfNeedle(line, "\"message\"") orelse return null;
    var i = message_key + "\"message\"".len;
    while (i < line.len and isJsonSpace(line[i])) i += 1;
    if (i >= line.len or line[i] != ':') return null;
    i += 1;
    while (i < line.len and isJsonSpace(line[i])) i += 1;
    if (i >= line.len or line[i] != '{') return null;
    i += 1;

    var result = FastMessageFields{};
    while (i < line.len) {
        while (i < line.len and (isJsonSpace(line[i]) or line[i] == ',')) i += 1;
        if (i >= line.len) return null;
        if (line[i] == '}') return result;
        if (line[i] != '"') return null;
        const key_start = i;
        const key_end = stringEnd(line, i) orelse return null;
        i = key_end + 1;
        while (i < line.len and isJsonSpace(line[i])) i += 1;
        if (i >= line.len or line[i] != ':') return null;
        i += 1;
        while (i < line.len and isJsonSpace(line[i])) i += 1;
        const key = line[key_start .. key_end + 1];
        if (std.mem.eql(u8, key, "\"content\"")) return result;
        if (std.mem.eql(u8, key, "\"id\"") and i < line.len and line[i] == '"') {
            const value_end = stringEnd(line, i) orelse return null;
            result.id = line[i + 1 .. value_end];
            i = value_end + 1;
        } else if (std.mem.eql(u8, key, "\"model\"") and i < line.len and line[i] == '"') {
            const value_end = stringEnd(line, i) orelse return null;
            result.model = line[i + 1 .. value_end];
            i = value_end + 1;
        } else {
            i = skipSimpleValue(line, i) orelse return null;
        }
        if (result.id != null and result.model != null) return result;
    }
    return null;
}

fn skipSimpleValue(line: []const u8, start: usize) ?usize {
    if (start >= line.len) return null;
    if (line[start] == '"') return (stringEnd(line, start) orelse return null) + 1;
    var i = start;
    while (i < line.len and line[i] != ',' and line[i] != '}') i += 1;
    return i;
}

fn stringEnd(line: []const u8, start: usize) ?usize {
    if (start >= line.len or line[start] != '"') return null;
    var i = start + 1;
    var escaped = false;
    while (i < line.len) : (i += 1) {
        const ch = line[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch == '\\') {
            escaped = true;
            continue;
        }
        if (ch == '"') return i;
    }
    return null;
}

fn isJsonSpace(ch: u8) bool {
    return ch == ' ' or ch == '\t' or ch == '\r' or ch == '\n';
}

pub fn usageLimitResetTime(line: []const u8) ?i64 {
    const marker = "Claude AI usage limit reached";
    const marker_index = std.mem.indexOf(u8, line, marker) orelse return null;
    const rest = line[marker_index + marker.len ..];
    const pipe_index = std.mem.indexOfScalar(u8, rest, '|') orelse return null;
    var i = pipe_index + 1;
    if (i >= rest.len or rest[i] < '0' or rest[i] > '9') return null;
    var seconds: i64 = 0;
    while (i < rest.len and rest[i] >= '0' and rest[i] <= '9') : (i += 1) {
        seconds = std.math.mul(i64, seconds, 10) catch return null;
        seconds = std.math.add(i64, seconds, rest[i] - '0') catch return null;
    }
    return if (seconds > 0) seconds * 1000 else null;
}

pub fn displayModel(allocator: std.mem.Allocator, model: []const u8, fast: bool) !?[]const u8 {
    if (std.mem.eql(u8, model, "<synthetic>")) return null;
    if (fast) return try std.fmt.allocPrint(allocator, "{s}-fast", .{model});
    return model;
}

pub fn loadEntries(allocator: std.mem.Allocator, entries: *std.array_list.Managed(Entry), args: Args, pricing: *const PricingMap, process_io: *std.Io, env_map: *EnvMap) !void {
    var paths = std.array_list.Managed([]const u8).init(allocator);
    defer paths.deinit();
    try config_loader.claudePaths(allocator, &paths, process_io, env_map);

    var files = std.array_list.Managed([]const u8).init(allocator);
    defer files.deinit();
    for (paths.items) |path| {
        const projects = try std.fs.path.join(allocator, &.{ path, "projects" });
        try collectJsonlFiles(allocator, process_io, projects, &files);
    }
    std.mem.sort([]const u8, files.items, {}, stringLessThan);

    try readUsageFilesParallel(allocator, process_io, entries, files.items, args, pricing);
    try dedupeEntries(allocator, entries);
}

fn readUsageFilesParallel(allocator: std.mem.Allocator, process_io: *std.Io, entries: *std.array_list.Managed(Entry), files: []const []const u8, args: Args, pricing: *const PricingMap) !void {
    if (files.len == 0) return;
    if (args.single_thread) {
        for (files, 0..) |file, file_index| try readUsageFile(allocator, process_io, entries, file, file_index, args, pricing);
        return;
    }
    const cpu_count = std.Thread.getCpuCount() catch 1;
    const requested_workers = args.threads orelse cpu_count;
    const worker_count = @min(files.len, @max(@as(usize, 1), requested_workers));
    if (worker_count == 1) {
        for (files, 0..) |file, file_index| try readUsageFile(allocator, process_io, entries, file, file_index, args, pricing);
        return;
    }

    const workers = try allocator.alloc(ParseWorker, worker_count);
    const arenas = try allocator.alloc(std.heap.ArenaAllocator, worker_count);
    const threads = try allocator.alloc(std.Thread, worker_count);
    const chunk_size = (files.len + worker_count - 1) / worker_count;

    for (workers, 0..) |*worker, idx| {
        arenas[idx] = std.heap.ArenaAllocator.init(allocator);
        const worker_allocator = arenas[idx].allocator();
        const start = idx * chunk_size;
        const end = @min(files.len, start + chunk_size);
        worker.* = .{
            .allocator = worker_allocator,
            .io = process_io,
            .files = files,
            .start = start,
            .end = end,
            .args = args,
            .pricing = pricing,
            .entries = std.array_list.Managed(Entry).init(worker_allocator),
        };
        threads[idx] = try std.Thread.spawn(.{}, parseWorkerMain, .{worker});
    }

    for (threads) |thread| thread.join();
    for (workers) |*worker| {
        if (worker.err) |err| return err;
        try entries.appendSlice(worker.entries.items);
    }
}

fn parseWorkerMain(worker: *ParseWorker) void {
    var file_index = worker.start;
    while (file_index < worker.end) : (file_index += 1) {
        readUsageFile(worker.allocator, worker.io, &worker.entries, worker.files[file_index], file_index, worker.args, worker.pricing) catch |err| {
            worker.err = err;
            return;
        };
    }
}

fn collectJsonlFiles(allocator: std.mem.Allocator, process_io: *std.Io, dir_path: []const u8, files: *std.array_list.Managed([]const u8)) !void {
    var dir = std.Io.Dir.openDirAbsolute(process_io.*, dir_path, .{ .iterate = true }) catch return;
    defer dir.close(process_io.*);
    var it = dir.iterate();
    while (try it.next(process_io.*)) |entry| {
        const child = try std.fs.path.join(allocator, &.{ dir_path, entry.name });
        switch (entry.kind) {
            .file => if (std.mem.endsWith(u8, entry.name, ".jsonl")) try files.append(child),
            .directory => try collectJsonlFiles(allocator, process_io, child, files),
            else => {},
        }
    }
}

fn readUsageFile(allocator: std.mem.Allocator, process_io: *std.Io, entries: *std.array_list.Managed(Entry), file_path: []const u8, file_index: usize, args: Args, pricing: *const PricingMap) !void {
    const needs_project = args.command == .daily and (args.instances or args.project != null);
    const needs_session_parts = args.command == .session;
    const project = if (needs_project) try extractProject(allocator, file_path) else "unknown";
    if (args.project) |filter| {
        if (!std.mem.eql(u8, filter, project)) return;
    }
    const parts = if (needs_session_parts) try extractSessionParts(allocator, file_path) else SessionParts{ .session_id = "unknown", .file_session_id = "unknown", .project_path = "Unknown Project" };
    if (args.command == .session) {
        if (args.id) |id| {
            if (!std.mem.eql(u8, parts.file_session_id, id)) return;
        }
    }
    const data = std.Io.Dir.cwd().readFileAlloc(process_io.*, file_path, allocator, .limited(1024 * 1024 * 1024)) catch return;
    const start_len = entries.items.len;
    var file_first_timestamp: ?i64 = null;
    var line_it = std.mem.splitScalar(u8, data, '\n');
    var line_number: usize = 0;
    while (line_it.next()) |line_raw| {
        const line = if (line_raw.len > 0 and line_raw[line_raw.len - 1] == '\r') line_raw[0 .. line_raw.len - 1] else line_raw;
        line_number += 1;
        if (line.len == 0) continue;
        if (indexOfNeedle(line, "\"input_tokens\"") == null) {
            updateEarliestTimestamp(line, &file_first_timestamp);
            continue;
        }
        const parsed = parseUsageLine(line, args.command == .session or (args.debug and !args.json), args.command == .blocks) orelse {
            updateEarliestTimestamp(line, &file_first_timestamp);
            continue;
        };
        if (parsed.model_raw != null and parsed.model_raw.?.len == 0) continue;
        const model = if (parsed.model_raw) |m| try displayModel(allocator, m, parsed.usage.speed_fast) else null;
        const cost = switch (args.mode) {
            .display => parsed.cost_usd orelse 0,
            .auto => parsed.cost_usd orelse calculateTokenCost(parsed.model_raw, parsed.usage, pricing),
            .calculate => calculateTokenCost(parsed.model_raw, parsed.usage, pricing),
        };
        const timestamp_ms = parseTimestamp(parsed.timestamp_text) orelse continue;
        if (file_first_timestamp == null or timestamp_ms < file_first_timestamp.?) file_first_timestamp = timestamp_ms;
        const date = try formatDateForTimezone(allocator, timestamp_ms, args.timezone);
        if (args.command != .session and !dateInRange(date, args.since, args.until)) continue;
        try entries.append(.{
            .timestamp = timestamp_ms,
            .timestamp_text = parsed.timestamp_text,
            .date = date,
            .session_id = parts.session_id,
            .project = project,
            .project_path = parts.project_path,
            .version = parsed.version,
            .message_id = parsed.message_id,
            .request_id = parsed.request_id,
            .model = model,
            .usage = parsed.usage,
            .cost_usd = parsed.cost_usd,
            .cost = cost,
            .is_api_error = parsed.is_api_error,
            .reset_time = parsed.reset_time,
            .file_index = file_index,
            .file_first_timestamp = file_first_timestamp orelse timestamp_ms,
            .line_number = line_number,
        });
    }
    const first_timestamp = file_first_timestamp orelse return;
    for (entries.items[start_len..]) |*entry| entry.file_first_timestamp = first_timestamp;
}

fn updateEarliestTimestamp(line: []const u8, file_first_timestamp: *?i64) void {
    if (indexOfNeedle(line, "\"timestamp\"") == null) return;
    const timestamp_text = jsonStringField(line, "\"timestamp\"") orelse return;
    if (!isIsoTimestamp(timestamp_text)) return;
    const timestamp_ms = parseTimestamp(timestamp_text) orelse return;
    if (file_first_timestamp.* == null or timestamp_ms < file_first_timestamp.*.?) file_first_timestamp.* = timestamp_ms;
}

const SessionParts = struct { session_id: []const u8, file_session_id: []const u8, project_path: []const u8 };

fn extractProject(allocator: std.mem.Allocator, path: []const u8) ![]const u8 {
    var it = std.mem.splitAny(u8, path, "/\\");
    var saw = false;
    while (it.next()) |part| {
        if (saw) return allocator.dupe(u8, if (part.len == 0) "unknown" else part);
        if (std.mem.eql(u8, part, "projects")) saw = true;
    }
    return allocator.dupe(u8, "unknown");
}

fn extractSessionParts(allocator: std.mem.Allocator, path: []const u8) !SessionParts {
    var parts = std.array_list.Managed([]const u8).init(allocator);
    defer parts.deinit();
    var it = std.mem.splitAny(u8, path, "/\\");
    var after_projects = false;
    while (it.next()) |part| {
        if (after_projects) try parts.append(part);
        if (std.mem.eql(u8, part, "projects")) after_projects = true;
    }
    if (parts.items.len >= 2) {
        const session_id = parts.items[parts.items.len - 2];
        const file_name = parts.items[parts.items.len - 1];
        const file_session_id = if (std.mem.endsWith(u8, file_name, ".jsonl")) file_name[0 .. file_name.len - ".jsonl".len] else file_name;
        const project_path = if (parts.items.len > 2) try std.mem.join(allocator, std.fs.path.sep_str, parts.items[0 .. parts.items.len - 2]) else try allocator.dupe(u8, "Unknown Project");
        return .{ .session_id = try allocator.dupe(u8, session_id), .file_session_id = try allocator.dupe(u8, file_session_id), .project_path = project_path };
    }
    return .{ .session_id = try allocator.dupe(u8, "unknown"), .file_session_id = try allocator.dupe(u8, "unknown"), .project_path = try allocator.dupe(u8, "Unknown Project") };
}

const DedupeKey = struct {
    message_id: []const u8,
    request_id: []const u8,
};

const DedupeContext = struct {
    pub fn hash(_: DedupeContext, key: DedupeKey) u64 {
        var hasher = std.hash.Wyhash.init(0);
        hasher.update(key.message_id);
        hasher.update(&.{0});
        hasher.update(key.request_id);
        return hasher.final();
    }

    pub fn eql(_: DedupeContext, a: DedupeKey, b: DedupeKey) bool {
        return std.mem.eql(u8, a.message_id, b.message_id) and std.mem.eql(u8, a.request_id, b.request_id);
    }
};

fn dedupeEntries(allocator: std.mem.Allocator, entries: *std.array_list.Managed(Entry)) !void {
    var seen = std.HashMap(DedupeKey, usize, DedupeContext, std.hash_map.default_max_load_percentage).init(allocator);
    defer seen.deinit();
    var out = std.array_list.Managed(Entry).init(allocator);
    try seen.ensureTotalCapacity(@intCast(entries.items.len));
    try out.ensureTotalCapacity(entries.items.len);
    for (entries.items) |entry| {
        if (entry.message_id == null or entry.request_id == null) {
            out.appendAssumeCapacity(entry);
            continue;
        }
        const key = DedupeKey{ .message_id = entry.message_id.?, .request_id = entry.request_id.? };
        if (seen.get(key)) |idx| {
            // TypeScript keeps the earliest JSONL occurrence for duplicate message/request pairs.
            if (entryChronologicalLessThan({}, entry, out.items[idx])) out.items[idx] = entry;
            continue;
        }
        seen.putAssumeCapacity(key, out.items.len);
        out.appendAssumeCapacity(entry);
    }
    entries.deinit();
    entries.* = out;
}

fn entryChronologicalLessThan(_: void, a: Entry, b: Entry) bool {
    if (a.file_first_timestamp != b.file_first_timestamp) return a.file_first_timestamp < b.file_first_timestamp;
    if (a.file_index != b.file_index) return a.file_index < b.file_index;
    return a.line_number < b.line_number;
}

fn stringLessThan(_: void, a: []const u8, b: []const u8) bool {
    return std.mem.order(u8, a, b) == .lt;
}

fn isIsoTimestamp(s: []const u8) bool {
    if (s.len != 20 and s.len != 24) return false;
    if (s[4] != '-' or s[7] != '-' or s[10] != 'T' or s[13] != ':' or s[16] != ':') return false;
    if (s.len == 20 and s[19] != 'Z') return false;
    if (s.len == 24 and (s[19] != '.' or s[23] != 'Z')) return false;
    return allDigits(s[0..4]) and allDigits(s[5..7]) and allDigits(s[8..10]) and allDigits(s[11..13]) and allDigits(s[14..16]) and allDigits(s[17..19]) and (s.len == 20 or allDigits(s[20..23]));
}

fn isVersion(s: []const u8) bool {
    var parts: usize = 0;
    var i: usize = 0;
    while (parts < 3) : (parts += 1) {
        const start = i;
        while (i < s.len and s[i] >= '0' and s[i] <= '9') i += 1;
        if (i == start) return false;
        if (parts < 2) {
            if (i >= s.len or s[i] != '.') return false;
            i += 1;
        }
    }
    return true;
}

test "usage line parser accepts current assistant message schema" {
    const line =
        \\{"timestamp":"2026-05-12T01:02:03.456Z","version":"1.2.3","requestId":"req_1","message":{"id":"msg_1","model":"claude-sonnet-4-20250514","usage":{"input_tokens":100,"output_tokens":50,"cache_creation_input_tokens":10,"cache_read_input_tokens":20,"speed":"fast"}},"costUSD":0.05}
    ;
    const parsed = parseUsageLine(line, true, false) orelse return error.TestExpectedEqual;
    try std.testing.expectEqualStrings("2026-05-12T01:02:03.456Z", parsed.timestamp_text);
    try std.testing.expectEqualStrings("1.2.3", parsed.version.?);
    try std.testing.expectEqualStrings("msg_1", parsed.message_id.?);
    try std.testing.expectEqualStrings("req_1", parsed.request_id.?);
    try std.testing.expectEqualStrings("claude-sonnet-4-20250514", parsed.model_raw.?);
    try std.testing.expectEqual(@as(u64, 100), parsed.usage.input_tokens);
    try std.testing.expectEqual(@as(u64, 50), parsed.usage.output_tokens);
    try std.testing.expectEqual(@as(u64, 10), parsed.usage.cache_creation_input_tokens);
    try std.testing.expectEqual(@as(u64, 20), parsed.usage.cache_read_input_tokens);
    try std.testing.expectEqual(true, parsed.usage.speed_fast);
    try std.testing.expectEqual(@as(?f64, 0.05), parsed.cost_usd);
}

test "usage line parser rejects malformed required fields" {
    try std.testing.expectEqual(null, parseUsageLine("{\"message\":{\"usage\":{\"input_tokens\":1,\"output_tokens\":2}}}", false, false));
    try std.testing.expectEqual(null, parseUsageLine("{\"timestamp\":\"not-a-date\",\"message\":{\"usage\":{\"input_tokens\":1,\"output_tokens\":2}}}", false, false));
    try std.testing.expectEqual(null, parseUsageLine("{\"timestamp\":\"2026-05-12T01:02:03Z\",\"message\":{\"usage\":{\"input_tokens\":1,\"output_tokens\":2,\"speed\":\"turbo\"}}}", false, false));
    try std.testing.expectEqual(null, parseUsageLine("{\"timestamp\":\"2026-05-12T01:02:03Z\",\"version\":\"bad\",\"message\":{\"usage\":{\"input_tokens\":1,\"output_tokens\":2}}}", true, false));
    try std.testing.expectEqual(null, parseUsageLine("{\"timestamp\":\"2026-05-12T01:02:03Z\",\"version\":\"unknown\",\"message\":{\"usage\":{\"input_tokens\":1,\"output_tokens\":2}}}", false, false));
}

test "usage line parser handles optional legacy fields" {
    const line =
        \\{"timestamp":"2026-05-12T01:02:03Z","message":{"usage":{"input_tokens":100,"output_tokens":50}}}
    ;
    const parsed = parseUsageLine(line, true, false) orelse return error.TestExpectedEqual;
    try std.testing.expectEqual(null, parsed.version);
    try std.testing.expectEqual(null, parsed.message_id);
    try std.testing.expectEqual(null, parsed.request_id);
    try std.testing.expectEqual(null, parsed.model_raw);
    try std.testing.expectEqual(@as(u64, 0), parsed.usage.cache_creation_input_tokens);
    try std.testing.expectEqual(@as(u64, 0), parsed.usage.cache_read_input_tokens);
    try std.testing.expectEqual(false, parsed.usage.speed_fast);
    try std.testing.expectEqual(null, parsed.cost_usd);
}

test "usage limit reset time is extracted from api error message" {
    const line = "{\"isApiErrorMessage\":true,\"message\":{\"content\":[{\"text\":\"Claude AI usage limit reached|1736337600\"}]}}";
    try std.testing.expectEqual(@as(?i64, 1736337600000), usageLimitResetTime(line));
    try std.testing.expectEqual(@as(?i64, null), usageLimitResetTime("{\"message\":{\"content\":[]}}"));
}

test "model display handling matches data loader behavior" {
    const allocator = std.testing.allocator;
    const normal = try displayModel(allocator, "claude-sonnet-4-20250514", false);
    try std.testing.expectEqualStrings("claude-sonnet-4-20250514", normal.?);

    const fast = try displayModel(allocator, "claude-sonnet-4-20250514", true);
    defer allocator.free(fast.?);
    try std.testing.expectEqualStrings("claude-sonnet-4-20250514-fast", fast.?);

    try std.testing.expectEqual(@as(?[]const u8, null), try displayModel(allocator, "<synthetic>", false));
}

test "project extraction follows Claude projects path semantics" {
    const allocator = std.testing.allocator;
    const project = try extractProject(allocator, "/tmp/claude/projects/-Users-me-app/session-id.jsonl");
    defer allocator.free(project);
    try std.testing.expectEqualStrings("-Users-me-app", project);

    const unknown = try extractProject(allocator, "/tmp/claude/no-projects/session-id.jsonl");
    defer allocator.free(unknown);
    try std.testing.expectEqualStrings("unknown", unknown);
}

test "session path extraction keeps report session and filename session separately" {
    const allocator = std.testing.allocator;
    const parts = try extractSessionParts(allocator, "/tmp/claude/projects/-Users-me-app/conversation-session/file-session.jsonl");
    defer allocator.free(parts.session_id);
    defer allocator.free(parts.file_session_id);
    defer allocator.free(parts.project_path);

    try std.testing.expectEqualStrings("conversation-session", parts.session_id);
    try std.testing.expectEqualStrings("file-session", parts.file_session_id);
    try std.testing.expectEqualStrings("-Users-me-app", parts.project_path);
}

test "dedupe entries keeps earliest message request pair like TypeScript" {
    const allocator = std.testing.allocator;
    var entries = std.array_list.Managed(Entry).init(allocator);
    defer entries.deinit();

    var newer_file_larger = testEntry("msg_1", "req_1", 200, 50, false);
    newer_file_larger.timestamp = 2000;
    newer_file_larger.file_index = 0;
    newer_file_larger.file_first_timestamp = 2000;
    var older_file = testEntry("msg_1", "req_1", 100, 50, false);
    older_file.timestamp = 1000;
    older_file.file_index = 1;
    older_file.file_first_timestamp = 1000;
    var same_file_second_line = testEntry("msg_2", "req_2", 10, 5, false);
    same_file_second_line.timestamp = 3000;
    same_file_second_line.file_first_timestamp = 2500;
    same_file_second_line.line_number = 2;
    var same_file_first_line = testEntry("msg_2", "req_2", 20, 10, false);
    same_file_first_line.timestamp = 4000;
    same_file_first_line.file_first_timestamp = 2500;
    same_file_first_line.line_number = 1;
    var no_message_id = testEntry("msg_3", "req_3", 1, 1, false);
    no_message_id.timestamp = 4000;
    no_message_id.file_first_timestamp = 4000;
    no_message_id.message_id = null;

    try entries.append(newer_file_larger);
    try entries.append(older_file);
    try entries.append(same_file_second_line);
    try entries.append(same_file_first_line);
    try entries.append(no_message_id);

    try dedupeEntries(allocator, &entries);

    try std.testing.expectEqual(@as(usize, 3), entries.items.len);
    try std.testing.expectEqual(@as(u64, 100), entries.items[0].usage.input_tokens);
    try std.testing.expectEqual(@as(u64, 20), entries.items[1].usage.input_tokens);
    try std.testing.expectEqual(null, entries.items[2].message_id);
}

test "loadEntries reads JSONL files with project and date filtering" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var io = std.testing.io;
    var root_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const root = root_buf[0..try tmp.dir.realPath(io, &root_buf)];

    const content =
        \\{"timestamp":"2026-05-12T01:00:00Z","requestId":"req_1","message":{"id":"msg_1","model":"claude-sonnet-4-20250514","usage":{"input_tokens":100,"output_tokens":50}},"costUSD":0.12}
        \\{"timestamp":"2026-05-13T01:00:00Z","requestId":"req_2","message":{"id":"msg_2","model":"claude-sonnet-4-20250514","usage":{"input_tokens":200,"output_tokens":75}},"costUSD":0.34}
    ;
    try writeFixtureFile(&tmp, io, "projects/-Users-me-app/session-a.jsonl", content);

    var env = EnvMap.init(std.testing.allocator);
    defer env.deinit();
    try env.put("CLAUDE_CONFIG_DIR", root);

    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    var pricing = PricingMap.init(allocator);
    var entries = std.array_list.Managed(Entry).init(allocator);
    try loadEntries(allocator, &entries, .{
        .command = .daily,
        .mode = .display,
        .since = "20260513",
        .until = "20260513",
        .project = "-Users-me-app",
    }, &pricing, &io, &env);

    try std.testing.expectEqual(@as(usize, 1), entries.items.len);
    try std.testing.expectEqualStrings("2026-05-13", entries.items[0].date);
    try std.testing.expectEqualStrings("-Users-me-app", entries.items[0].project);
    try std.testing.expectEqual(@as(f64, 0.34), entries.items[0].cost);
}

test "loadEntries session id lookup matches JSONL filename" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var io = std.testing.io;
    var root_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const root = root_buf[0..try tmp.dir.realPath(io, &root_buf)];

    const content =
        \\{"timestamp":"2026-05-12T01:00:00Z","version":"1.2.3","requestId":"req_1","message":{"id":"msg_1","model":"claude-sonnet-4-20250514","usage":{"input_tokens":100,"output_tokens":50}},"costUSD":0.12}
    ;
    try writeFixtureFile(&tmp, io, "projects/-Users-me-app/conversation-session/file-session.jsonl", content);

    var env = EnvMap.init(std.testing.allocator);
    defer env.deinit();
    try env.put("CLAUDE_CONFIG_DIR", root);

    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    var pricing = PricingMap.init(allocator);
    var entries = std.array_list.Managed(Entry).init(allocator);
    try loadEntries(allocator, &entries, .{
        .command = .session,
        .mode = .display,
        .id = "file-session",
    }, &pricing, &io, &env);

    try std.testing.expectEqual(@as(usize, 1), entries.items.len);
    try std.testing.expectEqualStrings("conversation-session", entries.items[0].session_id);
    try std.testing.expectEqualStrings("req_1", entries.items[0].request_id.?);
    try std.testing.expectEqualStrings("-Users-me-app", entries.items[0].project_path);
    try std.testing.expectEqualStrings("1.2.3", entries.items[0].version.?);
}

test "loadEntries cost modes match display auto and calculate semantics" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var io = std.testing.io;
    var root_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const root = root_buf[0..try tmp.dir.realPath(io, &root_buf)];

    const content =
        \\{"timestamp":"2026-05-12T01:00:00Z","requestId":"req_1","message":{"id":"msg_1","model":"test-model","usage":{"input_tokens":100,"output_tokens":50}},"costUSD":99.99}
        \\{"timestamp":"2026-05-12T02:00:00Z","requestId":"req_2","message":{"id":"msg_2","model":"test-model","usage":{"input_tokens":10,"output_tokens":5}}}
    ;
    try writeFixtureFile(&tmp, io, "projects/-Users-me-app/session-a.jsonl", content);

    var env = EnvMap.init(std.testing.allocator);
    defer env.deinit();
    try env.put("CLAUDE_CONFIG_DIR", root);

    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    var pricing = PricingMap.init(allocator);
    try pricing.put("test-model", .{ .input = 1.0, .output = 2.0, .cache_create = 0, .cache_read = 0 });

    const cases = [_]struct {
        mode: shared_args.CostMode,
        first: f64,
        second: f64,
    }{
        .{ .mode = .display, .first = 99.99, .second = 0.0 },
        .{ .mode = .auto, .first = 99.99, .second = 20.0 },
        .{ .mode = .calculate, .first = 200.0, .second = 20.0 },
    };

    for (cases) |case| {
        var entries = std.array_list.Managed(Entry).init(allocator);
        try loadEntries(allocator, &entries, .{ .command = .daily, .mode = case.mode }, &pricing, &io, &env);
        try std.testing.expectEqual(@as(usize, 2), entries.items.len);
        try std.testing.expectApproxEqAbs(case.first, entries.items[0].cost, 0.0000001);
        try std.testing.expectApproxEqAbs(case.second, entries.items[1].cost, 0.0000001);
    }
}

test "loadEntries skips invalid JSONL lines and entries without required fields" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var io = std.testing.io;
    var root_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const root = root_buf[0..try tmp.dir.realPath(io, &root_buf)];

    const content =
        \\not valid json
        \\{"message":{"id":"missing_timestamp","usage":{"input_tokens":100,"output_tokens":50}}}
        \\{"timestamp":"2026-05-12T01:00:00Z","requestId":"req_1","message":{"id":"msg_1","model":"claude-sonnet-4-20250514","usage":{"input_tokens":100,"output_tokens":50}},"costUSD":0.12}
    ;
    try writeFixtureFile(&tmp, io, "projects/-Users-me-app/session-a.jsonl", content);

    var env = EnvMap.init(std.testing.allocator);
    defer env.deinit();
    try env.put("CLAUDE_CONFIG_DIR", root);

    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    var pricing = PricingMap.init(allocator);
    var entries = std.array_list.Managed(Entry).init(allocator);
    try loadEntries(allocator, &entries, .{ .command = .daily, .mode = .display }, &pricing, &io, &env);

    try std.testing.expectEqual(@as(usize, 1), entries.items.len);
    try std.testing.expectEqualStrings("msg_1", entries.items[0].message_id.?);
    try std.testing.expectEqual(@as(f64, 0.12), entries.items[0].cost);
}

test "loadEntries deduplicates using earliest file timestamp order" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var io = std.testing.io;
    var root_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const root = root_buf[0..try tmp.dir.realPath(io, &root_buf)];

    try writeFixtureFile(&tmp, io, "projects/-Users-me-app/a-newer.jsonl",
        \\{"timestamp":"2025-01-15T10:00:00Z","requestId":"req_456","message":{"id":"msg_123","model":"claude-sonnet-4-20250514","usage":{"input_tokens":200,"output_tokens":100}},"costUSD":0.002}
    );
    try writeFixtureFile(&tmp, io, "projects/-Users-me-app/z-older.jsonl",
        \\{"timestamp":"2025-01-10T10:00:00Z","requestId":"req_456","message":{"id":"msg_123","model":"claude-sonnet-4-20250514","usage":{"input_tokens":100,"output_tokens":50}},"costUSD":0.001}
    );

    var env = EnvMap.init(std.testing.allocator);
    defer env.deinit();
    try env.put("CLAUDE_CONFIG_DIR", root);

    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    var pricing = PricingMap.init(allocator);
    var entries = std.array_list.Managed(Entry).init(allocator);
    try loadEntries(allocator, &entries, .{ .command = .daily, .mode = .display }, &pricing, &io, &env);

    try std.testing.expectEqual(@as(usize, 1), entries.items.len);
    try std.testing.expectEqualStrings("2025-01-10", entries.items[0].date);
    try std.testing.expectEqual(@as(u64, 100), entries.items[0].usage.input_tokens);
    try std.testing.expectEqual(@as(u64, 50), entries.items[0].usage.output_tokens);
    try std.testing.expectEqual(@as(f64, 0.001), entries.items[0].cost);
}

test "loadEntries aggregates multiple Claude config paths and filters by project" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var io = std.testing.io;

    try writeFixtureFile(&tmp, io, "claude-a/projects/-Users-a/session-a.jsonl",
        \\{"timestamp":"2026-05-12T01:00:00Z","requestId":"req_a","message":{"id":"msg_a","model":"claude-sonnet-4-20250514","usage":{"input_tokens":10,"output_tokens":5}},"costUSD":0.10}
    );
    try writeFixtureFile(&tmp, io, "claude-b/projects/-Users-b/session-b.jsonl",
        \\{"timestamp":"2026-05-13T01:00:00Z","requestId":"req_b","message":{"id":"msg_b","model":"claude-sonnet-4-20250514","usage":{"input_tokens":20,"output_tokens":10}},"costUSD":0.20}
    );

    var root_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const tmp_root = root_buf[0..try tmp.dir.realPath(io, &root_buf)];
    const root_a = try std.fs.path.join(std.testing.allocator, &.{ tmp_root, "claude-a" });
    defer std.testing.allocator.free(root_a);
    const root_b = try std.fs.path.join(std.testing.allocator, &.{ tmp_root, "claude-b" });
    defer std.testing.allocator.free(root_b);
    const missing_root = try std.fs.path.join(std.testing.allocator, &.{ tmp_root, "missing" });
    defer std.testing.allocator.free(missing_root);
    const env_paths = try std.fmt.allocPrint(std.testing.allocator, "{s},{s},{s}", .{ missing_root, root_a, root_b });
    defer std.testing.allocator.free(env_paths);

    var env = EnvMap.init(std.testing.allocator);
    defer env.deinit();
    try env.put("CLAUDE_CONFIG_DIR", env_paths);

    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    var pricing = PricingMap.init(allocator);
    var all_entries = std.array_list.Managed(Entry).init(allocator);
    try loadEntries(allocator, &all_entries, .{ .command = .daily, .mode = .display }, &pricing, &io, &env);
    try std.testing.expectEqual(@as(usize, 2), all_entries.items.len);

    var filtered_entries = std.array_list.Managed(Entry).init(allocator);
    try loadEntries(allocator, &filtered_entries, .{ .command = .daily, .mode = .display, .project = "-Users-b" }, &pricing, &io, &env);
    try std.testing.expectEqual(@as(usize, 1), filtered_entries.items.len);
    try std.testing.expectEqualStrings("-Users-b", filtered_entries.items[0].project);
    try std.testing.expectEqualStrings("msg_b", filtered_entries.items[0].message_id.?);
    try std.testing.expectEqual(@as(f64, 0.20), filtered_entries.items[0].cost);
}

fn writeFixtureFile(tmp: *std.testing.TmpDir, io: std.Io, sub_path: []const u8, content: []const u8) !void {
    const dir_name = std.fs.path.dirname(sub_path) orelse ".";
    try tmp.dir.createDirPath(io, dir_name);
    try tmp.dir.writeFile(io, .{ .sub_path = sub_path, .data = content });
}

fn testEntry(message_id: []const u8, request_id: []const u8, input_tokens: u64, output_tokens: u64, fast: bool) Entry {
    return .{
        .timestamp = 0,
        .timestamp_text = "2026-05-12T01:02:03Z",
        .date = "2026-05-12",
        .session_id = "session",
        .project = "project",
        .project_path = "project",
        .version = null,
        .message_id = message_id,
        .request_id = request_id,
        .model = "claude-sonnet-4-20250514",
        .usage = .{
            .input_tokens = input_tokens,
            .output_tokens = output_tokens,
            .cache_creation_input_tokens = 0,
            .cache_read_input_tokens = 0,
            .speed_fast = fast,
        },
        .cost_usd = null,
        .cost = 0,
        .is_api_error = false,
        .reset_time = null,
        .file_index = 0,
        .file_first_timestamp = 0,
        .line_number = 0,
    };
}
