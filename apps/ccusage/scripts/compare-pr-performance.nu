#!/usr/bin/env nix
#! nix shell --inputs-from ../../.. nixpkgs#nushell nixpkgs#bun nixpkgs#curl nixpkgs#git nixpkgs#hyperfine nixpkgs#just nixpkgs#pnpm --command nu

const head_runtime_choices = ['package' 'rust']

def main [
	--base-dir: string
	--base-package-url: string
	--base-sha: string
	--head-dir: string
	--head-runtime: string = 'package'
	--fixture-dir: string
	--codex-fixture-dir: string
	--output: string
	--runs: int = 7
	--warmup: int = 2
	--large-fixture-dir: string
	--large-codex-fixture-dir: string
	--large-runs: int = 1
	--large-warmup: int = 0
	--memory-runs: int = 1
	--head-package-url: string
	--package-runner-runs: int = 3
	--package-runner-timeout-ms: int = 120000
] {
	let values = {
		base_dir: $base_dir
		base_package_url: $base_package_url
		base_sha: $base_sha
		codex_fixture_dir: $codex_fixture_dir
		fixture_dir: $fixture_dir
		head_dir: $head_dir
		head_package_url: $head_package_url
		head_runtime: $head_runtime
		large_codex_fixture_dir: $large_codex_fixture_dir
		large_fixture_dir: $large_fixture_dir
		large_runs: $large_runs
		large_warmup: $large_warmup
		memory_runs: $memory_runs
		output: $output
		package_runner_runs: $package_runner_runs
		package_runner_timeout_ms: $package_runner_timeout_ms
		runs: $runs
		warmup: $warmup
	}
	for required in ['head_dir' 'fixture_dir' 'codex_fixture_dir'] {
		if ($values | get $required) == null {
			error make { msg: $"--($required | str replace '_' '-') is required" }
		}
	}
	assert_sample_options $values.runs $values.warmup ''
	assert_sample_options $values.large_runs $values.large_warmup 'large-'
	assert_sample_options $values.package_runner_runs 0 'package-runner-'
	if $values.memory_runs < 0 {
		error make { msg: '--memory-runs must be a non-negative integer' }
	}
	if $values.base_dir == null and $values.base_package_url == null {
		error make { msg: 'Either --base-dir or --base-package-url is required' }
	}

	let install_root = (mktemp -d -t ccusage-perf.XXXXXX | str trim)
	let base_dir = if $values.base_dir == null { null } else { $values.base_dir | path expand }
	let head_dir = ($values.head_dir | path expand)
	let head_runtime = (parse_head_runtime $values.head_runtime)
	let base_package_install_dir = ([$install_root base-package] | path join)
	let head_package_install_dir = ([$install_root head-package] | path join)
	let base_package_install = if $values.base_package_url == null {
		null
	} else {
		install_package_url $base_package_install_dir base $values.base_package_url $values.package_runner_timeout_ms
	}
	let head_package_install = if $values.head_package_url == null {
		null
	} else {
		install_package_url $head_package_install_dir PR $values.head_package_url $values.package_runner_timeout_ms
	}

	if $values.base_package_url != null and $base_package_install == null and $base_dir == null {
		let markdown = (render_skipped_markdown {
			base_package_url: $values.base_package_url
			base_sha: $values.base_sha
			head_runtime: $head_runtime
			head_sha: (git_sha $head_dir)
			reason: $"Base package URL was not ready before (format_duration $values.package_runner_timeout_ms). Fixture performance comparison requires a base package when --base-dir is not provided."
		})
		write_output $values.output $markdown
		rm -rf $install_root
		return
	}

	let head_native_bin_entry = if $head_package_install == null {
		null
	} else {
		installed_native_package_bin_entry $head_package_install_dir
	}
	let base_native_bin_entry = if $base_package_install == null {
		null
	} else {
		installed_native_package_bin_entry $base_package_install_dir
	}
	let base_bin_entry = if $base_package_install == null {
		package_bin_entry $base_dir
	} else {
		$base_package_install.bin_entry
	}
	let fixture_dir = ($values.fixture_dir | path expand)
	let codex_fixture_dir = ($values.codex_fixture_dir | path expand)
	let head_bin_entry = if $head_package_install == null { null } else { $head_package_install.bin_entry }
	let options = {
		base_bin_entry: $base_bin_entry
		base_package_url: $values.base_package_url
		base_runtime_description: (if $values.base_package_url == null { null } else { 'Base runs the published `ccusage` package from `pkg.pr.new`, installed before measurement' })
		base_sha: (if $values.base_sha != null { $values.base_sha } else if $base_dir == null { null } else { git_sha $base_dir })
		codex_fixture_dir: $codex_fixture_dir
		fixture_dir: $fixture_dir
		head_bin_entry: $head_bin_entry
		head_dir: $head_dir
		head_native_bin_entry: $head_native_bin_entry
		head_package_url: $values.head_package_url
		head_runtime: $head_runtime
		head_runtime_description: (
			if $head_runtime == 'rust' and $head_native_bin_entry != null {
				'PR runs the published native `ccusage` binary from `pkg.pr.new`, installed before measurement'
			} else if $head_runtime == 'package' and $head_package_install != null {
				'PR runs the published `ccusage` package from `pkg.pr.new`, installed before measurement'
			} else {
				null
			}
		)
		head_sha: (git_sha $head_dir)
		memory_runs: $values.memory_runs
		runs: $values.runs
		warmup: $values.warmup
	}

	mut sections = [
		(compare_fixture ($options | merge {
			commands: ['claude daily' 'claude session' 'codex daily' 'codex session']
			description: 'Committed small fixtures for stable PR-to-PR feedback and explicit Claude/Codex command coverage.'
			title: 'Committed fixture performance'
		}))
	]
	if $values.large_fixture_dir != null {
		$sections = ($sections | append (compare_fixture ($options | merge {
			codex_fixture_dir: (if $values.large_codex_fixture_dir == null { $codex_fixture_dir } else { $values.large_codex_fixture_dir | path expand })
			commands: ['claude' 'codex']
			description: 'Generated fixtures shaped from aggregate local log statistics: thousands of JSONL files, many small sessions, and a long tail of larger sessions. No real prompts, paths, or outputs are stored in the fixtures.'
			fixture_dir: ($values.large_fixture_dir | path expand)
			runs: $values.large_runs
			title: 'Large real-world-shaped fixture performance'
			warmup: $values.large_warmup
		})))
	}

	let base_bunx_cache_dir = ([$install_root bunx-base-cache] | path join)
	let head_bunx_cache_dir = ([$install_root bunx-head-cache] | path join)
	let package_runner = if $values.base_package_url == null and $values.head_package_url == null {
		null
	} else {
		{
			base: (if $values.base_package_url == null { null } else {
				measure_package_runner_with_acquisition $base_package_install.acquisition? $base_bunx_cache_dir base $values.base_package_url $values.package_runner_runs $values.package_runner_timeout_ms
			})
			head: (if $values.head_package_url == null { null } else {
				measure_package_runner_with_acquisition $head_package_install.acquisition? $head_bunx_cache_dir PR $values.head_package_url $values.package_runner_runs $values.package_runner_timeout_ms
			})
		}
	}
	let bunx_sections = if (
		$package_runner == null or
		$package_runner.base == null or
		$package_runner.head == null or
		$values.base_package_url == null or
		$values.head_package_url == null or
		$values.large_fixture_dir == null
	) {
		[]
	} else {
		[
			(compare_bunx_fixture {
				base_cache_dir: $base_bunx_cache_dir
				base_package_url: $values.base_package_url
				codex_fixture_dir: (if $values.large_codex_fixture_dir == null { $codex_fixture_dir } else { $values.large_codex_fixture_dir | path expand })
				commands: ['claude' 'codex']
				description: 'Runs the same large fixture through `bunx -p <pkg.pr.new URL> ccusage` after the Bun install cache has already been populated by the startup measurement. This separates cached package-runner execution from first-fetch package materialization.'
				fixture_dir: ($values.large_fixture_dir | path expand)
				head_cache_dir: $head_bunx_cache_dir
				head_package_url: $values.head_package_url
				memory_runs: $values.memory_runs
				runs: $values.large_runs
				title: 'Cached bunx execution performance'
				warmup: $values.large_warmup
			})
		]
	}
	let runtime_diagnostic_section = if $values.large_fixture_dir == null {
		null
	} else {
		compare_runtime_diagnostic_section {
			codex_fixture_dir: (if $values.large_codex_fixture_dir == null { $codex_fixture_dir } else { $values.large_codex_fixture_dir | path expand })
			commands: ['claude' 'codex']
			description: 'Compares the PR package wrapper, the installed native optional dependency binary, and the workspace release binary on the same large fixture. This identifies whether slow package results come from JavaScript wrapper overhead, the published native binary build, or the Rust core itself.'
			fixture_dir: ($values.large_fixture_dir | path expand)
			head_bin_entry: $head_bin_entry
			head_dir: $head_dir
			head_native_bin_entry: $head_native_bin_entry
			runs: $values.large_runs
			title: 'Package runtime diagnostics'
			warmup: $values.large_warmup
		}
	}
	let runtime_diagnostic_sections = if $runtime_diagnostic_section == null { [] } else { [$runtime_diagnostic_section] }

	let sizes = {
		base_native_package_binary: (if $base_native_bin_entry == null { null } else { optional_file_size_bytes $base_native_bin_entry })
		base_package: (if $values.base_package_url == null { packed_tarball_size_bytes $base_dir } else { remote_tarball_size_bytes $values.base_package_url })
		base_rust_binary: (if $base_dir == null { null } else { optional_file_size_bytes (rust_binary_entry $base_dir) })
		head_native_package_binary: (if $head_native_bin_entry == null { null } else { optional_file_size_bytes $head_native_bin_entry })
		head_package: (if $values.head_package_url == null { packed_tarball_size_bytes $head_dir } else { remote_tarball_size_bytes $values.head_package_url })
		head_rust_binary: (optional_file_size_bytes (rust_binary_entry $head_dir))
	}

	let markdown = (render_markdown $sections $sizes ($options | merge {
		bunx_sections: $bunx_sections
		package_runner: $package_runner
		runtime_diagnostic_sections: $runtime_diagnostic_sections
	}))
	write_output $values.output $markdown
	rm -rf $install_root
}

