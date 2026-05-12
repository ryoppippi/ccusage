const std = @import("std");
const shared_args = @import("_shared-args.zig");

const Args = shared_args.Args;
const Command = shared_args.Command;
const CostMode = shared_args.CostMode;
const SortOrder = shared_args.SortOrder;
const WeekDay = shared_args.WeekDay;
const parseEnum = shared_args.parseEnum;

const EnvMap = std.process.Environ.Map;

pub fn applyConfig(allocator: std.mem.Allocator, args: *Args, process_io: *std.Io, env_map: *EnvMap) !void {
    const path = try findConfigPath(allocator, args.config_path, process_io, env_map);
    const config_path = path orelse return;
    const data = std.Io.Dir.cwd().readFileAlloc(process_io.*, config_path, allocator, .limited(1024 * 1024 * 16)) catch return;
    defer allocator.free(data);
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, data, .{ .ignore_unknown_fields = true }) catch return;
    defer parsed.deinit();
    const root = switch (parsed.value) {
        .object => |object| object,
        else => return,
    };
    if (!validConfigRoot(root)) return;
    if (objectField(root, "defaults")) |defaults| try applyConfigObject(allocator, args, defaults);
    if (objectField(root, "commands")) |commands| {
        if (objectField(commands, commandName(args.command))) |command_config| try applyConfigObject(allocator, args, command_config);
    }
}

pub fn claudePaths(allocator: std.mem.Allocator, paths: *std.array_list.Managed([]const u8), process_io: *std.Io, env_map: *EnvMap) !void {
    if (getEnvOwned(allocator, env_map, "CLAUDE_CONFIG_DIR")) |env_paths| {
        var it = std.mem.splitScalar(u8, env_paths, ',');
        while (it.next()) |raw| {
            const trimmed = std.mem.trim(u8, raw, " \t\r\n");
            if (trimmed.len == 0) continue;
            const projects = try std.fs.path.join(allocator, &.{ trimmed, "projects" });
            if (isDir(process_io, projects)) try paths.append(try allocator.dupe(u8, trimmed));
        }
        if (paths.items.len > 0) return;
        return error.NoClaudeData;
    } else |_| {}

    const home = try getEnvOwned(allocator, env_map, "HOME");
    const xdg = getEnvOwned(allocator, env_map, "XDG_CONFIG_HOME") catch try std.fs.path.join(allocator, &.{ home, ".config" });
    const p1 = try std.fs.path.join(allocator, &.{ xdg, "claude" });
    const p2 = try std.fs.path.join(allocator, &.{ home, ".claude" });
    if (isDir(process_io, try std.fs.path.join(allocator, &.{ p1, "projects" }))) try paths.append(p1);
    if (isDir(process_io, try std.fs.path.join(allocator, &.{ p2, "projects" }))) try paths.append(p2);
    if (paths.items.len == 0) return error.NoClaudeData;
}

fn findConfigPath(allocator: std.mem.Allocator, explicit_path: ?[]const u8, process_io: *std.Io, env_map: *EnvMap) !?[]const u8 {
    if (explicit_path) |path| return if (isFile(process_io, path)) try allocator.dupe(u8, path) else null;
    const local = try std.fs.path.join(allocator, &.{ ".ccusage", "ccusage.json" });
    if (isFile(process_io, local)) return local;
    var paths = std.array_list.Managed([]const u8).init(allocator);
    defer paths.deinit();
    claudePaths(allocator, &paths, process_io, env_map) catch return null;
    for (paths.items) |claude_path| {
        const candidate = try std.fs.path.join(allocator, &.{ claude_path, "ccusage.json" });
        if (isFile(process_io, candidate)) return candidate;
    }
    return null;
}

fn isFile(process_io: *std.Io, path: []const u8) bool {
    std.Io.Dir.cwd().access(process_io.*, path, .{}) catch return false;
    return true;
}

fn isDir(process_io: *std.Io, path: []const u8) bool {
    var dir = std.Io.Dir.openDirAbsolute(process_io.*, path, .{}) catch return false;
    dir.close(process_io.*);
    return true;
}

