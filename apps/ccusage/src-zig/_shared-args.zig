const std = @import("std");
const date_utils = @import("_date-utils.zig");

const SESSION_DURATION_HOURS = 5.0;

pub const CostMode = enum { auto, calculate, display };
pub const SortOrder = enum { asc, desc };
pub const Command = enum { daily, weekly, monthly, session, blocks, help, version };
pub const WeekDay = date_utils.WeekDay;

pub const ExplicitArgs = struct {
    since: bool = false,
    until: bool = false,
    json: bool = false,
    mode: bool = false,
    debug: bool = false,
    debug_samples: bool = false,
    order: bool = false,
    breakdown: bool = false,
    offline: bool = false,
    timezone: bool = false,
    jq: bool = false,
    compact: bool = false,
    color: bool = false,
    instances: bool = false,
    project: bool = false,
    project_aliases: bool = false,
    id: bool = false,
    active: bool = false,
    recent: bool = false,
    token_limit: bool = false,
    session_length: bool = false,
    start_of_week: bool = false,
    single_thread: bool = false,
    threads: bool = false,
};

pub const Args = struct {
    command: Command = .daily,
    since: ?[]const u8 = null,
    until: ?[]const u8 = null,
    json: bool = false,
    mode: CostMode = .auto,
    debug: bool = false,
    debug_samples: usize = 5,
    order: SortOrder = .asc,
    breakdown: bool = false,
    offline: bool = false,
    timezone: ?[]const u8 = null,
    jq: ?[]const u8 = null,
    compact: bool = false,
    color: ?bool = null,
    instances: bool = false,
    project: ?[]const u8 = null,
    project_aliases: ?[]const u8 = null,
    id: ?[]const u8 = null,
    active: bool = false,
    recent: bool = false,
    token_limit: ?[]const u8 = null,
    session_length: f64 = SESSION_DURATION_HOURS,
    start_of_week: WeekDay = .sunday,
    single_thread: bool = false,
    threads: ?usize = null,
    config_path: ?[]const u8 = null,
    explicit: ExplicitArgs = .{},
};