def parse_head_runtime [value: string] {
	if ($head_runtime_choices | any {|choice| $choice == $value }) {
		$value
	} else {
		error make { msg: $"Invalid head runtime: ($value). Use package or rust." }
	}
}

def assert_sample_options [runs: int, warmup: int, label: string] {
	if $runs < 1 {
		error make { msg: $"--($label)runs must be a positive integer" }
	}
	if $warmup < 0 {
		error make { msg: $"--($label)warmup must be a non-negative integer" }
	}
}

def platform_name [] {
	match $nu.os-info.name {
		macos => 'darwin'
		windows => 'win32'
		$other => $other
	}
}

def arch_name [] {
	match $nu.os-info.arch {
		aarch64 => 'arm64'
		x86_64 => 'x64'
		$other => $other
	}
}

def bun_path [] {
	which bun | get 0.path
}

def package_bin_entry [repo_dir: string] {
	let package_dir = ([$repo_dir apps ccusage] | path join)
	let package_json = (open ([$package_dir package.json] | path join))
	let publish_bin = if (($package_json.publishConfig?.bin? | describe) =~ '^record') {
		$package_json.publishConfig.bin.ccusage?
	} else {
		null
	}
	let bin_path = if $publish_bin != null { $publish_bin } else { $package_json.bin.ccusage? }
	if $bin_path == null {
		error make { msg: $"ccusage bin is missing in ($package_dir)/package.json" }
	}
	[$package_dir $bin_path] | path join
}

def rust_binary_entry [repo_dir: string] {
	[
		$repo_dir
		rust
		target
		release
		(if (platform_name) == 'win32' { 'ccusage.exe' } else { 'ccusage' })
	] | path join
}

def package_bin_shim [install_dir: string] {
	[
		$install_dir
		node_modules
		.bin
		(if (platform_name) == 'win32' { 'ccusage.cmd' } else { 'ccusage' })
	] | path join
}

def installed_package_bin_entry [install_dir: string] {
	let package_dir = ([$install_dir node_modules ccusage] | path join)
	let package_json_path = ([$package_dir package.json] | path join)
	let package_json = (try { open $package_json_path } catch { null })
	if $package_json == null {
		return (package_bin_shim $install_dir)
	}
	let bin_path = $package_json.bin.ccusage?
	if $bin_path == null {
		package_bin_shim $install_dir
	} else {
		[$package_dir $bin_path] | path join
	}
}

def native_package_directory_name [target_platform: string, target_arch: string] {
	if (($target_platform in ['darwin' 'linux' 'win32']) and ($target_arch in ['arm64' 'x64'])) {
		$"ccusage-($target_platform)-($target_arch)"
	} else {
		null
	}
}

