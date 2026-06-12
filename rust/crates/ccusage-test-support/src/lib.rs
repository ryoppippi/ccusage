use std::{
    fs,
    path::{Path, PathBuf},
};

use assert_fs::{
    fixture::{ChildPath, FileWriteStr, PathChild, PathCreateDir},
    TempDir,
};

pub struct Fixture {
    dir: TempDir,
}

impl Fixture {
    pub fn new() -> Self {
        Self {
            dir: TempDir::new().expect("failed to create temporary fixture directory"),
        }
    }

    pub fn root(&self) -> &Path {
        self.dir.path()
    }

    #[must_use]
    pub fn path(&self, path: impl AsRef<Path>) -> PathBuf {
        self.dir.path().join(path)
    }

    pub fn child(&self, path: impl AsRef<Path>) -> ChildPath {
        self.dir.child(path)
    }

    #[must_use]
    pub fn write_file(&self, path: impl AsRef<Path>, contents: impl AsRef<str>) -> PathBuf {
        let child = self.child(path);
        if let Some(parent) = child.path().parent() {
            fs::create_dir_all(parent).expect("failed to create fixture file parent directory");
        }
        child
            .write_str(contents.as_ref())
            .expect("failed to write fixture file");
        child.path().to_path_buf()
    }

    #[must_use]
    pub fn create_dir_all(&self, path: impl AsRef<Path>) -> PathBuf {
        let child = self.child(path);
        child
            .create_dir_all()
            .expect("failed to create fixture directory");
        child.path().to_path_buf()
    }
}

impl Default for Fixture {
    fn default() -> Self {
        Self::new()
    }
}

#[macro_export]
macro_rules! fs_fixture {
    ({ $($path:literal : $contents:expr),* $(,)? }) => {{
        let fixture = $crate::Fixture::new();
        $(
            let _ = fixture.write_file($path, $contents);
        )*
        fixture
    }};
}

#[cfg(test)]
mod tests {
    #[test]
    fn creates_inline_fixture_tree() {
        let fixture = fs_fixture!({
            "projects/example/session.jsonl": "{}\n",
        });

        assert_eq!(
            std::fs::read_to_string(fixture.path("projects/example/session.jsonl")).unwrap(),
            "{}\n"
        );
    }

    #[test]
    fn creates_incremental_fixture_tree() {
        let fixture = fs_fixture!({});
        let _ = fixture.write_file("projects/example/session/chat.jsonl", "{}\n");

        assert!(fixture
            .path("projects/example/session/chat.jsonl")
            .is_file());
    }
}