pub fn parseArgs(argv: []const []const u8) !Args {
    var args = Args{};
    var i: usize = 0;
    if (argv.len > 0 and !std.mem.startsWith(u8, argv[0], "-")) {
        if (std.mem.eql(u8, argv[0], "daily")) args.command = .daily else if (std.mem.eql(u8, argv[0], "weekly")) args.command = .weekly else if (std.mem.eql(u8, argv[0], "monthly")) args.command = .monthly else if (std.mem.eql(u8, argv[0], "session")) args.command = .session else if (std.mem.eql(u8, argv[0], "blocks")) args.command = .blocks else if (std.mem.eql(u8, argv[0], "help")) args.command = .help else return error.UnknownCommand;
        i = 1;
    }
    while (i < argv.len) : (i += 1) {
        const a = argv[i];
        if (std.mem.eql(u8, a, "--help") or std.mem.eql(u8, a, "-h")) {
            args.command = .help;
        } else if (std.mem.eql(u8, a, "--version") or std.mem.eql(u8, a, "-v")) {
            args.command = .version;
        } else if (std.mem.eql(u8, a, "--json") or std.mem.eql(u8, a, "-j")) {
            args.json = true;
            args.explicit.json = true;
        } else if (std.mem.eql(u8, a, "--breakdown") or std.mem.eql(u8, a, "-b")) {
            args.breakdown = true;
            args.explicit.breakdown = true;
        } else if (std.mem.eql(u8, a, "--offline") or std.mem.eql(u8, a, "-O")) {
            args.offline = true;
            args.explicit.offline = true;
        } else if (std.mem.eql(u8, a, "--no-offline")) {
            args.offline = false;
            args.explicit.offline = true;
        } else if (std.mem.eql(u8, a, "--compact")) {
            args.compact = true;
            args.explicit.compact = true;
        } else if (std.mem.eql(u8, a, "--color")) {
            args.color = true;
            args.explicit.color = true;
        } else if (std.mem.eql(u8, a, "--no-color")) {
            args.color = false;
            args.explicit.color = true;
        } else if (std.mem.eql(u8, a, "--instances") or std.mem.eql(u8, a, "-i")) {
            if (args.command == .session) {
                i += 1;
                if (i >= argv.len) return error.MissingValue;
                args.id = argv[i];
                args.explicit.id = true;
            } else {
                args.instances = true;
                args.explicit.instances = true;
            }
        } else if (std.mem.eql(u8, a, "--active") or std.mem.eql(u8, a, "-a")) {
            args.active = true;
            args.explicit.active = true;
        } else if (std.mem.eql(u8, a, "--recent") or std.mem.eql(u8, a, "-r")) {
            args.recent = true;
            args.explicit.recent = true;
        } else if (std.mem.eql(u8, a, "--since") or std.mem.eql(u8, a, "-s")) {
            i += 1;
            if (i >= argv.len) return error.MissingValue;
            args.since = argv[i];
            args.explicit.since = true;
        } else if (std.mem.eql(u8, a, "--until") or std.mem.eql(u8, a, "-u")) {
            i += 1;
            if (i >= argv.len) return error.MissingValue;
            args.until = argv[i];
            args.explicit.until = true;
        } else if (std.mem.eql(u8, a, "--mode") or std.mem.eql(u8, a, "-m")) {
            i += 1;
            if (i >= argv.len) return error.MissingValue;
            args.mode = parseEnum(CostMode, argv[i]) orelse return error.InvalidMode;
            args.explicit.mode = true;
        } else if (std.mem.eql(u8, a, "--debug") or std.mem.eql(u8, a, "-d")) {
            args.debug = true;
            args.explicit.debug = true;
        } else if (std.mem.eql(u8, a, "--debug-samples")) {
            i += 1;
            if (i >= argv.len) return error.MissingValue;
            args.debug_samples = try std.fmt.parseInt(usize, argv[i], 10);
            args.explicit.debug_samples = true;
        } else if (std.mem.startsWith(u8, a, "--debug-samples=")) {
            args.debug_samples = try std.fmt.parseInt(usize, a["--debug-samples=".len..], 10);
            args.explicit.debug_samples = true;
        } else if (std.mem.eql(u8, a, "--order") or std.mem.eql(u8, a, "-o")) {
            i += 1;
            if (i >= argv.len) return error.MissingValue;
            args.order = parseEnum(SortOrder, argv[i]) orelse return error.InvalidOrder;
            args.explicit.order = true;
        } else if (std.mem.eql(u8, a, "--timezone") or std.mem.eql(u8, a, "-z")) {
            i += 1;
            if (i >= argv.len) return error.MissingValue;
            args.timezone = argv[i];
            args.explicit.timezone = true;
        } else if (std.mem.eql(u8, a, "--jq") or std.mem.eql(u8, a, "-q")) {
            i += 1;
            if (i >= argv.len) return error.MissingValue;
            args.jq = argv[i];
            args.explicit.jq = true;
        } else if (std.mem.eql(u8, a, "--project") or std.mem.eql(u8, a, "-p")) {
            i += 1;
            if (i >= argv.len) return error.MissingValue;
            args.project = argv[i];
            args.explicit.project = true;
        } else if (std.mem.eql(u8, a, "--project-aliases")) {
            i += 1;
            if (i >= argv.len) return error.MissingValue;
            args.project_aliases = argv[i];
            args.explicit.project_aliases = true;
        } else if (std.mem.eql(u8, a, "--id")) {
            i += 1;
            if (i >= argv.len) return error.MissingValue;
            args.id = argv[i];
            args.explicit.id = true;
        } else if (std.mem.eql(u8, a, "--token-limit") or std.mem.eql(u8, a, "-t")) {
            i += 1;
            if (i >= argv.len) return error.MissingValue;
            args.token_limit = argv[i];
            args.explicit.token_limit = true;
        } else if (std.mem.eql(u8, a, "--session-length") or std.mem.eql(u8, a, "-n")) {
            i += 1;
            if (i >= argv.len) return error.MissingValue;
            args.session_length = try std.fmt.parseFloat(f64, argv[i]);
            args.explicit.session_length = true;
        } else if (std.mem.eql(u8, a, "--start-of-week") or std.mem.eql(u8, a, "-w")) {
            i += 1;
            if (i >= argv.len) return error.MissingValue;
            args.start_of_week = parseEnum(WeekDay, argv[i]) orelse return error.InvalidWeekDay;
            args.explicit.start_of_week = true;
        } else if (std.mem.eql(u8, a, "--single-thread")) {
            args.single_thread = true;
            args.explicit.single_thread = true;
        } else if (std.mem.eql(u8, a, "--threads")) {
            i += 1;
            if (i >= argv.len) return error.MissingValue;
            args.threads = try parseThreadCount(argv[i]);
            args.explicit.threads = true;
        } else if (std.mem.startsWith(u8, a, "--threads=")) {
            args.threads = try parseThreadCount(a["--threads=".len..]);
            args.explicit.threads = true;
        } else if (std.mem.eql(u8, a, "--config")) {
            i += 1;
            if (i >= argv.len) return error.MissingValue;
            args.config_path = argv[i];
        } else {
            return error.UnknownOption;
        }
    }
    return args;
}

