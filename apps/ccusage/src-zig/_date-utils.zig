const std = @import("std");

pub const WeekDay = enum {
    sunday,
    monday,
    tuesday,
    wednesday,
    thursday,
    friday,
    saturday,
};

pub fn dateInRange(date: []const u8, since: ?[]const u8, until: ?[]const u8) bool {
    var compact_buf: [8]u8 = undefined;
    if (date.len < 10) return false;
    @memcpy(compact_buf[0..4], date[0..4]);
    @memcpy(compact_buf[4..6], date[5..7]);
    @memcpy(compact_buf[6..8], date[8..10]);
    const compact = compact_buf[0..8];
    if (since) |s| if (std.mem.order(u8, compact, s) == .lt) return false;
    if (until) |u| if (std.mem.order(u8, compact, u) == .gt) return false;
    return true;
}

pub fn weekStart(allocator: std.mem.Allocator, date: []const u8, start: WeekDay) ![]const u8 {
    if (date.len < 10) return allocator.dupe(u8, date);
    const y = try std.fmt.parseInt(i32, date[0..4], 10);
    const m = try std.fmt.parseInt(u8, date[5..7], 10);
    const d = try std.fmt.parseInt(u8, date[8..10], 10);
    const z = daysFromCivil(y, m, d);
    const dow_sunday = @mod(z + 4, 7);
    const start_num: i64 = @intFromEnum(start);
    const shift = @mod(dow_sunday - start_num + 7, 7);
    return formatDateAlloc(allocator, (z - shift) * 86_400_000);
}

pub fn parseTimestamp(s: []const u8) ?i64 {
    if (s.len < 20) return null;
    const y: i32 = @intCast(parseFixedDigits(s[0..4]) orelse return null);
    const mo: u8 = @intCast(parseFixedDigits(s[5..7]) orelse return null);
    const d: u8 = @intCast(parseFixedDigits(s[8..10]) orelse return null);
    const h: u8 = @intCast(parseFixedDigits(s[11..13]) orelse return null);
    const mi: u8 = @intCast(parseFixedDigits(s[14..16]) orelse return null);
    const sec: u8 = @intCast(parseFixedDigits(s[17..19]) orelse return null);
    var ms: i64 = 0;
    if (s.len >= 24 and s[19] == '.') ms = @intCast(parseFixedDigits(s[20..23]) orelse 0);
    const days = daysFromCivil(y, mo, d);
    return (((days * 24 + h) * 60 + mi) * 60 + sec) * 1000 + ms;
}

fn parseFixedDigits(bytes: []const u8) ?u64 {
    var value: u64 = 0;
    for (bytes) |ch| {
        if (ch < '0' or ch > '9') return null;
        value = value * 10 + ch - '0';
    }
    return value;
}

pub fn floorHour(ms: i64) i64 {
    const hour = 60 * 60 * 1000;
    return @divFloor(ms, hour) * hour;
}

fn daysFromCivil(y_raw: i32, m_raw: u8, d_raw: u8) i64 {
    var y: i64 = y_raw;
    const m: i64 = m_raw;
    const d: i64 = d_raw;
    y -= if (m <= 2) 1 else 0;
    const era = @divFloor(y, 400);
    const yoe = y - era * 400;
    const mp = m + if (m > 2) @as(i64, -3) else @as(i64, 9);
    const doy = @divFloor(153 * mp + 2, 5) + d - 1;
    const doe = yoe * 365 + @divFloor(yoe, 4) - @divFloor(yoe, 100) + doy;
    return era * 146097 + doe - 719468;
}

fn civilFromDays(z_raw: i64) struct { y: i64, m: i64, d: i64 } {
    const z = z_raw + 719468;
    const era = @divFloor(z, 146097);
    const doe = z - era * 146097;
    const yoe = @divFloor(doe - @divFloor(doe, 1460) + @divFloor(doe, 36524) - @divFloor(doe, 146096), 365);
    var y = yoe + era * 400;
    const doy = doe - (365 * yoe + @divFloor(yoe, 4) - @divFloor(yoe, 100));
    const mp = @divFloor(5 * doy + 2, 153);
    const d = doy - @divFloor(153 * mp + 2, 5) + 1;
    const m = mp + if (mp < 10) @as(i64, 3) else @as(i64, -9);
    y += if (m <= 2) 1 else 0;
    return .{ .y = y, .m = m, .d = d };
}

pub fn formatDateAlloc(allocator: std.mem.Allocator, ms: i64) ![]const u8 {
    var buf: [32]u8 = undefined;
    return allocator.dupe(u8, try formatDateBuf(ms, &buf));
}

pub fn formatDateForTimezone(allocator: std.mem.Allocator, ms: i64, timezone: ?[]const u8) ![]const u8 {
    return formatDateAlloc(allocator, ms + timezoneOffsetMillis(ms, timezone));
}

pub fn timezoneOffsetMillis(ms: i64, timezone: ?[]const u8) i64 {
    if (timezone) |tz| {
        if (std.mem.eql(u8, tz, "UTC")) return 0;
        if (!std.mem.eql(u8, tz, "Europe/London")) return 0;
    }
    return londonOffsetMillis(ms);
}

fn londonOffsetMillis(ms: i64) i64 {
    const days = @divFloor(ms, 86_400_000);
    const c = civilFromDays(days);
    const start = londonDstTransition(c.y, 3);
    const end = londonDstTransition(c.y, 10);
    return if (ms >= start and ms < end) 3_600_000 else 0;
}

