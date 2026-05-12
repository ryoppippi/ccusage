const std = @import("std");

pub fn formatProjectName(project: []const u8, aliases: ?[]const u8, buf: []u8) []const u8 {
    if (aliasForProject(project, aliases)) |alias| return alias;
    const parsed = parseProjectName(project, buf);
    if (aliasForProject(parsed, aliases)) |alias| return alias;
    return parsed;
}

pub fn projectHeaderLabel(project: []const u8, buf: []u8) []const u8 {
    return std.fmt.bufPrint(buf, "Project: {s}", .{project}) catch "Project:";
}

fn aliasForProject(project: []const u8, aliases: ?[]const u8) ?[]const u8 {
    const raw_aliases = aliases orelse return null;
    var pairs = std.mem.splitScalar(u8, raw_aliases, ',');
    while (pairs.next()) |raw_pair| {
        const pair = std.mem.trim(u8, raw_pair, " \t\r\n");
        const eq = std.mem.indexOfScalar(u8, pair, '=') orelse continue;
        const key = std.mem.trim(u8, pair[0..eq], " \t\r\n");
        const value = std.mem.trim(u8, pair[eq + 1 ..], " \t\r\n");
        if (key.len > 0 and value.len > 0 and std.mem.eql(u8, key, project)) return value;
    }
    return null;
}

fn parseProjectName(project: []const u8, buf: []u8) []const u8 {
    if (project.len == 0 or std.mem.eql(u8, project, "unknown")) return "Unknown Project";

    var cleaned = project;
    var path_cleaned = false;
    var scratch: [1024]u8 = undefined;

    if (windowsUserPath(cleaned)) {
        if (afterUserPrefix(cleaned, '\\', &scratch)) |tail| {
            cleaned = tail;
            path_cleaned = true;
        }
    }

    if (std.mem.startsWith(u8, cleaned, "-Users-")) {
        if (afterUserPrefix(cleaned, '-', &scratch)) |tail| {
            cleaned = tail;
            path_cleaned = true;
        }
    } else if (std.mem.startsWith(u8, cleaned, "/Users/")) {
        if (afterUserPrefix(cleaned, '/', &scratch)) |tail| {
            cleaned = tail;
            path_cleaned = true;
        }
    }

    if (!path_cleaned) {
        cleaned = trimProjectDelimiters(cleaned);
    }

    if (uuidPrefix(cleaned)) {
        return lastDashParts(cleaned, 2, buf) orelse cleaned;
    }

    if (std.mem.indexOf(u8, cleaned, "--")) |idx| {
        cleaned = cleaned[0..idx];
    }

    if (std.mem.indexOfScalar(u8, cleaned, '-') != null and cleaned.len > 20) {
        if (meaningfulTail(cleaned, buf)) |tail| cleaned = tail;
    }

    cleaned = trimProjectDelimiters(cleaned);
    if (cleaned.len > 0) {
        if (pointsInto(cleaned, &scratch)) return copyToBuf(cleaned, buf) orelse project;
        return cleaned;
    }
    if (project.len > 0) return project;
    return "Unknown Project";
}

fn afterUserPrefix(path: []const u8, separator: u8, buf: []u8) ?[]const u8 {
    var user_index: ?usize = null;
    var segment_index: usize = 0;
    var tail_start: ?usize = null;
    var it = std.mem.splitScalar(u8, path, separator);
    while (it.next()) |segment| {
        if (segment.len == 0) continue;
        if (user_index == null and std.mem.eql(u8, segment, "Users")) {
            user_index = segment_index;
        } else if (user_index) |idx| {
            if (segment_index == idx + 3) {
                tail_start = @intFromPtr(segment.ptr) - @intFromPtr(path.ptr);
                break;
            }
        }
        segment_index += 1;
    }
    const start = tail_start orelse return null;
    return joinDelimiters(path[start..], separator, '-', buf);
}

fn joinDelimiters(text: []const u8, from: u8, to: u8, buf: []u8) ?[]const u8 {
    if (from == to) return text;
    var needs_join = false;
    for (text) |ch| {
        if (ch == from) {
            needs_join = true;
            break;
        }
    }
    if (!needs_join) return text;
    if (text.len > buf.len) return null;
    for (text, 0..) |ch, idx| {
        buf[idx] = if (ch == from) to else ch;
    }
    return buf[0..text.len];
}

fn windowsUserPath(path: []const u8) bool {
    return (path.len >= 9 and std.ascii.isAlphabetic(path[0]) and path[1] == ':' and path[2] == '\\' and std.mem.startsWith(u8, path[3..], "Users\\")) or std.mem.startsWith(u8, path, "\\Users\\");
}

fn trimProjectDelimiters(text: []const u8) []const u8 {
    return std.mem.trim(u8, text, "/\\-");
}