fn getEnvOwned(allocator: std.mem.Allocator, env_map: *EnvMap, key: []const u8) ![]const u8 {
    const value = env_map.get(key) orelse return error.EnvironmentVariableNotFound;
    return allocator.dupe(u8, value);
}

fn commandName(command: Command) []const u8 {
    return switch (command) {
        .daily => "daily",
        .weekly => "weekly",
        .monthly => "monthly",
        .session => "session",
        .blocks => "blocks",
        .help => "help",
        .version => "version",
    };
}

fn applyConfigObject(allocator: std.mem.Allocator, args: *Args, object: std.json.ObjectMap) !void {
    if (!args.explicit.since) {
        if (stringField(object, "since")) |v| args.since = try allocator.dupe(u8, v);
    }
    if (!args.explicit.until) {
        if (stringField(object, "until")) |v| args.until = try allocator.dupe(u8, v);
    }
    if (!args.explicit.json) {
        if (boolField(object, "json")) |v| args.json = v;
    }
    if (!args.explicit.breakdown) {
        if (boolField(object, "breakdown")) |v| args.breakdown = v;
    }
    if (!args.explicit.debug) {
        if (boolField(object, "debug")) |v| args.debug = v;
    }
    if (!args.explicit.debug_samples) {
        if (numberField(object, "debugSamples")) |v| {
            if (v >= 0) args.debug_samples = @intFromFloat(v);
        }
    }
    if (!args.explicit.offline) {
        if (boolField(object, "offline")) |v| args.offline = v;
    }
    if (!args.explicit.compact) {
        if (boolField(object, "compact")) |v| args.compact = v;
    }
    if (!args.explicit.color) {
        if (boolField(object, "color")) |v| args.color = v;
    }
    if (!args.explicit.instances) {
        if (boolField(object, "instances")) |v| args.instances = v;
    }
    if (!args.explicit.active) {
        if (boolField(object, "active")) |v| args.active = v;
    }
    if (!args.explicit.recent) {
        if (boolField(object, "recent")) |v| args.recent = v;
    }
    if (!args.explicit.timezone) {
        if (stringField(object, "timezone")) |v| args.timezone = try allocator.dupe(u8, v);
    }
    if (!args.explicit.jq) {
        if (stringField(object, "jq")) |v| args.jq = try allocator.dupe(u8, v);
    }
    if (!args.explicit.project) {
        if (stringField(object, "project")) |v| args.project = try allocator.dupe(u8, v);
    }
    if (!args.explicit.project_aliases) {
        if (stringField(object, "projectAliases")) |v| args.project_aliases = try allocator.dupe(u8, v);
    }
    if (!args.explicit.id) {
        if (stringField(object, "id")) |v| args.id = try allocator.dupe(u8, v);
    }
    if (!args.explicit.token_limit) {
        if (stringField(object, "tokenLimit")) |v| args.token_limit = try allocator.dupe(u8, v);
    }
    if (!args.explicit.session_length) {
        if (numberField(object, "sessionLength")) |v| args.session_length = v;
    }
    if (!args.explicit.mode) {
        if (stringField(object, "mode")) |v| {
            if (parseEnum(CostMode, v)) |mode| args.mode = mode;
        }
    }
    if (!args.explicit.order) {
        if (stringField(object, "order")) |v| {
            if (parseEnum(SortOrder, v)) |order| args.order = order;
        }
    }
    if (!args.explicit.start_of_week) {
        if (stringField(object, "startOfWeek")) |v| {
            if (parseEnum(WeekDay, v)) |day| args.start_of_week = day;
        }
    }
}

fn objectField(object: std.json.ObjectMap, key: []const u8) ?std.json.ObjectMap {
    const value = object.get(key) orelse return null;
    return switch (value) {
        .object => |child| child,
        else => null,
    };
}