fn londonDstTransition(year: i64, month: u8) i64 {
    const last_day: u8 = 31;
    const last_day_index = daysFromCivil(@intCast(year), month, last_day);
    const dow_sunday = @mod(last_day_index + 4, 7);
    const last_sunday = @as(i64, last_day) - dow_sunday;
    return (daysFromCivil(@intCast(year), month, @intCast(last_sunday)) * 24 + 1) * 60 * 60 * 1000;
}

pub fn formatDateBuf(ms: i64, buf: []u8) ![]const u8 {
    const days = @divFloor(ms, 86_400_000);
    const c = civilFromDays(days);
    return std.fmt.bufPrint(buf, "{d:0>4}-{d:0>2}-{d:0>2}", .{
        @as(u64, @intCast(c.y)),
        @as(u64, @intCast(c.m)),
        @as(u64, @intCast(c.d)),
    });
}

pub fn formatIso(allocator: std.mem.Allocator, ms: i64) ![]const u8 {
    var buf: [40]u8 = undefined;
    return allocator.dupe(u8, try formatIsoBuf(ms, &buf));
}

pub fn formatIsoBuf(ms: i64, buf: []u8) ![]const u8 {
    const days = @divFloor(ms, 86_400_000);
    const rem = @mod(ms, 86_400_000);
    const c = civilFromDays(days);
    const h = @divFloor(rem, 3_600_000);
    const m = @divFloor(@mod(rem, 3_600_000), 60_000);
    const s = @divFloor(@mod(rem, 60_000), 1000);
    const milli = @mod(rem, 1000);
    return std.fmt.bufPrint(buf, "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}.{d:0>3}Z", .{
        @as(u64, @intCast(c.y)),
        @as(u64, @intCast(c.m)),
        @as(u64, @intCast(c.d)),
        @as(u64, @intCast(h)),
        @as(u64, @intCast(m)),
        @as(u64, @intCast(s)),
        @as(u64, @intCast(milli)),
    });
}

test "date range filtering matches TypeScript date utility cases" {
    try std.testing.expect(dateInRange("2024-01-03", null, null));
    try std.testing.expect(!dateInRange("2024-01-02", "20240103", null));
    try std.testing.expect(dateInRange("2024-01-03", "20240103", null));
    try std.testing.expect(dateInRange("2024-01-03", null, "20240103"));
    try std.testing.expect(!dateInRange("2024-01-04", null, "20240103"));
    try std.testing.expect(dateInRange("2024-01-03T10:00:00Z", "20240102", "20240104"));
    try std.testing.expect(!dateInRange("bad", "20240102", null));
}

test "week start" {
    const allocator = std.testing.allocator;
    const sunday = try weekStart(allocator, "2024-01-03", .sunday);
    defer allocator.free(sunday);
    try std.testing.expectEqualStrings("2023-12-31", sunday);
    const monday = try weekStart(allocator, "2024-01-03", .monday);
    defer allocator.free(monday);
    try std.testing.expectEqualStrings("2024-01-01", monday);
    const already_monday = try weekStart(allocator, "2024-01-01", .monday);
    defer allocator.free(already_monday);
    try std.testing.expectEqualStrings("2024-01-01", already_monday);
    const already_sunday = try weekStart(allocator, "2023-12-31", .sunday);
    defer allocator.free(already_sunday);
    try std.testing.expectEqualStrings("2023-12-31", already_sunday);
}

test "weekday enum values match TypeScript getDayNumber" {
    try std.testing.expectEqual(@as(u3, 0), @intFromEnum(WeekDay.sunday));
    try std.testing.expectEqual(@as(u3, 1), @intFromEnum(WeekDay.monday));
    try std.testing.expectEqual(@as(u3, 2), @intFromEnum(WeekDay.tuesday));
    try std.testing.expectEqual(@as(u3, 3), @intFromEnum(WeekDay.wednesday));
    try std.testing.expectEqual(@as(u3, 4), @intFromEnum(WeekDay.thursday));
    try std.testing.expectEqual(@as(u3, 5), @intFromEnum(WeekDay.friday));
    try std.testing.expectEqual(@as(u3, 6), @intFromEnum(WeekDay.saturday));
}

test "formatDateForTimezone handles UTC and Europe/London offsets" {
    const allocator = std.testing.allocator;
    const noon_utc = parseTimestamp("2024-08-04T12:00:00Z") orelse return error.ParseFailed;
    const utc = try formatDateForTimezone(allocator, noon_utc, "UTC");
    defer allocator.free(utc);
    try std.testing.expectEqualStrings("2024-08-04", utc);

    const before_london_midnight = parseTimestamp("2024-08-03T23:30:00Z") orelse return error.ParseFailed;
    const london = try formatDateForTimezone(allocator, before_london_midnight, "Europe/London");
    defer allocator.free(london);
    try std.testing.expectEqualStrings("2024-08-04", london);
}

test "timestamp formatting round-trips UTC dates" {
    const timestamp = parseTimestamp("2024-08-04T12:34:56.789Z") orelse return error.ParseFailed;
    try std.testing.expectEqual(@as(i64, 1722774896789), timestamp);
    var date_buf: [32]u8 = undefined;
    try std.testing.expectEqualStrings("2024-08-04", try formatDateBuf(timestamp, &date_buf));
    var iso_buf: [40]u8 = undefined;
    try std.testing.expectEqualStrings("2024-08-04T12:34:56.789Z", try formatIsoBuf(timestamp, &iso_buf));
    try std.testing.expectEqual(@as(?i64, null), parseTimestamp("not-a-date"));
}

test "floorHour matches session block start rounding" {
    const timestamp = parseTimestamp("2024-01-01T10:55:30.123Z") orelse return error.ParseFailed;
    const expected = parseTimestamp("2024-01-01T10:00:00Z") orelse return error.ParseFailed;
    try std.testing.expectEqual(expected, floorHour(timestamp));
}