fn uuidPrefix(text: []const u8) bool {
    const groups = [_]usize{ 8, 4, 4, 4, 12 };
    var pos: usize = 0;
    for (groups, 0..) |len, idx| {
        if (text.len < pos + len) return false;
        for (text[pos .. pos + len]) |ch| {
            if (!std.ascii.isHex(ch)) return false;
        }
        pos += len;
        if (idx < groups.len - 1) {
            if (text.len <= pos or text[pos] != '-') return false;
            pos += 1;
        }
    }
    return true;
}

fn lastDashParts(text: []const u8, count: usize, buf: []u8) ?[]const u8 {
    var starts: [16]usize = undefined;
    var lens: [16]usize = undefined;
    var total: usize = 0;
    var it = std.mem.splitScalar(u8, text, '-');
    while (it.next()) |segment| {
        if (segment.len == 0) continue;
        if (total >= starts.len) break;
        starts[total] = @intFromPtr(segment.ptr) - @intFromPtr(text.ptr);
        lens[total] = segment.len;
        total += 1;
    }
    if (total < count) return null;
    return joinSegments(text, starts[total - count .. total], lens[total - count .. total], buf);
}

fn meaningfulTail(text: []const u8, buf: []u8) ?[]const u8 {
    var starts: [32]usize = undefined;
    var lens: [32]usize = undefined;
    var total: usize = 0;
    var it = std.mem.splitScalar(u8, text, '-');
    while (it.next()) |segment| {
        if (segment.len <= 2 or noisySegment(segment)) continue;
        if (total >= starts.len) break;
        starts[total] = @intFromPtr(segment.ptr) - @intFromPtr(text.ptr);
        lens[total] = segment.len;
        total += 1;
    }
    if (total >= 2) {
        if (joinSegments(text, starts[total - 2 .. total], lens[total - 2 .. total], buf)) |tail| {
            if (tail.len >= 6) return tail;
        }
    }
    if (total >= 3) return joinSegments(text, starts[total - 3 .. total], lens[total - 3 .. total], buf);
    return null;
}

fn noisySegment(segment: []const u8) bool {
    const words = [_][]const u8{ "dev", "development", "feat", "feature", "fix", "bug", "test", "staging", "prod", "production", "main", "master", "branch" };
    for (words) |word| {
        if (std.ascii.eqlIgnoreCase(segment, word)) return true;
    }
    return false;
}

fn joinSegments(text: []const u8, starts: []const usize, lens: []const usize, buf: []u8) ?[]const u8 {
    var needed: usize = 0;
    for (lens, 0..) |len, idx| needed += len + if (idx == 0) @as(usize, 0) else 1;
    if (needed > buf.len) return null;
    var pos: usize = 0;
    for (starts, lens, 0..) |start, len, idx| {
        if (idx > 0) {
            buf[pos] = '-';
            pos += 1;
        }
        @memcpy(buf[pos .. pos + len], text[start .. start + len]);
        pos += len;
    }
    return buf[0..pos];
}

fn pointsInto(text: []const u8, buf: []const u8) bool {
    const ptr = @intFromPtr(text.ptr);
    const start = @intFromPtr(buf.ptr);
    return ptr >= start and ptr < start + buf.len;
}

fn copyToBuf(text: []const u8, buf: []u8) ?[]const u8 {
    if (text.len > buf.len) return null;
    @memcpy(buf[0..text.len], text);
    return buf[0..text.len];
}

test "project name aliases match daily table behavior" {
    var buf: [128]u8 = undefined;
    try std.testing.expectEqualStrings("Project A", formatProjectName("project-a", "project-a=Project A", &buf));
    try std.testing.expectEqualStrings("Unknown Project", formatProjectName("unknown", null, &buf));
    try std.testing.expectEqualStrings("Unknown Project", formatProjectName("", null, &buf));
    try std.testing.expectEqualStrings("ccusage", formatProjectName("/Users/phaedrus/Development/ccusage", null, &buf));
    try std.testing.expectEqualStrings("ccusage", formatProjectName("-Users-phaedrus-Development-ccusage", null, &buf));
    try std.testing.expectEqualStrings("configure-dependabot", formatProjectName("-Users-phaedrus-Development-adminifi-edugakko-api--feature-ticket-002-configure-dependabot", null, &buf));
    try std.testing.expectEqualStrings("8f59-b0026409ec09.jsonl", formatProjectName("a2cd99ed-a586-4fe4-8f59-b0026409ec09.jsonl", null, &buf));
    try std.testing.expectEqualStrings("simple-project", formatProjectName("simple-project", null, &buf));
    try std.testing.expectEqualStrings("project", formatProjectName("project", null, &buf));
    try std.testing.expectEqualStrings("Usage Tracker", formatProjectName("-Users-phaedrus-Development-ccusage", "ccusage=Usage Tracker", &buf));
    try std.testing.expectEqualStrings("Usage Tracker", formatProjectName("ccusage", "ccusage=Usage Tracker,test=Test Project", &buf));
    try std.testing.expectEqualStrings("Test Project", formatProjectName("test", "ccusage=Usage Tracker,test=Test Project", &buf));
    try std.testing.expectEqualStrings("other", formatProjectName("other", "ccusage=Usage Tracker,test=Test Project", &buf));
}
