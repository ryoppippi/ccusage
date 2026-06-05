use std::{
    env, fs,
    io::{self, Read},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

use serde_json::{Map, Value};

const FLAKE_LOCK_JSON: &str = "../../../flake.lock";
const LITELLM_PRICING_JSON: &str = "model_prices_and_context_window.json";
const OUT_PRICING_JSON: &str = "litellm-pricing.json";
const PRICING_JSON_PATH_ENV: &str = "CCUSAGE_PRICING_JSON_PATH";
const PRICING_FETCH_MAX_BYTES: usize = 64 * 1024 * 1024;
const GIT_COMMAND_TIMEOUT_SECONDS: u64 = 60;
const GIT_COMMAND_TIMEOUT_SECONDS_TEXT: &str = "60";

fn main() {
    println!("cargo:rerun-if-env-changed={PRICING_JSON_PATH_ENV}");

    let out_path = out_dir_path(OUT_PRICING_JSON);
    let pricing_json = if let Some(path) = env::var_os(PRICING_JSON_PATH_ENV) {
        let path = PathBuf::from(path);
        println!("cargo:rerun-if-changed={}", path.display());
        fs::read_to_string(path).expect("read pricing snapshot from CCUSAGE_PRICING_JSON_PATH")
    } else {
        println!("cargo:rerun-if-changed={FLAKE_LOCK_JSON}");
        fetch_pricing_json().expect("fetch LiteLLM pricing for embed")
    };
    let pricing_json = compact_pricing_json(&pricing_json).expect("compact LiteLLM pricing JSON");

    fs::write(out_path, pricing_json).expect("write build-time pricing snapshot");
}

fn out_dir_path(file_name: &str) -> PathBuf {
    PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set by cargo")).join(file_name)
}

fn fetch_pricing_json() -> std::io::Result<String> {
    let locked = litellm_lock()?;
    let repo_url = github_repo_url(&locked.owner, &locked.repo);
    let fetch_dir = out_dir_path("litellm-pricing-git");
    let _ = fs::remove_dir_all(&fetch_dir);
    fs::create_dir_all(&fetch_dir)?;
    let _cleanup = RemoveDirOnDrop(fetch_dir.clone());

    run_git(&fetch_dir, ["init", "--quiet"])?;
    run_git(&fetch_dir, ["remote", "add", "origin", &repo_url])?;
    run_git(
        &fetch_dir,
        [
            "-c",
            "advice.detachedHead=false",
            "fetch",
            "--depth",
            "1",
            "origin",
            &locked.rev,
        ],
    )?;

    let object_path = git_object_path();
    let output = git_output(&fetch_dir, ["show", object_path.as_str()])?;
    if !output.status.success() {
        return Err(std::io::Error::other(command_error_message(&output)));
    }
    if output.stdout.len() > PRICING_FETCH_MAX_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "response exceeded pricing fetch size limit",
        ));
    }
    String::from_utf8(output.stdout)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error.to_string()))
}

fn run_git<const N: usize>(current_dir: &Path, args: [&str; N]) -> std::io::Result<()> {
    let output = git_output(current_dir, args)?;
    if output.status.success() {
        Ok(())
    } else {
        Err(std::io::Error::other(command_error_message(&output)))
    }
}

fn git_output<const N: usize>(current_dir: &Path, args: [&str; N]) -> std::io::Result<Output> {
    let mut command = Command::new("git");
    command
        .current_dir(current_dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .args(args);
    command_output_with_timeout(
        command,
        Duration::from_secs(GIT_COMMAND_TIMEOUT_SECONDS),
        git_timeout_message(&args),
    )
}

fn command_output_with_timeout(
    mut command: Command,
    timeout: Duration,
    timeout_message: String,
) -> io::Result<Output> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("capture git stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("capture git stderr"))?;
    let stdout_reader = thread::spawn(move || read_to_end_limited(stdout, PRICING_FETCH_MAX_BYTES));
    let stderr_reader = thread::spawn(move || read_to_end_limited(stderr, PRICING_FETCH_MAX_BYTES));
    let started_at = Instant::now();

    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Output {
                status,
                stdout: join_reader(stdout_reader)?,
                stderr: join_reader(stderr_reader)?,
            });
        }
        if started_at.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            let _ = join_reader(stdout_reader);
            let _ = join_reader(stderr_reader);
            return Err(io::Error::new(io::ErrorKind::TimedOut, timeout_message));
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn read_to_end_limited(mut reader: impl Read, max_bytes: usize) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            return Ok(bytes);
        }
        if bytes.len().saturating_add(read) > max_bytes {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "git output exceeded pricing fetch size limit",
            ));
        }
        bytes.extend_from_slice(&buffer[..read]);
    }
}

