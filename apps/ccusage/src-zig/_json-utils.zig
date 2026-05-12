const std = @import("std");

pub fn jsonObjectField(json: []const u8, key: []const u8) ?[]const u8 {
    const value = jsonFieldValue(json, key) orelse return null;
    return if (value.len > 0 and value[0] == '{') value else null;
}

pub fn jsonObjectFieldLast(json: []const u8, key: []const u8) ?[]const u8 {
    const key_index = std.mem.lastIndexOf(u8, json, key) orelse return null;
    var i = key_index + key.len;
    while (i < json.len and isJsonSpace(json[i])) i += 1;
    if (i >= json.len or json[i] != ':') return null;
    i += 1;
    while (i < json.len and isJsonSpace(json[i])) i += 1;
    if (i >= json.len or json[i] != '{') return null;
    return jsonBalancedSlice(json, i, '{', '}');
}

pub fn jsonStringField(json: []const u8, key: []const u8) ?[]const u8 {
    const value = jsonFieldValue(json, key) orelse return null;
    if (value.len < 2 or value[0] != '"') return null;
    return value[1 .. value.len - 1];
}

pub fn jsonStringFieldLast(json: []const u8, key: []const u8) ?[]const u8 {
    const key_index = std.mem.lastIndexOf(u8, json, key) orelse return null;
    var i = key_index + key.len;
    while (i < json.len and isJsonSpace(json[i])) i += 1;
    if (i >= json.len or json[i] != ':') return null;
    i += 1;
    while (i < json.len and isJsonSpace(json[i])) i += 1;
    if (i >= json.len or json[i] != '"') return null;
    const end = jsonStringEnd(json, i) orelse return null;
    return json[i + 1 .. end];
}

pub fn jsonU64Field(json: []const u8, key: []const u8) ?u64 {
    const value = jsonFieldValue(json, key) orelse return null;
    if (value.len == 0 or value[0] == '-') return null;
    var total: u64 = 0;
    var saw_digit = false;
    for (value) |ch| {
        if (ch < '0' or ch > '9') break;
        saw_digit = true;
        total = std.math.mul(u64, total, 10) catch return null;
        total = std.math.add(u64, total, ch - '0') catch return null;
    }
    return if (saw_digit) total else null;
}

pub fn jsonF64Field(json: []const u8, key: []const u8) ?f64 {
    const value = jsonFieldValue(json, key) orelse return null;
    if (value.len == 0) return null;
    return std.fmt.parseFloat(f64, value) catch null;
}

pub fn jsonBoolField(json: []const u8, key: []const u8) ?bool {
    const value = jsonFieldValue(json, key) orelse return null;
    if (std.mem.startsWith(u8, value, "true")) return true;
    if (std.mem.startsWith(u8, value, "false")) return false;
    return null;
}

pub fn indexOfNeedle(haystack: []const u8, needle: []const u8) ?usize {
    if (needle.len == 0) return 0;
    if (needle.len > haystack.len) return null;
    const vector_len = comptime std.simd.suggestVectorLength(u8) orelse 16;
    const Vec = @Vector(vector_len, u8);
    const first: Vec = @splat(needle[0]);
    var i: usize = 0;
    while (i + vector_len <= haystack.len) : (i += vector_len) {
        const chunk: Vec = @as(Vec, haystack[i..][0..vector_len].*);
        const matches = chunk == first;
        if (@reduce(.Or, matches)) {
            comptime var j: usize = 0;
            inline while (j < vector_len) : (j += 1) {
                if (matches[j]) {
                    const candidate = i + j;
                    if (candidate + needle.len <= haystack.len and std.mem.eql(u8, haystack[candidate .. candidate + needle.len], needle)) return candidate;
                }
            }
        }
    }
    while (i + needle.len <= haystack.len) : (i += 1) {
        if (haystack[i] == needle[0] and std.mem.eql(u8, haystack[i .. i + needle.len], needle)) return i;
    }
    return null;
}

fn jsonFieldValue(json: []const u8, key: []const u8) ?[]const u8 {
    if (json.len < 2 or json[0] != '{') return null;
    var i: usize = 1;
    while (i < json.len) {
        while (i < json.len and (isJsonSpace(json[i]) or json[i] == ',')) i += 1;
        if (i >= json.len or json[i] == '}') return null;
        if (json[i] != '"') return null;
        const key_start = i;
        const key_end = jsonStringEnd(json, i) orelse return null;
        i = key_end + 1;
        while (i < json.len and isJsonSpace(json[i])) i += 1;
        if (i >= json.len or json[i] != ':') return null;
        i += 1;
        while (i < json.len and isJsonSpace(json[i])) i += 1;
        const value = jsonValueSlice(json, i) orelse return null;
        if (std.mem.eql(u8, json[key_start .. key_end + 1], key)) return value;
        i = @intFromPtr(value.ptr) - @intFromPtr(json.ptr) + value.len;
    }
    return null;
}

