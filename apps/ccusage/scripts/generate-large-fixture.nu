#!/usr/bin/env nix
#! nix shell --inputs-from ../../.. nixpkgs#nushell nixpkgs#bash nixpkgs#coreutils --command nu
const default_size_mib = 1024
const default_codex_size_mib = 1024
const chunk_line_count = 128
const flush_interval_bytes = 67108864
const real_world_profile_files = 3142
const real_world_profile_total_mib = 1238.9718046188354
const real_world_quantiles = [
    {p: 0.0, size: 236.0}
    {p: 0.5, size: 105267.0}
    {p: 0.75, size: 233572.0}
    {p: 0.9, size: 653972.0}
    {p: 0.95, size: 1504757.0}
    {p: 0.99, size: 5383751.0}
    {p: 1.0, size: 87033471.0}
]
const base36_chars = '0123456789abcdefghijklmnopqrstuvwxyz'
def main [
    --output-dir: string
    --codex-output-dir: string
    --size-mib: int = 1024
    --codex-size-mib: int = 1024
] {
    if ($output_dir | is-empty) {
        error make {msg: '--output-dir is required'}
    }
    if $size_mib < 1 {
        error make {msg: '--size-mib must be a positive integer'}
    }
    if $codex_size_mib < 1 {
        error make {msg: '--codex-size-mib must be a positive integer'}
    }
    let padding_source = (create_padding_source)
    let claude_output_dir = ($output_dir | path expand)
    let claude_result = (generate_claude_fixture $claude_output_dir $size_mib $padding_source)
    print $"Generated Claude fixture ($claude_output_dir)"
    print $"Files: ($claude_result.file_count)"
    print $"Rows: ($claude_result.line_count)"
    print $"Size: (format_bytes $claude_result.total_bytes)"
    if not ($codex_output_dir | is-empty) {
        let codex_dir = ($codex_output_dir | path expand)
        let codex_result = (generate_codex_fixture $codex_dir $codex_size_mib $padding_source)
        print $"Generated Codex fixture ($codex_dir)"
        print $"Files: ($codex_result.file_count)"
        print $"Rows: ($codex_result.line_count)"
        print $"Size: (format_bytes $codex_result.total_bytes)"
    }
}
def create_padding_source [] {
    let result = (run-external bash '-c' "printf '%*s' 131072 '' | tr ' ' x" | complete)
    if $result.exit_code != 0 {
        error make {
            msg: $"failed to create padding source\n($result.stderr)"
        }
    }
    $result.stdout
}
def format_bytes [bytes: int] { $"(($bytes / 1024 / 1024) | into string --decimals 2) MiB" }
def interpolate_file_size [percentile: float] {
    for index in 1..<($real_world_quantiles | length) {
        let previous = ($real_world_quantiles | get ($index - 1))
        let current = ($real_world_quantiles | get $index)
        if $percentile > $current.p {
            continue
        }
        let span = ($current.p - $previous.p)
        let ratio = if $span == 0 { 0.0 } else { ($percentile - $previous.p) / $span }
        return ($previous.size + (($current.size - $previous.size) * $ratio))
    }
    ($real_world_quantiles | last | get size)
}
def create_file_size_targets [target_bytes: int] {
    let target_file_count = ([
        1
        (($target_bytes / 1024 / 1024 / $real_world_profile_total_mib * $real_world_profile_files) | math round)
    ] | math max)
    let raw_sizes = (0..<$target_file_count | each {|index|
        interpolate_file_size (($index + 0.5) / $target_file_count)
    })
    let raw_total = ($raw_sizes | math sum)
    let scale = ($target_bytes / $raw_total)
    $raw_sizes | each {|size| [256 (($size * $scale) | math round)] | math max }
}
def shuffled_index [index: int, length: int] { (($index * ($length - 1) + 17) mod $length) }
def content_length [index: int] {
    if ($index mod 997) == 0 {
        return (48 * 1024 + ($index mod (32 * 1024)))
    }
    if ($index mod 37) == 0 {
        return (8 * 1024 + ($index mod (8 * 1024)))
    }
    1800 + ((($index * 1103515245 + 12345) mod 4294967296) mod 2400)
}
def content_padding [padding_source: string, length: int] {
    $padding_source | str substring 0..<($length)
}
def assert_safe_deletion_target [directory: string, flag_name: string] {
    let resolved = ($directory | path expand)
    let parsed = ($resolved | path parse)
    if $resolved == $parsed.parent or $resolved == (pwd) or ($resolved | str length) < 5 {
        error make {
            msg: $"Refusing to delete unsafe ($flag_name) path: ($resolved)"
        }
    }
}
def create_usage_line [
    index: int
    file_index: int
    session_id: string
    padding_source: string
] {
    let day = (($index mod 28) + 1 | into string | fill --alignment right --character '0' --width 2)
    let hour = ($index mod 24 | into string | fill --alignment right --character '0' --width 2)
    let minute = ((($index / 24) | math floor) mod 60 | into string | fill --alignment right --character '0' --width 2)
    let suffix = (to_base36 $index | fill --alignment right --character '0' --width 10)
    let model = if ($index mod 5) == 0 { 'claude-opus-4-20250514' } else { 'claude-sonnet-4-20250514' }
    let speed = if ($index mod 7) == 0 { ',"speed":"fast"' } else { '' }
    let project_name = $"project-(($file_index mod 128 | into string | fill --alignment right --character '0' --width 3))"
    let padding = (content_padding $padding_source (content_length $index))
    $"{"timestamp":"2026-01-($day)T($hour):($minute):00.000Z","cwd":"/tmp/ccusage-large-fixture/($project_name)","sessionId":"($session_id)","version":"1.0.0","message":{"id":"msg_($suffix)","model":"($model)","content":[{"type":"text","text":"($padding)"}],"usage":{"input_tokens":(100 + ($index mod 1000)),"output_tokens":(20 + ($index mod 200)),"cache_creation_input_tokens":($index mod 300),"cache_read_input_tokens":($index mod 5000)($speed)}},"requestId":"req_($suffix)"}\n"
}
def create_codex_usage_line [index: int, file_index: int, padding_source: string] {
    let day = (($index mod 28) + 1 | into string | fill --alignment right --character '0' --width 2)
    let hour = ($index mod 24 | into string | fill --alignment right --character '0' --width 2)
    let minute = ((($index / 24) | math floor) mod 60 | into string | fill --alignment right --character '0' --width 2)
    let model = if ($index mod 5) == 0 { 'gpt-5.3-codex' } else { 'gpt-5.2-codex' }
    let input_tokens = (200 + ($index mod 2000))
    let cached_input_tokens = ($index mod 1200)
    let output_tokens = (40 + ($index mod 600))
    let reasoning_output_tokens = ($index mod 300)
    let total_tokens = ($input_tokens + $output_tokens + $reasoning_output_tokens)
    let padding = (content_padding $padding_source (content_length ($index + $file_index)))
    $"{"timestamp":"2026-01-($day)T($hour):($minute):00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"model":"($model)","last_token_usage":{"input_tokens":($input_tokens),"cached_input_tokens":($cached_input_tokens),"output_tokens":($output_tokens),"reasoning_output_tokens":($reasoning_output_tokens),"total_tokens":($total_tokens)},"total_token_usage":{"input_tokens":($input_tokens),"cached_input_tokens":($cached_input_tokens),"output_tokens":($output_tokens),"reasoning_output_tokens":($reasoning_output_tokens),"total_tokens":($total_tokens)}},"content":"($padding)"}}\n"
}
def generate_claude_fixture [output_dir: string, size_mib: int, padding_source: string] {
    assert_safe_deletion_target $output_dir '--output-dir'
    let target_bytes = ($size_mib * 1024 * 1024)
    let file_size_targets = (create_file_size_targets $target_bytes)
    rm -rf $output_dir
    mut total_bytes = 0
    mut line_index = 0
    mut file_count = 0
    for file_index in 0..<($file_size_targets | length) {
        let target_size = ($file_size_targets | get (shuffled_index $file_index ($file_size_targets | length)))
        let project_dir = ([
            $output_dir
            projects
            $"project-(($file_index mod 128 | into string | fill --alignment right --character '0' --width 3))"
        ] | path join)
        mkdir $project_dir
        let session_id = $"session-($file_index | into string | fill --alignment right --character '0' --width 6)"
        let output_file = ([
            $project_dir
            $"($session_id).jsonl"
        ] | path join)
        mut file_bytes = 0
        mut next_flush_at = $flush_interval_bytes
        while $file_bytes < $target_size {
            mut chunk = ''
            for _ in 0..<$chunk_line_count {
                if ($file_bytes + ($chunk | str length)) >= $target_size {
                    break
                }
                $chunk = ($chunk + (create_usage_line $line_index $file_index $session_id $padding_source))
                $line_index = ($line_index + 1)
            }
            $chunk | save --append $output_file
            let chunk_bytes = ($chunk | str length)
            $file_bytes = ($file_bytes + $chunk_bytes)
            $total_bytes = ($total_bytes + $chunk_bytes)
            if $file_bytes >= $next_flush_at {
                $next_flush_at = ($next_flush_at + $flush_interval_bytes)
            }
        }
        $file_count = ($file_count + 1)
    }
    {
        file_count: $file_count
        line_count: $line_index
        total_bytes: $total_bytes
    }
}
def generate_codex_fixture [output_dir: string, size_mib: int, padding_source: string] {
    assert_safe_deletion_target $output_dir '--codex-output-dir'
    let target_bytes = ($size_mib * 1024 * 1024)
    let file_size_targets = (create_file_size_targets $target_bytes)
    rm -rf $output_dir
    mut total_bytes = 0
    mut line_index = 0
    mut file_count = 0
    for file_index in 0..<($file_size_targets | length) {
        let target_size = ($file_size_targets | get (shuffled_index $file_index ($file_size_targets | length)))
        let session_dir = ([
            $output_dir
            sessions
            $"project-(($file_index mod 128 | into string | fill --alignment right --character '0' --width 3))"
        ] | path join)
        mkdir $session_dir
        let output_file = ([
            $session_dir
            $"session-($file_index | into string | fill --alignment right --character '0' --width 6).jsonl"
        ] | path join)
        mut file_bytes = 0
        mut next_flush_at = $flush_interval_bytes
        while $file_bytes < $target_size {
            mut chunk = ''
            for _ in 0..<$chunk_line_count {
                if ($file_bytes + ($chunk | str length)) >= $target_size {
                    break
                }
                $chunk = ($chunk + (create_codex_usage_line $line_index $file_index $padding_source))
                $line_index = ($line_index + 1)
            }
            $chunk | save --append $output_file
            let chunk_bytes = ($chunk | str length)
            $file_bytes = ($file_bytes + $chunk_bytes)
            $total_bytes = ($total_bytes + $chunk_bytes)
            if $file_bytes >= $next_flush_at {
                $next_flush_at = ($next_flush_at + $flush_interval_bytes)
            }
        }
        $file_count = ($file_count + 1)
    }
    {
        file_count: $file_count
        line_count: $line_index
        total_bytes: $total_bytes
    }
}
def to_base36 [value: int] {
    if $value == 0 {
        return '0'
    }
    mut number = $value
    mut output = ''
    while $number > 0 {
        let remainder = ($number mod 36)
        let character = ($base36_chars | str substring $remainder..$remainder)
        $output = ($character + $output)
        $number = (($number / 36) | math floor)
    }
    $output
}