fn validConfigRoot(object: std.json.ObjectMap) bool {
    if (object.get("$schema")) |value| {
        if (value != .string) return false;
    }
    if (object.get("defaults")) |value| {
        if (value != .object and value != .null) return false;
    }
    if (object.get("commands")) |value| {
        if (value != .object and value != .null) return false;
    }
    return true;
}

fn stringField(object: std.json.ObjectMap, key: []const u8) ?[]const u8 {
    const value = object.get(key) orelse return null;
    return switch (value) {
        .string => |s| s,
        else => null,
    };
}

fn boolField(object: std.json.ObjectMap, key: []const u8) ?bool {
    const value = object.get(key) orelse return null;
    return switch (value) {
        .bool => |b| b,
        else => null,
    };
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

test "config objects merge with TypeScript CLI precedence" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    const data =
        \\{
        \\  "defaults": {
        \\    "json": false,
        \\    "mode": "calculate",
        \\    "debug": false,
        \\    "project": "default-project",
        \\    "offline": false,
        \\    "timezone": "UTC",
        \\    "startOfWeek": "monday"
        \\  },
        \\  "commands": {
        \\    "daily": {
        \\      "instances": true,
        \\      "project": "daily-project",
        \\      "breakdown": false,
        \\      "debugSamples": 2,
        \\      "order": "desc"
        \\    }
        \\  }
        \\}
    ;
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, data, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    const root = parsed.value.object;

    var args = Args{
        .command = .daily,
        .json = true,
        .breakdown = true,
        .explicit = .{
            .json = true,
            .breakdown = true,
        },
    };

    try applyConfigObject(allocator, &args, objectField(root, "defaults").?);
    try applyConfigObject(allocator, &args, objectField(objectField(root, "commands").?, "daily").?);

    try std.testing.expect(args.json);
    try std.testing.expect(args.breakdown);
    try std.testing.expectEqual(CostMode.calculate, args.mode);
    try std.testing.expectEqual(false, args.debug);
    try std.testing.expectEqual(false, args.offline);
    try std.testing.expectEqual(WeekDay.monday, args.start_of_week);
    try std.testing.expectEqual(SortOrder.desc, args.order);
    try std.testing.expect(args.instances);
    try std.testing.expectEqual(@as(usize, 2), args.debug_samples);
    try std.testing.expectEqualStrings("daily-project", args.project.?);
    try std.testing.expectEqualStrings("UTC", args.timezone.?);
}

test "applyConfig loads explicit config path and ignores invalid config structure" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var io = std.testing.io;
    var root_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const root = root_buf[0..try tmp.dir.realPath(io, &root_buf)];

    try tmp.dir.writeFile(io, .{
        .sub_path = "valid.json",
        .data =
        \\{
        \\  "defaults": { "json": true, "mode": "display" },
        \\  "commands": { "daily": { "instances": true } }
        \\}
        ,
    });
    try tmp.dir.writeFile(io, .{
        .sub_path = "invalid.json",
        .data =
        \\{
        \\  "defaults": "invalid-type",
        \\  "commands": { "daily": { "instances": true } }
        \\}
        ,
    });

    const valid_path = try std.fs.path.join(std.testing.allocator, &.{ root, "valid.json" });
    defer std.testing.allocator.free(valid_path);
    const invalid_path = try std.fs.path.join(std.testing.allocator, &.{ root, "invalid.json" });
    defer std.testing.allocator.free(invalid_path);

    var env = EnvMap.init(std.testing.allocator);
    defer env.deinit();

    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    var valid_args = Args{ .command = .daily, .config_path = valid_path };
    try applyConfig(allocator, &valid_args, &io, &env);
    try std.testing.expect(valid_args.json);
    try std.testing.expect(valid_args.instances);
    try std.testing.expectEqual(CostMode.display, valid_args.mode);

    var invalid_args = Args{ .command = .daily, .config_path = invalid_path };
    try applyConfig(allocator, &invalid_args, &io, &env);
    try std.testing.expect(!invalid_args.instances);
    try std.testing.expectEqual(CostMode.auto, invalid_args.mode);
}