fn jsonValueSlice(json: []const u8, start: usize) ?[]const u8 {
    if (start >= json.len) return null;
    return switch (json[start]) {
        '"' => if (jsonStringEnd(json, start)) |end| json[start .. end + 1] else null,
        '{' => jsonBalancedSlice(json, start, '{', '}'),
        '[' => jsonBalancedSlice(json, start, '[', ']'),
        else => {
            var end = start;
            while (end < json.len and json[end] != ',' and json[end] != '}' and json[end] != ']') end += 1;
            return std.mem.trim(u8, json[start..end], " \t\r\n");
        },
    };
}

fn jsonStringEnd(json: []const u8, start: usize) ?usize {
    if (start >= json.len or json[start] != '"') return null;
    var i = start + 1;
    var escaped = false;
    while (i < json.len) : (i += 1) {
        const ch = json[i];
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

fn jsonBalancedSlice(json: []const u8, start: usize, open: u8, close: u8) ?[]const u8 {
    if (start >= json.len or json[start] != open) return null;
    var depth: usize = 0;
    var i = start;
    while (i < json.len) : (i += 1) {
        const ch = json[i];
        if (ch == '"') {
            i = jsonStringEnd(json, i) orelse return null;
            continue;
        }
        if (ch == open) depth += 1;
        if (ch == close) {
            depth -= 1;
            if (depth == 0) return json[start .. i + 1];
        }
    }
    return null;
}

fn isJsonSpace(ch: u8) bool {
    return ch == ' ' or ch == '\t' or ch == '\r' or ch == '\n';
}

test "json field helpers read nested values without full parsing" {
    const line =
        \\{"timestamp":"2026-05-12T01:02:03Z","message":{"id":"msg_1","usage":{"input_tokens":123,"output_tokens":45,"cache_creation_input_tokens":6,"cache_read_input_tokens":7,"speed":"fast"},"model":"claude-sonnet-4-20250514"},"costUSD":0.125,"isApiErrorMessage":false}
    ;
    const message = jsonObjectField(line, "\"message\"") orelse return error.TestExpectedEqual;
    const usage = jsonObjectField(message, "\"usage\"") orelse return error.TestExpectedEqual;
    try std.testing.expectEqualStrings("2026-05-12T01:02:03Z", jsonStringField(line, "\"timestamp\"").?);
    try std.testing.expectEqualStrings("msg_1", jsonStringField(message, "\"id\"").?);
    try std.testing.expectEqual(@as(u64, 123), jsonU64Field(usage, "\"input_tokens\"").?);
    try std.testing.expectEqual(@as(u64, 7), jsonU64Field(usage, "\"cache_read_input_tokens\"").?);
    try std.testing.expectEqual(@as(f64, 0.125), jsonF64Field(line, "\"costUSD\"").?);
    try std.testing.expectEqual(false, jsonBoolField(line, "\"isApiErrorMessage\"").?);
}

test "json field helpers skip escaped strings and arrays" {
    const line =
        \\{"unused":"contains \"target\" text","items":[{"target":"nope"}],"target":{"nested":"yes"},"after":true}
    ;
    const target = jsonObjectField(line, "\"target\"") orelse return error.TestExpectedEqual;
    try std.testing.expectEqualStrings("{\"nested\":\"yes\"}", target);
    try std.testing.expectEqual(true, jsonBoolField(line, "\"after\"").?);
}

test "json object field last reads tail object values" {
    const line =
        \\{"usage":{"input_tokens":0},"message":{"content":[{"text":"{\"usage\":{\"input_tokens\":999}}"}]},"usage":{"input_tokens":1,"output_tokens":2}}
    ;
    const usage = jsonObjectFieldLast(line, "\"usage\"") orelse return error.TestExpectedEqual;
    try std.testing.expectEqualStrings("{\"input_tokens\":1,\"output_tokens\":2}", usage);
}

test "json string field last reads tail string values" {
    const line =
        \\{"timestamp":"2026-01-01T00:00:00Z","message":{"content":[{"text":"{\"timestamp\":\"not top level\"}"}]},"requestId":"req_1","timestamp":"2026-05-12T01:02:03Z"}
    ;
    try std.testing.expectEqualStrings("2026-05-12T01:02:03Z", jsonStringFieldLast(line, "\"timestamp\"").?);
    try std.testing.expectEqualStrings("req_1", jsonStringFieldLast(line, "\"requestId\"").?);
    try std.testing.expectEqual(null, jsonStringFieldLast(line, "\"missing\""));
}

test "json numeric helpers reject invalid unsigned integers" {
    try std.testing.expectEqual(null, jsonU64Field("{\"n\":-1}", "\"n\""));
    try std.testing.expectEqual(null, jsonU64Field("{\"n\":\"12\"}", "\"n\""));
    try std.testing.expectEqual(@as(u64, 12), jsonU64Field("{\"n\":12.5}", "\"n\"").?);
}

test "indexOfNeedle finds SIMD and tail matches" {
    try std.testing.expectEqual(@as(?usize, 0), indexOfNeedle("abcdef", ""));
    try std.testing.expectEqual(@as(?usize, 2), indexOfNeedle("abcdef", "cd"));
    try std.testing.expectEqual(@as(?usize, 18), indexOfNeedle("aaaaaaaaaaaaaaaaaabc", "bc"));
    try std.testing.expectEqual(@as(?usize, null), indexOfNeedle("abcdef", "gh"));
}