pub fn parseEnum(comptime T: type, value: []const u8) ?T {
    inline for (@typeInfo(T).@"enum".fields) |field| {
        if (std.mem.eql(u8, value, field.name)) return @enumFromInt(field.value);
    }
    return null;
}

fn parseThreadCount(value: []const u8) !usize {
    const parsed = try std.fmt.parseInt(usize, value, 10);
    if (parsed == 0) return error.InvalidThreadCount;
    return parsed;
}

test "argument parsing matches supported JavaScript CLI options" {
    const argv = [_][]const u8{
        "weekly",
        "--since",
        "20240101",
        "--until",
        "20240131",
        "--json",
        "--mode",
        "display",
        "--debug",
        "--debug-samples",
        "2",
        "--order",
        "desc",
        "--breakdown",
        "--offline",
        "--timezone",
        "UTC",
        "--jq",
        ".weekly",
        "--project-aliases",
        "project-a=Project A",
        "--start-of-week",
        "monday",
        "--no-color",
        "--single-thread",
        "--threads",
        "4",
    };
    const args = try parseArgs(&argv);
    try std.testing.expectEqual(Command.weekly, args.command);
    try std.testing.expectEqualStrings("20240101", args.since.?);
    try std.testing.expectEqualStrings("20240131", args.until.?);
    try std.testing.expect(args.json);
    try std.testing.expectEqual(CostMode.display, args.mode);
    try std.testing.expect(args.debug);
    try std.testing.expectEqual(@as(usize, 2), args.debug_samples);
    try std.testing.expectEqual(SortOrder.desc, args.order);
    try std.testing.expect(args.breakdown);
    try std.testing.expect(args.offline);
    try std.testing.expectEqualStrings("UTC", args.timezone.?);
    try std.testing.expectEqualStrings(".weekly", args.jq.?);
    try std.testing.expectEqualStrings("project-a=Project A", args.project_aliases.?);
    try std.testing.expectEqual(WeekDay.monday, args.start_of_week);
    try std.testing.expectEqual(false, args.color.?);
    try std.testing.expect(args.explicit.color);
    try std.testing.expect(args.single_thread);
    try std.testing.expect(args.explicit.single_thread);
    try std.testing.expectEqual(@as(usize, 4), args.threads.?);
    try std.testing.expect(args.explicit.threads);
}

test "thread count rejects zero" {
    try std.testing.expectError(error.InvalidThreadCount, parseArgs(&[_][]const u8{ "daily", "--threads=0" }));
}

test "session shorthand and blocks options parse like JavaScript CLI" {
    const session_argv = [_][]const u8{ "session", "-i", "session-id" };
    const session_args = try parseArgs(&session_argv);
    try std.testing.expectEqual(Command.session, session_args.command);
    try std.testing.expectEqualStrings("session-id", session_args.id.?);

    const blocks_argv = [_][]const u8{ "blocks", "--active", "--recent", "--token-limit", "max", "--session-length", "2.5" };
    const blocks_args = try parseArgs(&blocks_argv);
    try std.testing.expectEqual(Command.blocks, blocks_args.command);
    try std.testing.expect(blocks_args.active);
    try std.testing.expect(blocks_args.recent);
    try std.testing.expectEqualStrings("max", blocks_args.token_limit.?);
    try std.testing.expectApproxEqAbs(2.5, blocks_args.session_length, 0.0000001);
}