def installed_native_package_bin_entry [
	install_dir: string
	target_platform: string = ''
	target_arch: string = ''
] {
	let platform = if $target_platform == '' { platform_name } else { $target_platform }
	let arch = if $target_arch == '' { arch_name } else { $target_arch }
	let package_dir_name = (native_package_directory_name $platform $arch)
	if $package_dir_name == null {
		return null
	}
	let bin_entry = ([
		$install_dir
		node_modules
		'@ccusage'
		$package_dir_name
		bin
		(if $platform == 'win32' { 'ccusage.exe' } else { 'ccusage' })
	] | path join)
	if (optional_file_size_bytes $bin_entry) == null {
		return null
	}
	if $platform != 'win32' {
		run-external chmod +x $bin_entry | complete | ignore
	}
	$bin_entry
}

def optional_file_size_bytes [file_path: string] {
	try {
		let row = (ls $file_path | get 0)
		if $row.type == 'file' { $row.size | into int } else { null }
	} catch {
		null
	}
}

def packed_tarball_size_bytes [repo_dir: string] {
	let package_dir = ([$repo_dir apps ccusage] | path join)
	let package_json_path = ([$package_dir package.json] | path join)
	let original_package_json = (open --raw $package_json_path)
	let destination = (mktemp -d -t ccusage-pack.XXXXXX | str trim)
	let pack_args = [pack --json --pack-destination $destination]
	let result = (do { cd $package_dir; run-external pnpm ...$pack_args | complete })
	$original_package_json | save --force $package_json_path
	if $result.exit_code != 0 {
		let message = (if ($result.stderr | str trim | is-not-empty) { $result.stderr | str trim } else { $result.stdout | str trim })
		error make { msg: $"pnpm pack failed: ($message)" }
	}
	let output_lines = ($result.stdout | lines)
	let json_start = ($output_lines | enumerate | where {|line| $line.item =~ '^\{' } | last | get index)
	let json_text = ($output_lines | skip $json_start | str join (char newline))
	let pack_result = ($json_text | from json)
	if $pack_result.filename? == null {
		error make { msg: 'pnpm pack did not report a tarball filename' }
	}
	optional_file_size_bytes $pack_result.filename
}

def remote_tarball_size_bytes [package_url: string] {
	let output = (mktemp -t ccusage-package.XXXXXX | str trim)
	let curl_args = [--fail --location --silent --output $output $package_url]
	let result = (run-external curl ...$curl_args | complete)
	if $result.exit_code != 0 {
		error make { msg: $"Failed to fetch ($package_url): ($result.stderr | str trim)" }
	}
	let size = (optional_file_size_bytes $output)
	rm --force $output
	$size
}

def package_url_is_ready [package_url: string] {
	let curl_args = [--fail --head --location --silent --output /dev/null $package_url]
	(run-external curl ...$curl_args | complete).exit_code == 0
}

def wait_for_package_url [package_url: string, timeout_ms: int] {
	let started = date now
	while (((date now) - $started) / 1ms) < $timeout_ms {
		if (package_url_is_ready $package_url) {
			return true
		}
		sleep 5sec
	}
	false
}

def install_package_url [install_dir: string, label: string, package_url: string, timeout_ms: int] {
	write_progress $"($label) package install waiting for package URL"
	if not (wait_for_package_url $package_url $timeout_ms) {
		write_progress $"($label) package install skipped because package URL was not ready"
		return null
	}
	mkdir $install_dir
	{ private: true, dependencies: { ccusage: $package_url } } | to json --indent 2 | save --force ([$install_dir package.json] | path join)
	write_progress $"($label) package install started: ($package_url)"
	let started = date now
	let install_args = [install --no-progress]
	let result = (do { cd $install_dir; run-external bun ...$install_args | complete })
	let acquisition = (((date now) - $started) / 1ms)
	if $result.exit_code != 0 {
		let message = (if ($result.stderr | str trim | is-not-empty) { $result.stderr | str trim } else { $result.stdout | str trim })
		error make { msg: $"($label) package install failed: ($message)" }
	}
	write_progress $"($label) package install finished: (format_duration $acquisition)"
	{
		acquisition: $acquisition
		bin_entry: (installed_package_bin_entry $install_dir)
	}
}

def write_progress [message: string] {
	print --stderr $"[ccusage-perf] ($message)"
}

def git_sha [directory: string] {
	(do { cd $directory; run-external git rev-parse HEAD | complete }).stdout | str trim
}

def format_sha [sha: string] {
	if ($sha | str length) > 12 { $sha | str substring 0..<12 } else { $sha }
}

def package_url_sha [package_url: string] {
	let match = ($package_url | parse --regex '@(?P<sha>[0-9a-fA-F]{7,40})(?:$|[/?#])')
	if ($match | is-empty) {
		$package_url
	} else {
		format_sha ($match | get 0.sha)
	}
}

def format_duration [milliseconds: number] {
	if $milliseconds >= 1000 {
		$"($milliseconds / 1000 | into string --decimals 3)s"
	} else {
		$"($milliseconds | into string --decimals 1)ms"
	}
}

def format_size [bytes: number] {
	$"($bytes / 1024 | into string --decimals 2) KiB"
}

def format_optional_size [bytes] {
	if $bytes == null { '-' } else { format_size $bytes }
}

def format_size_delta [base_bytes, head_bytes] {
	if $base_bytes == null or $head_bytes == null {
		'-'
	} else {
		let delta = ($head_bytes - $base_bytes)
		$"($delta >= 0 | if $in { '+' } else { '' })(format_size $delta)"
	}
}

def format_size_ratio [base_bytes, head_bytes] {
	if $base_bytes == null or $head_bytes == null or $head_bytes == 0 {
		'-'
	} else {
		$"($base_bytes / $head_bytes | into string --decimals 2)x"
	}
}

def format_data_size [bytes: number] {
	if $bytes >= (1024 * 1024 * 1024) {
		$"($bytes / 1024 / 1024 / 1024 | into string --decimals 2) GiB"
	} else {
		$"($bytes / 1024 / 1024 | into string --decimals 2) MiB"
	}
}

def format_memory_size [bytes: number] {
	if $bytes >= (1024 * 1024 * 1024) {
		$"($bytes / 1024 / 1024 / 1024 | into string --decimals 2) GiB"
	} else if $bytes >= (1024 * 1024) {
		$"($bytes / 1024 / 1024 | into string --decimals 2) MiB"
	} else {
		$"($bytes / 1024 | into string --decimals 2) KiB"
	}
}

def format_optional_memory [measurement] {
	if $measurement == null { '-' } else { format_memory_size $measurement.peak_rss_bytes }
}

