const std = @import("std");

pub fn formatNumber(value: u64, buf: []u8) []const u8 {
    var tmp: [32]u8 = undefined;
    const raw = std.fmt.bufPrint(&tmp, "{}", .{value}) catch return "";
    var out_i: usize = buf.len;
    var count: usize = 0;
    var i = raw.len;
    while (i > 0 and out_i > 0) {
        if (count == 3) {
            out_i -= 1;
            buf[out_i] = ',';
            count = 0;
        }
        i -= 1;
        out_i -= 1;
        buf[out_i] = raw[i];
        count += 1;
    }
    return buf[out_i..];
}

pub fn formatCurrency(value: f64, buf: []u8) []const u8 {
    return std.fmt.bufPrint(buf, "${d:.2}", .{value}) catch "";
}

pub fn joinModels(models: []const []const u8, buf: []u8) []const u8 {
    if (models.len == 0) return "-";
    var pos: usize = 0;
    for (models, 0..) |model, idx| {
        if (idx > 0 and pos + 2 < buf.len) {
            buf[pos] = ',';
            buf[pos + 1] = ' ';
            pos += 2;
        }
        const remain = buf.len - pos;
        if (remain == 0) break;
        var short_buf: [48]u8 = undefined;
        const display = shortModel(model, &short_buf);
        const n = @min(display.len, remain);
        @memcpy(buf[pos .. pos + n], display[0..n]);
        pos += n;
    }
    return fit(buf[0..pos], buf);
}

pub fn shortModel(model: []const u8, buf: []u8) []const u8 {
    if (std.mem.startsWith(u8, model, "[pi] ")) {
        const inner = shortModel(model[5..], buf[5..]);
        if (buf.len < inner.len + 5) return fit(model, buf);
        @memcpy(buf[0..5], "[pi] ");
        return buf[0 .. inner.len + 5];
    }
    if (std.mem.startsWith(u8, model, "anthropic/claude-")) return shortClaudeModel(model["anthropic/claude-".len..], buf) orelse fit(model, buf);
    if (std.mem.startsWith(u8, model, "claude-")) return shortClaudeModel(model["claude-".len..], buf) orelse fit(model, buf);
    return fit(model, buf);
}

fn shortClaudeModel(rest: []const u8, buf: []u8) ?[]const u8 {
    const dash = std.mem.indexOfScalar(u8, rest, '-') orelse return null;
    const family = rest[0..dash];
    var version_end = rest.len;
    if (rest.len >= 9 and rest[rest.len - 9] == '-' and allDigits(rest[rest.len - 8 ..])) version_end = rest.len - 9;
    const version = rest[dash + 1 .. version_end];
    if (family.len == 0 or version.len == 0) return null;
    return std.fmt.bufPrint(buf, "{s}-{s}", .{ family, version }) catch null;
}

pub fn allDigits(text: []const u8) bool {
    for (text) |ch| if (ch < '0' or ch > '9') return false;
    return true;
}

pub fn fit(text: []const u8, buf: []u8) []const u8 {
    if (text.len <= buf.len) return text;
    if (buf.len == 0) return "";
    const n = if (buf.len > 1) buf.len - 1 else 1;
    @memcpy(buf[0..n], text[0..n]);
    if (buf.len > 1) buf[n] = '~';
    return buf[0..buf.len];
}

test "formatting helpers match table output expectations" {
    var number_buf: [32]u8 = undefined;
    try std.testing.expectEqualStrings("1,234,567", formatNumber(1_234_567, &number_buf));
    var cost_buf: [32]u8 = undefined;
    try std.testing.expectEqualStrings("$1.23", formatCurrency(1.234, &cost_buf));
}

test "model display helpers shorten Claude model names" {
    var buf: [64]u8 = undefined;
    try std.testing.expectEqualStrings("sonnet-4", shortModel("claude-sonnet-4-20250514", &buf));
    try std.testing.expectEqualStrings("opus-4", shortModel("anthropic/claude-opus-4-20250514", &buf));
    try std.testing.expectEqualStrings("[pi] sonnet-4", shortModel("[pi] claude-sonnet-4-20250514", &buf));
}