fn join_reader(handle: thread::JoinHandle<io::Result<Vec<u8>>>) -> io::Result<Vec<u8>> {
    handle
        .join()
        .map_err(|_| io::Error::other("read git output"))?
}

fn git_timeout_message(args: &[&str]) -> String {
    let mut message = String::from("git command timed out after ");
    message.push_str(GIT_COMMAND_TIMEOUT_SECONDS_TEXT);
    message.push_str(" seconds:");
    for arg in args {
        message.push(' ');
        message.push_str(arg);
    }
    message
}

fn command_error_message(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let message = stderr.trim();
    if message.is_empty() {
        "command exited without stderr".to_string()
    } else {
        message.to_string()
    }
}

struct RemoveDirOnDrop(PathBuf);

impl Drop for RemoveDirOnDrop {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct LiteLlmLock {
    owner: String,
    repo: String,
    rev: String,
}

fn litellm_lock() -> std::io::Result<LiteLlmLock> {
    let flake_lock = fs::read_to_string(FLAKE_LOCK_JSON)?;
    let Value::Object(root) = serde_json::from_str::<Value>(&flake_lock)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error.to_string()))?
    else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "flake.lock must be a JSON object",
        ));
    };
    let locked = root
        .get("nodes")
        .and_then(|nodes| nodes.get("litellm"))
        .and_then(|litellm| litellm.get("locked"))
        .and_then(Value::as_object)
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "flake.lock is missing nodes.litellm.locked",
            )
        })?;
    let owner = required_flake_lock_string_field(locked, "owner")?;
    let repo = required_flake_lock_string_field(locked, "repo")?;
    let rev = required_flake_lock_string_field(locked, "rev")?;

    Ok(LiteLlmLock { owner, repo, rev })
}

fn github_repo_url(owner: &str, repo: &str) -> String {
    let mut url = String::with_capacity(
        "https://github.com/".len() + owner.len() + 1 + repo.len() + ".git".len(),
    );
    url.push_str("https://github.com/");
    url.push_str(owner);
    url.push('/');
    url.push_str(repo);
    url.push_str(".git");
    url
}

fn git_object_path() -> String {
    let mut path = String::with_capacity("FETCH_HEAD:".len() + LITELLM_PRICING_JSON.len());
    path.push_str("FETCH_HEAD:");
    path.push_str(LITELLM_PRICING_JSON);
    path
}

fn required_flake_lock_string_field(
    object: &Map<String, Value>,
    field: &str,
) -> std::io::Result<String> {
    object
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            let mut message =
                String::with_capacity("flake.lock nodes.litellm.locked.".len() + field.len() + 17);
            message.push_str("flake.lock nodes.litellm.locked.");
            message.push_str(field);
            message.push_str(" must be a string");
            std::io::Error::new(std::io::ErrorKind::InvalidData, message)
        })
}

fn compact_pricing_json(json: &str) -> Option<String> {
    let Value::Object(raw) = serde_json::from_str::<Value>(json).ok()? else {
        return None;
    };
    let mut compact = Map::new();
    for (model, pricing) in raw {
        if !is_embedded_model(&model) {
            continue;
        }
        let Value::Object(pricing) = pricing else {
            continue;
        };
        let mut fields = Map::new();
        for field in [
            "input_cost_per_token",
            "output_cost_per_token",
            "cache_creation_input_token_cost",
            "cache_read_input_token_cost",
            "input_cost_per_token_above_200k_tokens",
            "output_cost_per_token_above_200k_tokens",
            "cache_creation_input_token_cost_above_200k_tokens",
            "cache_read_input_token_cost_above_200k_tokens",
            "max_input_tokens",
            "provider_specific_entry",
        ] {
            let Some(value) = pricing.get(field) else {
                continue;
            };
            if !value.is_null() {
                fields.insert(field.to_string(), value.clone());
            }
        }
        if fields.contains_key("input_cost_per_token")
            && fields.contains_key("output_cost_per_token")
        {
            compact.insert(model, Value::Object(fields));
        }
    }
    serde_json::to_string(&Value::Object(compact)).ok()
}

fn is_embedded_model(model: &str) -> bool {
    model.starts_with("claude-")
        || model.starts_with("anthropic.")
        || model.starts_with("anthropic/")
        || model.starts_with("us.anthropic.")
        || model.starts_with("eu.anthropic.")
        || model.starts_with("global.anthropic.")
        || model.starts_with("jp.anthropic.")
        || model.starts_with("au.anthropic.")
        || model.starts_with("gpt-")
        || model.starts_with("openai/")
        || model.starts_with("azure/")
        || model.starts_with("openrouter/openai/")
}
