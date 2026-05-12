const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{ .preferred_optimize_mode = .ReleaseSmall });

    const exe = b.addExecutable(.{
        .name = "ccusage",
        .root_module = b.createModule(.{
            .root_source_file = b.path("apps/ccusage/src-zig/main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });

    b.installArtifact(exe);

    const run_cmd = b.addRunArtifact(exe);
    run_cmd.step.dependOn(b.getInstallStep());
    if (b.args) |args| {
        run_cmd.addArgs(args);
    }

    const run_step = b.step("run", "Run ccusage");
    run_step.dependOn(&run_cmd.step);

    const tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("apps/ccusage/src-zig/main.zig"),
            .target = target,
            .optimize = .Debug,
        }),
    });

    const test_step = b.step("test", "Run Zig tests");
    test_step.dependOn(&b.addRunArtifact(tests).step);
}