def format_memory_ratio [base_memory, head_memory] {
	if $base_memory == null or $head_memory == null or $base_memory.peak_rss_bytes == 0 {
		'-'
	} else {
		$"($head_memory.peak_rss_bytes / $base_memory.peak_rss_bytes | into string --decimals 2)x"
	}
}

def measurement_from_milliseconds [times: list<number>] {
	if ($times | is-empty) {
		error make { msg: 'Cannot summarize zero measurements' }
	}
	let sorted = ($times | sort)
	{
		max: ($sorted | last)
		median: ($sorted | get (($sorted | length) // 2))
		min: ($sorted | first)
		samples: ($sorted | length)
	}
}

def measurement_from_hyperfine [result] {
	{
		max: ($result.max * 1000)
		median: ($result.median * 1000)
		min: ($result.min * 1000)
		samples: ($result.times | length)
	}
}

def format_throughput [bytes: number, milliseconds: number] {
	let mib_per_second = ($bytes / 1024 / 1024 / ($milliseconds / 1000))
	if $mib_per_second >= 1024 {
		$"($mib_per_second / 1024 | into string --decimals 2) GiB/s"
	} else {
		$"($mib_per_second | into string --decimals 2) MiB/s"
	}
}

def summarize_directory [directory: string] {
	let files = (glob $"($directory)/**/*" | where {|path| ($path | path type) == 'file' })
	let sizes = ($files | each {|path| optional_file_size_bytes $path })
	{
		bytes: ($sizes | math sum)
		files: ($files | length)
	}
}

def ccusage_benchmark_env [fixture_dir: string, codex_fixture_dir] {
	{
		CLAUDE_CONFIG_DIR: $fixture_dir
		COLUMNS: '200'
		LOG_LEVEL: '0'
		NO_COLOR: '1'
		TZ: UTC
	} | if $codex_fixture_dir == null { $in } else { $in | upsert CODEX_HOME $codex_fixture_dir }
}

def ccusage_command_args [command: string] {
	$command | split row ' ' | where {|part| $part != '' }
}

def create_ccusage_command_from_bin [bin_entry: string, fixture_dir: string, codex_fixture_dir, command: string] {
	[
		env
		$"CLAUDE_CONFIG_DIR=($fixture_dir)"
		...(if $codex_fixture_dir == null { [] } else { [$"CODEX_HOME=($codex_fixture_dir)"] })
		'COLUMNS=200'
		'LOG_LEVEL=0'
		'NO_COLOR=1'
		'TZ=UTC'
		(bun_path)
		-b
		$bin_entry
		$command
		--offline
		--json
	] | str join ' '
}

def create_ccusage_benchmark_command_from_bin [bin_entry: string, fixture_dir: string, codex_fixture_dir, command: string] {
	{
		args: ([(bun_path) -b $bin_entry] | append (ccusage_command_args $command) | append [--offline --json])
		env: (ccusage_benchmark_env $fixture_dir $codex_fixture_dir)
		text: (create_ccusage_command_from_bin $bin_entry $fixture_dir $codex_fixture_dir $command)
	}
}

def create_ccusage_command_from_rust_binary [bin_entry: string, fixture_dir: string, codex_fixture_dir, command: string] {
	[
		env
		$"CLAUDE_CONFIG_DIR=($fixture_dir)"
		...(if $codex_fixture_dir == null { [] } else { [$"CODEX_HOME=($codex_fixture_dir)"] })
		'COLUMNS=200'
		'LOG_LEVEL=0'
		'NO_COLOR=1'
		'TZ=UTC'
		$bin_entry
		$command
		--offline
		--json
	] | str join ' '
}

def create_ccusage_benchmark_command_from_rust_binary [bin_entry: string, fixture_dir: string, codex_fixture_dir, command: string] {
	{
		args: ([$bin_entry] | append (ccusage_command_args $command) | append [--offline --json])
		env: (ccusage_benchmark_env $fixture_dir $codex_fixture_dir)
		text: (create_ccusage_command_from_rust_binary $bin_entry $fixture_dir $codex_fixture_dir $command)
	}
}

def create_bunx_startup_command [package_url: string] {
	[(bun_path) x -p $package_url ccusage --version]
}

def create_ccusage_command_from_bunx_package [package_url: string, cache_dir: string, fixture_dir: string, codex_fixture_dir, command: string] {
	[
		env
		$"BUN_INSTALL_CACHE_DIR=($cache_dir)"
		$"CLAUDE_CONFIG_DIR=($fixture_dir)"
		...(if $codex_fixture_dir == null { [] } else { [$"CODEX_HOME=($codex_fixture_dir)"] })
		'COLUMNS=200'
		'LOG_LEVEL=0'
		'NO_COLOR=1'
		'TZ=UTC'
		(bun_path)
		x
		-p
		$package_url
		ccusage
		$command
		--offline
		--json
	] | str join ' '
}

def create_ccusage_benchmark_command_from_bunx_package [package_url: string, cache_dir: string, fixture_dir: string, codex_fixture_dir, command: string] {
	{
		args: ([(bun_path) x -p $package_url ccusage] | append (ccusage_command_args $command) | append [--offline --json])
		env: ({ BUN_INSTALL_CACHE_DIR: $cache_dir } | merge (ccusage_benchmark_env $fixture_dir $codex_fixture_dir))
		text: (create_ccusage_command_from_bunx_package $package_url $cache_dir $fixture_dir $codex_fixture_dir $command)
	}
}

def create_head_ccusage_benchmark_command [options] {
	if $options.head_runtime == 'package' and $options.head_bin_entry != null {
		return (create_ccusage_benchmark_command_from_bin $options.head_bin_entry $options.fixture_dir $options.codex_fixture_dir $options.command)
	}
	if $options.head_runtime == 'rust' and $options.head_native_bin_entry != null {
		return (create_ccusage_benchmark_command_from_rust_binary $options.head_native_bin_entry $options.fixture_dir $options.codex_fixture_dir $options.command)
	}
	if $options.head_runtime == 'rust' {
		create_ccusage_benchmark_command_from_rust_binary (rust_binary_entry $options.head_dir) $options.fixture_dir $options.codex_fixture_dir $options.command
	} else {
		create_ccusage_benchmark_command_from_bin (package_bin_entry $options.head_dir) $options.fixture_dir $options.codex_fixture_dir $options.command
	}
}

def measure_command_milliseconds [args: list<string>, command_env: record, label: string] {
	let started = date now
	let cmd = ($args | get 0)
	let rest = ($args | skip 1)
	let result = (with-env $command_env { run-external $cmd ...$rest | complete })
	let elapsed = (((date now) - $started) / 1ms)
	if $result.exit_code != 0 {
		error make { msg: $"($label) failed: ($result.stderr)" }
	}
	$elapsed
}

def measure_package_runner_startup [cache_dir: string, label: string, package_url: string, runs: int, timeout_ms: int] {
	write_progress $"($label) bunx startup waiting for package URL"
	if not (wait_for_package_url $package_url $timeout_ms) {
		write_progress $"($label) bunx startup skipped because package URL was not ready"
		return null
	}
	let args = (create_bunx_startup_command $package_url)
	let command_env = { BUN_INSTALL_CACHE_DIR: $cache_dir }
	write_progress $"($label) bunx cold startup started"
	let cold = (measure_command_milliseconds $args $command_env $"($label) bunx cold startup")
	mut warm_times = []
	for _ in 0..<($runs) {
		$warm_times = ($warm_times | append (measure_command_milliseconds $args $command_env $"($label) bunx warm startup"))
	}
	let warm = (measurement_from_milliseconds $warm_times)
	write_progress $"($label) bunx startup done: cold (format_duration $cold), warm (format_duration $warm.median)"
	{
		cold: $cold
		package_url: $package_url
		warm: $warm
	}
}

def measure_package_runner_with_acquisition [acquisition, cache_dir: string, label: string, package_url: string, runs: int, timeout_ms: int] {
	let startup = (measure_package_runner_startup $cache_dir $label $package_url $runs $timeout_ms)
	if $startup == null { null } else { $startup | upsert acquisition $acquisition }
}

def parse_peak_rss_bytes [stderr: string] {
	let linux = ($stderr | parse --regex 'Maximum resident set size \(kbytes\):\s*(?P<kb>\d+)')
	if not ($linux | is-empty) {
		return (($linux | get 0.kb | into int) * 1024)
	}
	let darwin = ($stderr | parse --regex '(?m)^\s*(?P<bytes>\d+)\s+maximum resident set size$')
	if not ($darwin | is-empty) {
		return ($darwin | get 0.bytes | into int)
	}
	error make { msg: 'Could not parse peak RSS from time output' }
}

def time_command_args [command] {
	if (platform_name) == 'linux' {
		{ cmd: '/usr/bin/time', args: ([-v] | append $command.args) }
	} else if (platform_name) == 'darwin' {
		{ cmd: '/usr/bin/time', args: ([-l] | append $command.args) }
	} else {
		null
	}
}

def measure_command_peak_rss_bytes [command, label: string] {
	let timed = (time_command_args $command)
	if $timed == null {
		error make { msg: $"Peak RSS measurement is not supported on (platform_name)" }
	}
	let result = (with-env $command.env { run-external $timed.cmd ...$timed.args | complete })
	if $result.exit_code != 0 {
		write_progress $"($label) peak RSS skipped after exit ($result.exit_code): ($result.stderr)"
		return null
	}
	try {
		parse_peak_rss_bytes $result.stderr
	} catch {|error|
		write_progress $"($label) peak RSS skipped: ($error.msg)"
		null
	}
}

def measure_command_memory [command, options] {
	if $options.runs == 0 {
		return null
	}
	mut samples = []
	for _ in 0..<($options.runs) {
		let sample = (measure_command_peak_rss_bytes $command $options.label)
		if $sample != null {
			$samples = ($samples | append $sample)
		}
	}
	if ($samples | is-empty) {
		return null
	}
	let sorted = ($samples | sort)
	{
		peak_rss_bytes: ($sorted | get (($sorted | length) // 2))
		samples: ($sorted | length)
	}
}

def compare_command [command: string, options] {
	write_progress $"($options.fixture_title) / ($command) started"
	let temp_dir = (mktemp -d -t ccusage-hyperfine.XXXXXX | str trim)
	let export_path = ([$temp_dir hyperfine.json] | path join)
	let base_command = (create_ccusage_benchmark_command_from_bin $options.base_bin_entry $options.fixture_dir $options.codex_fixture_dir $command)
	let head_command = (create_head_ccusage_benchmark_command ($options | merge { command: $command }))
	let hyperfine_args = [--shell none --warmup ($options.warmup | into string) --runs ($options.runs | into string) --export-json $export_path --style basic --output pipe --sort command --command-name base --command-name PR $base_command.text $head_command.text]
	let result = (run-external hyperfine ...$hyperfine_args | complete)
	if $result.exit_code != 0 {
		error make { msg: $"hyperfine failed for ($options.fixture_title) / ($command): exit ($result.exit_code)\n($result.stderr)" }
	}
	let hyperfine_output = (open $export_path)
	let base_result = ($hyperfine_output.results | get 0)
	let head_result = ($hyperfine_output.results | get 1)
	let base = (measurement_from_hyperfine $base_result)
	let head = (measurement_from_hyperfine $head_result)
	let base_memory = (measure_command_memory $base_command { label: $"($options.fixture_title) / ($command) base", runs: $options.memory_runs })
	let head_memory = (measure_command_memory $head_command { label: $"($options.fixture_title) / ($command) PR", runs: $options.memory_runs })
	write_progress $"($options.fixture_title) / ($command) done: base (format_duration $base.median), PR (format_duration $head.median)"
	rm -rf $temp_dir
	{
		base: $base
		base_memory: $base_memory
		command: $command
		head: $head
		head_memory: $head_memory
	}
}

def compare_bunx_command [command: string, options] {
	write_progress $"($options.fixture_title) / bunx ($command) started"
	let temp_dir = (mktemp -d -t ccusage-hyperfine.XXXXXX | str trim)
	let export_path = ([$temp_dir hyperfine.json] | path join)
	let base_command = (create_ccusage_benchmark_command_from_bunx_package $options.base_package_url $options.base_cache_dir $options.fixture_dir $options.codex_fixture_dir $command)
	let head_command = (create_ccusage_benchmark_command_from_bunx_package $options.head_package_url $options.head_cache_dir $options.fixture_dir $options.codex_fixture_dir $command)
	let hyperfine_args = [--shell none --warmup ($options.warmup | into string) --runs ($options.runs | into string) --export-json $export_path --style basic --output pipe --sort command --command-name base --command-name PR $base_command.text $head_command.text]
	let result = (run-external hyperfine ...$hyperfine_args | complete)
	if $result.exit_code != 0 {
		error make { msg: $"hyperfine failed for ($options.fixture_title) / bunx ($command): exit ($result.exit_code)\n($result.stderr)" }
	}
	let hyperfine_output = (open $export_path)
	let base = (measurement_from_hyperfine ($hyperfine_output.results | get 0))
	let head = (measurement_from_hyperfine ($hyperfine_output.results | get 1))
	let base_memory = (measure_command_memory $base_command { label: $"($options.fixture_title) / bunx ($command) base", runs: $options.memory_runs })
	let head_memory = (measure_command_memory $head_command { label: $"($options.fixture_title) / bunx ($command) PR", runs: $options.memory_runs })
	write_progress $"($options.fixture_title) / bunx ($command) done: base (format_duration $base.median), PR (format_duration $head.median)"
	rm -rf $temp_dir
	{
		base: $base
		base_memory: $base_memory
		command: $command
		head: $head
		head_memory: $head_memory
	}
}

def compare_fixture [options] {
	write_progress $"($options.title) started"
	let fixture_stats = (summarize_directory $options.fixture_dir)
	let codex_fixture_stats = if $options.codex_fixture_dir == null { null } else { summarize_directory $options.codex_fixture_dir }
	mut results = []
	for command in $options.commands {
		$results = ($results | append (compare_command $command ($options | upsert fixture_title $options.title)))
	}
	write_progress $"($options.title) finished"
	{
		codex_fixture_dir: $options.codex_fixture_dir
		codex_fixture_stats: $codex_fixture_stats
		description: $options.description
		fixture_dir: $options.fixture_dir
		fixture_stats: $fixture_stats
		memory_runs: $options.memory_runs
		results: $results
		runs: $options.runs
		title: $options.title
		warmup: $options.warmup
	}
}

def compare_bunx_fixture [options] {
	write_progress $"($options.title) started"
	let fixture_stats = (summarize_directory $options.fixture_dir)
	let codex_fixture_stats = if $options.codex_fixture_dir == null { null } else { summarize_directory $options.codex_fixture_dir }
	mut results = []
	for command in $options.commands {
		$results = ($results | append (compare_bunx_command $command ($options | upsert fixture_title $options.title)))
	}
	write_progress $"($options.title) finished"
	{
		base_package_url: $options.base_package_url
		codex_fixture_dir: $options.codex_fixture_dir
		codex_fixture_stats: $codex_fixture_stats
		description: $options.description
		fixture_dir: $options.fixture_dir
		fixture_stats: $fixture_stats
		head_package_url: $options.head_package_url
		memory_runs: $options.memory_runs
		results: $results
		runs: $options.runs
		title: $options.title
		warmup: $options.warmup
	}
}

def compare_runtime_diagnostic_command [command: string, options] {
	write_progress $"($options.fixture_title) / runtime diagnostics ($command) started"
	let temp_dir = (mktemp -d -t ccusage-hyperfine.XXXXXX | str trim)
	let export_path = ([$temp_dir hyperfine.json] | path join)
	let names = ($options.variants | each {|variant| [--command-name $variant.label] } | flatten)
	let texts = ($options.variants | each {|variant| $variant.command_text })
	let hyperfine_args = [--shell none --warmup ($options.warmup | into string) --runs ($options.runs | into string) --export-json $export_path --style basic --output pipe --sort command]
	let result = (run-external hyperfine ...$hyperfine_args ...$names ...$texts | complete)
	if $result.exit_code != 0 {
		error make { msg: $"hyperfine failed for ($options.fixture_title) / runtime diagnostics ($command): exit ($result.exit_code)\n($result.stderr)" }
	}
	let hyperfine_output = (open $export_path)
	if ($hyperfine_output.results | length) != ($options.variants | length) {
		error make { msg: $"hyperfine reported ($hyperfine_output.results | length) runtime diagnostic results for ($command), expected ($options.variants | length)" }
	}
	let results = ($hyperfine_output.results | each {|result| {
		command: $command
		label: $result.command
		measurement: (measurement_from_hyperfine $result)
	}})
	let summary = ($results | each {|result| $"($result.label) (format_duration $result.measurement.median)" } | str join ', ')
	write_progress $"($options.fixture_title) / runtime diagnostics ($command) done: ($summary)"
	rm -rf $temp_dir
	$results
}

def compare_runtime_diagnostic_section [options] {
	let workspace_rust_bin_entry = (rust_binary_entry $options.head_dir)
	let workspace_rust_binary_size = (optional_file_size_bytes $workspace_rust_bin_entry)
	mut variants = []
	if $options.head_bin_entry != null {
		$variants = ($variants | append {
			label: 'Package wrapper'
			kind: 'package'
			bin_entry: $options.head_bin_entry
		})
	}
	if $options.head_native_bin_entry != null {
		$variants = ($variants | append {
			label: 'Installed native binary'
			kind: 'rust'
			bin_entry: $options.head_native_bin_entry
		})
	}
	if $workspace_rust_binary_size != null {
		$variants = ($variants | append {
			label: 'Workspace release binary'
			kind: 'rust'
			bin_entry: $workspace_rust_bin_entry
		})
	}
	if ($variants | length) < 2 {
		return null
	}
	write_progress $"($options.title) started"
	let fixture_stats = (summarize_directory $options.fixture_dir)
	let codex_fixture_stats = if $options.codex_fixture_dir == null { null } else { summarize_directory $options.codex_fixture_dir }
	mut results = []
	for command in $options.commands {
		let command_variants = ($variants | each {|variant|
			{
				label: $variant.label
				command_text: (if $variant.kind == 'package' {
					create_ccusage_command_from_bin $variant.bin_entry $options.fixture_dir $options.codex_fixture_dir $command
				} else {
					create_ccusage_command_from_rust_binary $variant.bin_entry $options.fixture_dir $options.codex_fixture_dir $command
				})
			}
		})
		$results = ($results | append (compare_runtime_diagnostic_command $command {
			fixture_title: $options.title
			runs: $options.runs
			variants: $command_variants
			warmup: $options.warmup
		}))
	}
	write_progress $"($options.title) finished"
	{
		codex_fixture_dir: $options.codex_fixture_dir
		codex_fixture_stats: $codex_fixture_stats
		description: $options.description
		fixture_dir: $options.fixture_dir
		fixture_stats: $fixture_stats
		results: ($results | flatten)
		runs: $options.runs
		title: $options.title
		warmup: $options.warmup
	}
}

def format_fixture_path [head_dir: string, fixture_dir: string] {
	let relative = (try { $fixture_dir | path relative-to $head_dir } catch { $fixture_dir })
	if ($relative | str starts-with '..') { $fixture_dir } else { $relative }
}

def format_fixture_stats [stats] {
	$"(format_data_size $stats.bytes), ($stats.files | into string) files"
}

def fixture_stats_for_command [section, command: string] {
	if ($command | str starts-with codex) and $section.codex_fixture_stats != null {
		$section.codex_fixture_stats
	} else {
		$section.fixture_stats
	}
}

def table_md [rows] {
	$rows | to md
}

def render_fixture_section [section, options] {
	let has_memory = ($section.results | any {|result| $result.base_memory != null or $result.head_memory != null })
	let base_runtime_description = if $options.base_runtime_description? != null {
		$options.base_runtime_description
	} else {
		'Base runs the package `ccusage` bin from `apps/ccusage/package.json` through `bun -b`'
	}
	let head_runtime_description = if $options.head_runtime_description? != null {
		$options.head_runtime_description
	} else if $options.head_runtime == 'rust' {
		'PR runs `rust/target/release/ccusage` directly'
	} else {
		'PR runs the package `ccusage` bin from `apps/ccusage/package.json` through `bun -b`'
	}
	let fixture_line = if $section.codex_fixture_dir == null {
		$"Fixture: `(format_fixture_path $options.head_dir $section.fixture_dir)` \((format_fixture_stats $section.fixture_stats))"
	} else {
		$"Fixtures: Claude `(format_fixture_path $options.head_dir $section.fixture_dir)` \((format_fixture_stats $section.fixture_stats)), Codex `(format_fixture_path $options.head_dir $section.codex_fixture_dir)` \((format_fixture_stats (if $section.codex_fixture_stats == null { $section.fixture_stats } else { $section.codex_fixture_stats })))"
	}
	let table_rows = ($section.results | each {|result|
		let speedup = ($result.base.median / $result.head.median)
		let fixture_stats = (fixture_stats_for_command $section $result.command)
		let common = {
			Command: $"`($result.command) --offline --json`"
			Input: (format_data_size $fixture_stats.bytes)
			'Base median': (format_duration $result.base.median)
			'PR median': (format_duration $result.head.median)
			'PR vs base': $"($speedup | into string --decimals 2)x"
		}
		if $has_memory {
			$common | merge {
				'Base peak RSS': (format_optional_memory $result.base_memory)
				'PR peak RSS': (format_optional_memory $result.head_memory)
				'PR/base RSS': (format_memory_ratio $result.base_memory $result.head_memory)
				'Base throughput': (format_throughput $fixture_stats.bytes $result.base.median)
				'PR throughput': (format_throughput $fixture_stats.bytes $result.head.median)
			}
		} else {
			$common | merge {
				'Base throughput': (format_throughput $fixture_stats.bytes $result.base.median)
				'PR throughput': (format_throughput $fixture_stats.bytes $result.head.median)
			}
		}
	})
	[
		$"## ($section.title)"
		''
		$section.description
		''
		$fixture_line
		$"($base_runtime_description); ($head_runtime_description). Both run `--offline --json`, measured by `hyperfine` with `($section.warmup)` warmups and `($section.runs)` runs."
		...(if $has_memory { [$"Peak RSS is measured separately with `/usr/bin/time` using `($section.memory_runs)` runs. Lower RSS ratios are better."] } else { [] })
		''
		(table_md $table_rows)
	]
}

def render_runtime_diagnostic_section [section, options] {
	let fixture_line = if $section.codex_fixture_dir == null {
		$"Fixture: `(format_fixture_path $options.head_dir $section.fixture_dir)` \((format_fixture_stats $section.fixture_stats))"
	} else {
		$"Fixtures: Claude `(format_fixture_path $options.head_dir $section.fixture_dir)` \((format_fixture_stats $section.fixture_stats)), Codex `(format_fixture_path $options.head_dir $section.codex_fixture_dir)` \((format_fixture_stats (if $section.codex_fixture_stats == null { $section.fixture_stats } else { $section.codex_fixture_stats })))"
	}
	let table_rows = ($section.results | each {|result|
		let fixture_stats = (fixture_stats_for_command $section $result.command)
		{
			Command: $"`($result.command) --offline --json`"
			Runtime: $result.label
			Input: (format_data_size $fixture_stats.bytes)
			Median: (format_duration $result.measurement.median)
			Throughput: (format_throughput $fixture_stats.bytes $result.measurement.median)
			Samples: $result.measurement.samples
		}
	})
	[
		$"## ($section.title)"
		''
		$section.description
		''
		$fixture_line
		$"All rows run `--offline --json`, measured by `hyperfine` with `($section.warmup)` warmups and `($section.runs)` runs. This isolates wrapper overhead from the installed native optional dependency and the workspace release binary built on the runner."
		''
		(table_md $table_rows)
	]
}

def render_bunx_fixture_section [section, options] {
	let has_memory = ($section.results | any {|result| $result.base_memory != null or $result.head_memory != null })
	let fixture_line = if $section.codex_fixture_dir == null {
		$"Fixture: `(format_fixture_path $options.head_dir $section.fixture_dir)` \((format_fixture_stats $section.fixture_stats))"
	} else {
		$"Fixtures: Claude `(format_fixture_path $options.head_dir $section.fixture_dir)` \((format_fixture_stats $section.fixture_stats)), Codex `(format_fixture_path $options.head_dir $section.codex_fixture_dir)` \((format_fixture_stats (if $section.codex_fixture_stats == null { $section.fixture_stats } else { $section.codex_fixture_stats })))"
	}
	let table_rows = ($section.results | each {|result|
		let speedup = ($result.base.median / $result.head.median)
		let fixture_stats = (fixture_stats_for_command $section $result.command)
		let common = {
			Command: $"`bunx -p <pkg> ccusage ($result.command) --offline --json`"
			Input: (format_data_size $fixture_stats.bytes)
			'Base median': (format_duration $result.base.median)
			'PR median': (format_duration $result.head.median)
			'PR vs base': $"($speedup | into string --decimals 2)x"
		}
		if $has_memory {
			$common | merge {
				'Base peak RSS': (format_optional_memory $result.base_memory)
				'PR peak RSS': (format_optional_memory $result.head_memory)
				'PR/base RSS': (format_memory_ratio $result.base_memory $result.head_memory)
				'Base throughput': (format_throughput $fixture_stats.bytes $result.base.median)
				'PR throughput': (format_throughput $fixture_stats.bytes $result.head.median)
			}
		} else {
			$common | merge {
				'Base throughput': (format_throughput $fixture_stats.bytes $result.base.median)
				'PR throughput': (format_throughput $fixture_stats.bytes $result.head.median)
			}
		}
	})
	[
		$"## ($section.title)"
		''
		$section.description
		''
		$fixture_line
		$"Base package: `(package_url_sha $section.base_package_url)`; PR package: `(package_url_sha $section.head_package_url)`. Both run through `bunx -p <pkg.pr.new URL> ccusage` using the warmed Bun install cache from package runner startup, measured by `hyperfine` with `($section.warmup)` warmups and `($section.runs)` runs."
		...(if $has_memory { [$"Peak RSS is measured separately with `/usr/bin/time` using `($section.memory_runs)` runs. Lower RSS ratios are better."] } else { [] })
		''
		(table_md $table_rows)
	]
}

def render_package_runner_comparison [package_runner] {
	if $package_runner == null or ($package_runner.base == null and $package_runner.head == null) {
		return []
	}
	mut rows = []
	if $package_runner.base != null {
		$rows = ($rows | append {
			Package: 'Base pkg.pr.new'
			SHA: $"`(package_url_sha $package_runner.base.package_url)`"
			'Execution setup': (if $package_runner.base.acquisition == null { '-' } else { format_duration $package_runner.base.acquisition })
			'Bunx temp cache': (format_duration $package_runner.base.cold)
			'Bunx warm median': (format_duration $package_runner.base.warm.median)
			'Warm samples': $package_runner.base.warm.samples
		})
	}
	if $package_runner.head != null {
		$rows = ($rows | append {
			Package: 'PR pkg.pr.new'
			SHA: $"`(package_url_sha $package_runner.head.package_url)`"
			'Execution setup': (if $package_runner.head.acquisition == null { '-' } else { format_duration $package_runner.head.acquisition })
			'Bunx temp cache': (format_duration $package_runner.head.cold)
			'Bunx warm median': (format_duration $package_runner.head.warm.median)
			'Warm samples': $package_runner.head.warm.samples
		})
	}
	[
		'## Package runner startup'
		''
		'Execution setup measures any pre-benchmark package materialization used by the execution benchmark. Bunx temp cache measures one `bunx -p <url> ccusage --version` run with an empty Bun install cache. Warm reuses that cache and reports the median of repeated runs.'
		''
		(table_md $rows)
		''
	]
}

def render_markdown [sections, sizes, options] {
	let marker_name = if $options.head_runtime == 'rust' { 'ccusage-rust-perf-comment' } else { 'ccusage-perf-comment' }
	mut lines = [
		$"<!-- ($marker_name) -->"
	]
	if $options.head_sha? != null {
		$lines = ($lines | append $"<!-- ($marker_name):($options.head_sha) -->")
	}
	$lines = ($lines | append [
		'## ccusage performance comparison'
		''
	])
	if $options.head_sha? != null {
		$lines = ($lines | append $"PR SHA: `(format_sha $options.head_sha)`")
		if $options.base_sha? != null {
			$lines = ($lines | append $"Base SHA: `(format_sha $options.base_sha)`")
		}
		$lines = ($lines | append '')
	}
	$lines = ($lines | append (if $options.head_runtime == 'rust' {
		'This compares the Rust PR release binary against the configured base package on the same CI runner.'
	} else {
		'This compares the PR package against the configured base package on the same CI runner.'
	}))
	$lines = ($lines | append '')
	$lines = ($lines | append (render_package_runner_comparison $options.package_runner?))
	for section in ($options.bunx_sections? | default []) {
		$lines = ($lines | append (render_bunx_fixture_section $section $options) | append '')
	}
	for section in ($options.runtime_diagnostic_sections? | default []) {
		$lines = ($lines | append (render_runtime_diagnostic_section $section $options) | append '')
	}
	for section in $sections {
		$lines = ($lines | append (render_fixture_section $section $options) | append '')
	}
	mut size_rows = [
		{
			Artifact: 'packed `ccusage-*.tgz`'
			Base: (format_size $sizes.base_package)
			PR: (format_size $sizes.head_package)
			Delta: (format_size_delta $sizes.base_package $sizes.head_package)
			Ratio: (format_size_ratio $sizes.base_package $sizes.head_package)
		}
	]
	if $sizes.base_native_package_binary != null or $sizes.head_native_package_binary != null {
		$size_rows = ($size_rows | append {
			Artifact: 'installed native package binary'
			Base: (format_optional_size $sizes.base_native_package_binary)
			PR: (format_optional_size $sizes.head_native_package_binary)
			Delta: (format_size_delta $sizes.base_native_package_binary $sizes.head_native_package_binary)
			Ratio: (format_size_ratio $sizes.base_native_package_binary $sizes.head_native_package_binary)
		})
	}
	if $sizes.head_rust_binary != null {
		$size_rows = ($size_rows | append {
			Artifact: 'Rust release binary `rust/target/release/ccusage`'
			Base: (format_optional_size $sizes.base_rust_binary)
			PR: (format_size $sizes.head_rust_binary)
			Delta: (format_size_delta $sizes.base_rust_binary $sizes.head_rust_binary)
			Ratio: (format_size_ratio $sizes.base_rust_binary $sizes.head_rust_binary)
		})
	}
	$lines = ($lines | append [
		'## Artifact size'
		''
		(table_md $size_rows)
		''
		'Lower medians and smaller artifacts are better. CI runner noise still applies; use same-run ratios as directional PR feedback, not release guarantees.'
		''
	])
	$"($lines | str join (char newline))(char newline)"
}

def render_skipped_markdown [options] {
	let marker_name = if $options.head_runtime == 'rust' { 'ccusage-rust-perf-comment' } else { 'ccusage-perf-comment' }
	mut lines = [
		$"<!-- ($marker_name) -->"
	]
	if $options.head_sha? != null {
		$lines = ($lines | append $"<!-- ($marker_name):($options.head_sha) -->")
	}
	$lines = ($lines | append [
		'## ccusage performance comparison'
		''
	])
	if $options.head_sha? != null {
		$lines = ($lines | append $"PR SHA: `(format_sha $options.head_sha)`")
		if $options.base_sha? != null {
			$lines = ($lines | append $"Base SHA: `(format_sha $options.base_sha)`")
		}
		$lines = ($lines | append '')
	}
	$lines = ($lines | append [
		'Performance comparison skipped.'
		''
		$options.reason
	])
	if $options.base_package_url? != null {
		$lines = ($lines | append [
			''
			$"Base package: `(package_url_sha $options.base_package_url)`"
		])
	}
	$lines = ($lines | append '')
	$"($lines | str join (char newline))(char newline)"
}

def write_output [output, markdown: string] {
	if $output == null {
		print $markdown
	} else {
		$markdown | save --force ($output | path expand)
	}
}
